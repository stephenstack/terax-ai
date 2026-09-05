//! Pure resolution and validation of an SSH connection request.
//!
//! Everything the connect path needs to decide before a socket exists lives
//! here so it stays testable without a server: address validation, auth method
//! ordering, and terminal sizing.

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 22;
pub const DEFAULT_TERM: &str = "xterm-256color";

/// Sizing floor. A zero dimension makes the remote `TIOCSWINSZ` meaningless and
/// makes full-screen TUIs (vim, htop) draw into a degenerate grid.
pub const MIN_COLS: u16 = 1;
pub const MIN_ROWS: u16 = 1;
pub const MAX_COLS: u16 = 10_000;
pub const MAX_ROWS: u16 = 10_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub user: String,
    #[serde(default)]
    pub auth: Vec<AuthMethod>,
    #[serde(default)]
    pub term: Option<String>,
    /// Directory to `cd` into once the shell is live. Remote path, sent as a
    /// shell command, so it is quoted at the boundary.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Command to run instead of the login shell.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub keepalive_secs: Option<u32>,
    #[serde(default)]
    pub connect_timeout_secs: Option<u32>,
    #[serde(default)]
    pub compression: Option<bool>,
    /// Environment variables to request before the shell starts. Servers
    /// usually refuse anything outside `AcceptEnv`, which is not an error.
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthMethod {
    /// Keys held by a running ssh-agent, in the agent's own order.
    Agent,
    /// A private key file on disk. `passphrase` is absent until the user is
    /// prompted, so an encrypted key resolves lazily.
    KeyFile {
        path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
    Password {
        #[serde(default)]
        password: Option<String>,
    },
    KeyboardInteractive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyGeometry {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub addr: String,
    pub term: String,
    pub methods: Vec<AuthMethod>,
    pub keepalive_secs: Option<u32>,
    pub connect_timeout_secs: u32,
    pub compression: bool,
}

pub const DEFAULT_CONNECT_TIMEOUT_SECS: u32 = 20;
/// Bounded so a typo cannot park a connect attempt for the session's lifetime.
pub const MAX_CONNECT_TIMEOUT_SECS: u32 = 300;

/// Clamp rather than reject: a resize race can hand us a transient 0 while the
/// pane is being laid out, and dropping the session over it would be hostile.
pub fn clamp_geometry(cols: u16, rows: u16) -> PtyGeometry {
    PtyGeometry {
        cols: cols.clamp(MIN_COLS, MAX_COLS),
        rows: rows.clamp(MIN_ROWS, MAX_ROWS),
    }
}

/// Reject anything that is not a bare host or literal IP. A hostname carrying
/// a scheme, credentials, whitespace, or a control byte is either a mistake or
/// an attempt to smuggle a second field past the connect call.
fn validate_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host is required".to_owned());
    }
    if host.len() > 255 {
        return Err("host is too long".to_owned());
    }
    if host.contains("://") {
        return Err("host must not include a scheme".to_owned());
    }
    if host.contains('@') {
        return Err("host must not include a user; set the user field".to_owned());
    }
    if host
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '\\')
    {
        return Err("host contains invalid characters".to_owned());
    }
    Ok(host.to_owned())
}

fn validate_user(user: &str) -> Result<String, String> {
    let user = user.trim();
    if user.is_empty() {
        return Err("user is required".to_owned());
    }
    if user.len() > 255 {
        return Err("user is too long".to_owned());
    }
    if user.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("user contains invalid characters".to_owned());
    }
    Ok(user.to_owned())
}

/// A `TERM` value reaches the remote environment verbatim; keep it to the
/// shape terminfo names actually take.
fn validate_term(term: Option<&str>) -> Result<String, String> {
    let Some(term) = term.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(DEFAULT_TERM.to_owned());
    };
    if term.len() > 64 {
        return Err("term is too long".to_owned());
    }
    if !term
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
    {
        return Err("term contains invalid characters".to_owned());
    }
    Ok(term.to_owned())
}

