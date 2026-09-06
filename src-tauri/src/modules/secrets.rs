//! Secret storage with platform-appropriate backends.
//!
//! - macOS: macOS Keychain (via `keyring` crate)
//! - Windows: Credential Manager (via `keyring` crate)
//! - Linux: a file in the app's local data dir, mode 0600. The default
//!   `keyring` backend on Linux is the Secret Service over D-Bus, which
//!   silently fails on systems without gnome-keyring/kwallet (and on the
//!   "login" collection not being created). For an open-source desktop
//!   app shipped via AppImage/deb/rpm, we cannot assume a keyring daemon
//!   exists. The file backend is the same approach Brave/Chromium fall
//!   back to in that scenario; user-only file permissions provide the
//!   isolation the secret-service collection would have otherwise.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! and `secrets_get_all` — no platform branching in JS.
//!
//! All commands take `&AppHandle` so we can resolve the data directory
//! once via Tauri's path API.

use std::sync::Mutex;

use tauri::AppHandle;

use crate::modules::channel;

/// Service name a stable build stores every secret under.
pub const STABLE_SERVICE: &str = "terax-ai";
/// Service name a preview build stores every secret under. Deliberately
/// unrelated to [`STABLE_SERVICE`] so the two never collide in the OS keychain.
pub const PREVIEW_SERVICE: &str = "terax-ssh-preview";

/// Maps a service name requested by the webview onto this build's namespace.
///
/// A preview is a separate, unofficial application that happens to share a user
/// account with a stable install, so it must never read, write or delete that
/// install's credentials. The decision is made here, at the IPC boundary,
/// rather than trusted from the frontend: a webview asking for `terax-ai` is
/// stating a request, not holding a permission.
///
/// Total by construction rather than an allow-list, so a future secret helper
/// that picks its own service name is namespaced too instead of silently
/// escaping into the stable keychain.
pub fn scope_service(requested: &str, preview: bool) -> String {
    if !preview {
        return requested.to_string();
    }
    if requested == STABLE_SERVICE {
        return PREVIEW_SERVICE.to_string();
    }
    format!("{PREVIEW_SERVICE}.{requested}")
}

fn service_for_build(requested: &str) -> String {
    scope_service(requested, channel::is_preview())
}

/// Credential isolation between a stable install and a preview install. These
/// run on every platform because the invariant is about the service name, not
/// about which backend stores it.
#[cfg(test)]
mod scope_tests {
    use super::*;
    use proptest::prelude::*;

    /// Every service name the app is known to ask for, plus the awkward ones.
    const SAMPLES: &[&str] = &[
        STABLE_SERVICE,
        PREVIEW_SERVICE,
        "",
        " ",
        "terax",
        "terax-ai-extra",
        "TERAX-AI",
        "terax-ai/../terax-ai",
        "terax::ai",
    ];

    #[test]
    fn stable_service_name_is_unchanged() {
        assert_eq!(STABLE_SERVICE, "terax-ai");
        for raw in SAMPLES {
            assert_eq!(
                scope_service(raw, false),
                *raw,
                "stable must not rewrite {raw:?}"
            );
        }
    }

    #[test]
    fn preview_uses_its_own_service_name() {
        assert_eq!(PREVIEW_SERVICE, "terax-ssh-preview");
        assert_ne!(STABLE_SERVICE, PREVIEW_SERVICE);
        assert_eq!(scope_service(STABLE_SERVICE, true), PREVIEW_SERVICE);
    }

    #[test]
    fn preview_never_resolves_to_the_stable_service() {
        for raw in SAMPLES {
            let scoped = scope_service(raw, true);
            assert_ne!(
                scoped, STABLE_SERVICE,
                "preview reached the stable keychain via {raw:?}"
            );
        }
    }

    #[test]
    fn preview_namespaces_an_unknown_service_rather_than_passing_it_through() {
        assert_eq!(
            scope_service("some-future-helper", true),
            "terax-ssh-preview.some-future-helper"
        );
    }

    proptest! {
        /// The load-bearing property: whatever the webview asks for, a preview
        /// build and a stable build never address the same credential.
        #[test]
        fn preview_and_stable_never_agree(raw in r".{0,64}") {
            prop_assert_ne!(scope_service(&raw, true), scope_service(&raw, false));
        }

        #[test]
        fn preview_never_yields_the_stable_service(raw in r".{0,64}") {
            prop_assert_ne!(scope_service(&raw, true), STABLE_SERVICE.to_string());
        }

        #[test]
        fn stable_is_the_identity(raw in r".{0,64}") {
            prop_assert_eq!(scope_service(&raw, false), raw);
        }
    }

