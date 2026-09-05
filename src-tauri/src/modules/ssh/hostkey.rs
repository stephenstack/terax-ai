//! Host key verification against `known_hosts`.
//!
//! The parsing and matching itself is russh's (`russh::keys::known_hosts`),
//! which handles hashed hostnames, `[host]:port` syntax, and multi-key lines.
//! This module turns its two-value result plus error into the three states the
//! UI has to distinguish, and owns where the file lives.

use std::path::{Path, PathBuf};

use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::PublicKey;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyStatus {
    /// Recorded and matching. Connect without asking.
    Trusted,
    /// No entry for this host. Trust on first use, with a prompt.
    Unknown,
    /// An entry exists and the key does not match it. Never auto-accept.
    Changed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub status: HostKeyStatus,
    pub fingerprint: String,
    pub algorithm: String,
    /// Line number of the conflicting entry, for a `Changed` verdict.
    pub conflict_line: Option<usize>,
}

/// `~/.ssh/known_hosts`, via the `dirs` crate per project convention (russh's
/// own default uses `env::home_dir`, which we deliberately bypass).
pub fn default_known_hosts_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "could not determine home directory".to_owned())
}

/// OpenSSH's `SHA256:...` base64 form, which is what users compare against.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(Default::default()).to_string()
}

pub fn verify(host: &str, port: u16, key: &PublicKey, path: &Path) -> Result<HostKeyInfo, String> {
    let base = HostKeyInfo {
        status: HostKeyStatus::Unknown,
        fingerprint: fingerprint(key),
        algorithm: key.algorithm().to_string(),
        conflict_line: None,
    };
    match check_known_hosts_path(host, port, key, path) {
        Ok(true) => Ok(HostKeyInfo {
            status: HostKeyStatus::Trusted,
            ..base
        }),
        Ok(false) => Ok(base),
        Err(russh::keys::Error::KeyChanged { line }) => Ok(HostKeyInfo {
            status: HostKeyStatus::Changed,
            conflict_line: Some(line),
            ..base
        }),
        Err(e) => Err(format!("known_hosts check failed: {e}")),
    }
}

/// Append a host key. Creates `~/.ssh` at 0700 if missing, because writing a
/// world-readable ssh directory would be worse than not remembering the key.
pub fn learn(host: &str, port: u16, key: &PublicKey, path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    learn_known_hosts_path(host, port, key, path)
        .map_err(|e| format!("could not record host key: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::private::Ed25519Keypair;
    use russh::keys::PrivateKey;

    /// Seeded rather than random so a failure reproduces exactly.
    fn test_key(seed: u8) -> PublicKey {
        let pair = Ed25519Keypair::from_seed(&[seed; 32]);
        PrivateKey::from(pair).public_key().clone()
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = tempfile::tempdir().unwrap().keep();
        dir.join(name)
    }

    #[test]
    fn missing_file_reports_unknown_not_error() {
        let key = test_key(1);
        let path = temp_path("known_hosts");
        let info = verify("example.com", 22, &key, &path).unwrap();
        assert_eq!(info.status, HostKeyStatus::Unknown);
    }

    #[test]
    fn learned_key_is_trusted_on_the_next_check() {
        let key = test_key(1);
        let path = temp_path("known_hosts");
        learn("example.com", 22, &key, &path).unwrap();
        let info = verify("example.com", 22, &key, &path).unwrap();
        assert_eq!(info.status, HostKeyStatus::Trusted);
    }

    #[test]
    fn a_different_key_for_a_known_host_reports_changed() {
        let known = test_key(1);
        let impostor = test_key(2);
        let path = temp_path("known_hosts");
        learn("example.com", 22, &known, &path).unwrap();
        let info = verify("example.com", 22, &impostor, &path).unwrap();
        assert_eq!(
            info.status,
            HostKeyStatus::Changed,
            "a mismatched key must never be reported as merely unknown"
        );
        assert!(info.conflict_line.is_some());
    }

    #[test]
    fn nonstandard_ports_are_scoped_separately() {
        let key = test_key(1);
        let path = temp_path("known_hosts");
        learn("example.com", 2222, &key, &path).unwrap();
        assert_eq!(
            verify("example.com", 2222, &key, &path).unwrap().status,
            HostKeyStatus::Trusted
        );
        assert_eq!(
            verify("example.com", 22, &key, &path).unwrap().status,
            HostKeyStatus::Unknown,
            "port 22 and 2222 are distinct known_hosts entries"
        );
    }

    #[test]
    fn other_hosts_are_unaffected_by_a_learned_entry() {
        let key = test_key(1);
        let path = temp_path("known_hosts");
        learn("example.com", 22, &key, &path).unwrap();
        assert_eq!(
            verify("other.example.com", 22, &key, &path).unwrap().status,
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn learning_creates_a_missing_ssh_directory() {
        let key = test_key(1);
        let dir = tempfile::tempdir().unwrap().keep();
        let path = dir.join("nested").join("known_hosts");
        learn("example.com", 22, &key, &path).unwrap();
        assert!(path.exists());
        assert_eq!(
            verify("example.com", 22, &key, &path).unwrap().status,
            HostKeyStatus::Trusted
        );
    }

    #[test]
    fn fingerprint_uses_the_sha256_form_users_compare() {
        let key = test_key(1);
        let fp = fingerprint(&key);
        assert!(fp.starts_with("SHA256:"), "{fp}");
    }

    #[test]
    fn multiple_hosts_coexist_in_one_file() {
        let a = test_key(1);
        let b = test_key(2);
        let path = temp_path("known_hosts");
        learn("a.example", 22, &a, &path).unwrap();
        learn("b.example", 22, &b, &path).unwrap();
        assert_eq!(
            verify("a.example", 22, &a, &path).unwrap().status,
            HostKeyStatus::Trusted
        );
        assert_eq!(
            verify("b.example", 22, &b, &path).unwrap().status,
            HostKeyStatus::Trusted
        );
    }
}