/// Format a host:port pair for `ToSocketAddrs`, bracketing IPv6 literals.
pub fn socket_addr(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

pub fn resolve_target(target: &SshTarget) -> Result<ResolvedTarget, String> {
    let host = validate_host(&target.host)?;
    let user = validate_user(&target.user)?;
    let term = validate_term(target.term.as_deref())?;
    let port = match target.port {
        Some(0) | None => DEFAULT_PORT,
        Some(p) => p,
    };

    let mut methods = target.auth.clone();
    if methods.is_empty() {
        // Mirrors ssh's own default preference order.
        methods = vec![
            AuthMethod::Agent,
            AuthMethod::Password { password: None },
            AuthMethod::KeyboardInteractive,
        ];
    }

    let connect_timeout_secs = target
        .connect_timeout_secs
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_CONNECT_TIMEOUT_SECS)
        .min(MAX_CONNECT_TIMEOUT_SECS);

    Ok(ResolvedTarget {
        addr: socket_addr(&host, port),
        host,
        port,
        user,
        term,
        methods,
        keepalive_secs: target.keepalive_secs.filter(|s| *s > 0),
        connect_timeout_secs,
        compression: target.compression.unwrap_or(false),
    })
}

/// Single-quote a remote path for a POSIX shell. The remote side is not
/// necessarily POSIX, but `cd` into an unquoted path with a space is broken
/// everywhere, and embedded quotes are the injection vector that matters.
pub fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The bootstrap line sent once the shell is interactive. Returns `None` when
/// there is nothing to do, so the caller never writes a bare newline into a
/// fresh prompt.
pub fn startup_command(cwd: Option<&str>, command: Option<&str>) -> Option<String> {
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty());
    let command = command.map(str::trim).filter(|s| !s.is_empty());
    match (cwd, command) {
        (None, None) => None,
        (Some(cwd), None) => Some(format!("cd {}\n", quote_posix(cwd))),
        (None, Some(cmd)) => Some(format!("{cmd}\n")),
        (Some(cwd), Some(cmd)) => Some(format!("cd {} && {}\n", quote_posix(cwd), cmd)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, user: &str) -> SshTarget {
        SshTarget {
            host: host.to_owned(),
            port: None,
            user: user.to_owned(),
            auth: Vec::new(),
            term: None,
            cwd: None,
            command: None,
            keepalive_secs: None,
            connect_timeout_secs: None,
            compression: None,
            env: Vec::new(),
        }
    }

    #[test]
    fn defaults_port_to_22() {
        let r = resolve_target(&target("example.com", "me")).unwrap();
        assert_eq!(r.port, 22);
        assert_eq!(r.addr, "example.com:22");
    }

    #[test]
    fn treats_port_zero_as_unset() {
        let mut t = target("example.com", "me");
        t.port = Some(0);
        assert_eq!(resolve_target(&t).unwrap().port, 22);
    }

    #[test]
    fn brackets_ipv6_literals() {
        let r = resolve_target(&target("::1", "me")).unwrap();
        assert_eq!(r.addr, "[::1]:22");
    }

    #[test]
    fn does_not_double_bracket_ipv6() {
        assert_eq!(socket_addr("[::1]", 22), "[::1]:22");
    }

    #[test]
    fn rejects_scheme_in_host() {
        assert!(resolve_target(&target("ssh://example.com", "me")).is_err());
    }

    #[test]
    fn rejects_user_smuggled_into_host() {
        let err = resolve_target(&target("root@example.com", "me")).unwrap_err();
        assert!(err.contains("user"), "{err}");
    }

    #[test]
    fn rejects_whitespace_and_control_bytes_in_host() {
        assert!(resolve_target(&target("exa mple.com", "me")).is_err());
        assert!(resolve_target(&target("example.com\n-oProxyCommand=x", "me")).is_err());
    }

    #[test]
    fn rejects_empty_host_and_user() {
        assert!(resolve_target(&target("   ", "me")).is_err());
        assert!(resolve_target(&target("example.com", "  ")).is_err());
    }

    #[test]
    fn rejects_control_bytes_in_user() {
        assert!(resolve_target(&target("example.com", "ro\not")).is_err());
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let r = resolve_target(&target("  example.com  ", " me ")).unwrap();
        assert_eq!(r.host, "example.com");
        assert_eq!(r.user, "me");
    }

    #[test]
    fn defaults_term_and_rejects_junk() {
        assert_eq!(
            resolve_target(&target("h", "u")).unwrap().term,
            DEFAULT_TERM
        );
        let mut t = target("h", "u");
        t.term = Some("xterm-256color".to_owned());
        assert_eq!(resolve_target(&t).unwrap().term, "xterm-256color");
        t.term = Some("bad term; rm -rf".to_owned());
        assert!(resolve_target(&t).is_err());
    }

    #[test]
    fn empty_auth_list_falls_back_to_ssh_default_order() {
        let r = resolve_target(&target("h", "u")).unwrap();
        assert_eq!(r.methods.first(), Some(&AuthMethod::Agent));
        assert_eq!(r.methods.len(), 3);
    }

    #[test]
    fn explicit_auth_order_is_preserved() {
        let mut t = target("h", "u");
        t.auth = vec![AuthMethod::Password { password: None }, AuthMethod::Agent];
        let r = resolve_target(&t).unwrap();
        assert_eq!(r.methods[0], AuthMethod::Password { password: None });
        assert_eq!(r.methods[1], AuthMethod::Agent);
    }

    #[test]
    fn connect_timeout_is_defaulted_and_bounded() {
        let mut t = target("h", "u");
        assert_eq!(
            resolve_target(&t).unwrap().connect_timeout_secs,
            DEFAULT_CONNECT_TIMEOUT_SECS
        );
        t.connect_timeout_secs = Some(0);
        assert_eq!(
            resolve_target(&t).unwrap().connect_timeout_secs,
            DEFAULT_CONNECT_TIMEOUT_SECS
        );
        t.connect_timeout_secs = Some(99_999);
        assert_eq!(
            resolve_target(&t).unwrap().connect_timeout_secs,
            MAX_CONNECT_TIMEOUT_SECS
        );
    }

    #[test]
    fn zero_keepalive_is_treated_as_off() {
        let mut t = target("h", "u");
        t.keepalive_secs = Some(0);
        assert_eq!(resolve_target(&t).unwrap().keepalive_secs, None);
    }

    #[test]
    fn clamps_degenerate_geometry() {
        assert_eq!(clamp_geometry(0, 0), PtyGeometry { cols: 1, rows: 1 });
        assert_eq!(
            clamp_geometry(u16::MAX, u16::MAX),
            PtyGeometry {
                cols: MAX_COLS,
                rows: MAX_ROWS
            }
        );
        assert_eq!(clamp_geometry(80, 24), PtyGeometry { cols: 80, rows: 24 });
    }

    #[test]
    fn quotes_paths_with_spaces_and_quotes() {
        assert_eq!(quote_posix("/srv/my app"), "'/srv/my app'");
        assert_eq!(quote_posix("/srv/it's"), r"'/srv/it'\''s'");
    }

    #[test]
    fn quoting_neutralizes_command_substitution() {
        let q = quote_posix("/tmp/$(touch pwned)");
        assert_eq!(q, "'/tmp/$(touch pwned)'");
        assert!(
            !q.contains("'$("),
            "the payload must stay inside the quotes"
        );
    }

    #[test]
    fn startup_command_covers_each_combination() {
        assert_eq!(startup_command(None, None), None);
        assert_eq!(startup_command(Some("  "), None), None);
        assert_eq!(startup_command(Some("/srv"), None).unwrap(), "cd '/srv'\n");
        assert_eq!(startup_command(None, Some("htop")).unwrap(), "htop\n");
        assert_eq!(
            startup_command(Some("/srv"), Some("htop")).unwrap(),
            "cd '/srv' && htop\n"
        );
    }
}