    #[test]
    fn compiled_build_resolves_through_its_own_channel() {
        let expected = if channel::is_preview() {
            PREVIEW_SERVICE
        } else {
            STABLE_SERVICE
        };
        assert_eq!(service_for_build(STABLE_SERVICE), expected);
    }
}

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[derive(Default)]
pub struct SecretsState {
    #[cfg(target_os = "linux")]
    cache: Mutex<Option<HashMap<String, String>>>,
    #[cfg(not(target_os = "linux"))]
    _phantom: Mutex<()>,
}

#[cfg(target_os = "linux")]
pub(crate) fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "linux")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    read_store_at(&store_path(app)?)
}

#[cfg(target_os = "linux")]
pub(crate) fn read_store_at(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    write_store_at(&store_path(app)?, map)
}

#[cfg(target_os = "linux")]
pub(crate) fn write_store_at(
    path: &std::path::Path,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn with_store<F, R>(app: &AppHandle, state: &SecretsState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut HashMap<String, String>) -> R,
{
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(app)?);
    }
    let map = guard.as_mut().expect("cache initialized above");
    Ok(f(map))
}

#[cfg(not(target_os = "linux"))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    // Shadowed immediately so the raw, webview-supplied name is unreachable
    // below: every backend path uses this build's namespace or none at all.
    let service = service_for_build(&service);
    #[cfg(target_os = "linux")]
    {
        let _ = state; // capture
        let key = key(&service, &account);
        with_store(&app, &state, |m| m.get(&key).cloned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    // Shadowed immediately so the raw, webview-supplied name is unreachable
    // below: every backend path uses this build's namespace or none at all.
    let service = service_for_build(&service);
    #[cfg(target_os = "linux")]
    {
        let key = key(&service, &account);
        with_store(&app, &state, |m| {
            m.insert(key, password);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        e.set_password(&password).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    // Shadowed immediately so the raw, webview-supplied name is unreachable
    // below: every backend path uses this build's namespace or none at all.
    let service = service_for_build(&service);
    #[cfg(target_os = "linux")]
    {
        let key = key(&service, &account);
        with_store(&app, &state, |m| {
            m.remove(&key);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use tempfile::TempDir;

    #[test]
    fn key_format_is_service_double_colon_account() {
        assert_eq!(key("openai", "alice"), "openai::alice");
        assert_eq!(key("", ""), "::");
    }

    #[test]
    fn read_store_at_missing_path_is_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.json");
        let map = read_store_at(&p).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        let mut m = HashMap::new();
        m.insert(key("svc", "alice"), "p1".into());
        m.insert(key("svc", "bob"), "p2".into());

        write_store_at(&p, &m).unwrap();
        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, m);
    }

    #[test]
    fn write_uses_mode_0600() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let mode = fs::metadata(&p).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets file must be user-only readable");
    }

    #[test]
    fn write_does_not_leave_tmp_file_on_success() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let tmp_path = p.with_extension("json.tmp");
        assert!(!tmp_path.exists(), "tmp file must be renamed away on success");
    }

    #[test]
    fn write_overwrites_existing_atomically() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");

        let mut first = HashMap::new();
        first.insert("a".into(), "1".into());
        write_store_at(&p, &first).unwrap();

        let mut second = HashMap::new();
        second.insert("b".into(), "2".into());
        write_store_at(&p, &second).unwrap();

        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, second);
        assert!(!loaded.contains_key("a"));
    }

    #[test]
    fn read_store_at_garbage_file_errors() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        fs::write(&p, b"not json").unwrap();
        assert!(read_store_at(&p).is_err());
    }
}

/// Batch read — single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    // Shadowed immediately so the raw, webview-supplied name is unreachable
    // below: every backend path uses this build's namespace or none at all.
    let service = service_for_build(&service);
    #[cfg(target_os = "linux")]
    {
        with_store(&app, &state, |m| {
            accounts
                .iter()
                .map(|a| m.get(&key(&service, a)).cloned())
                .collect()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        Ok(accounts
            .into_iter()
            .map(|a| {
                keyring::Entry::new(&service, &a)
                    .ok()
                    .and_then(|e| e.get_password().ok())
            })
            .collect())
    }
}
