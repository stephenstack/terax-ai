//! Pure remote-path handling.
//!
//! A remote path is always POSIX, whatever the local OS is, so `std::path`
//! must not touch it: on Windows it would rewrite separators and reinterpret
//! a leading `/`. Everything here is plain string work.

/// Expand a leading `~`, the only place a tilde is a home reference.
pub fn expand_home(path: &str, home: &str) -> String {
    let home = home.trim_end_matches('/');
    if path == "~" {
        return home.to_owned();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => path.to_owned(),
    }
}

/// Collapse `.`, `..` and repeated slashes without asking the server.
///
/// This is containment arithmetic, not resolution: it deliberately does not
/// follow symlinks, so a caller must still treat the result as untrusted for
/// anything a symlink could redirect.
pub fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                // A `..` above the root has nowhere to go; POSIX keeps it at
                // the root rather than escaping.
                if matches!(out.last(), Some(&last) if last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_owned()
    } else {
        joined
    }
}

pub fn join(base: &str, name: &str) -> String {
    if name.starts_with('/') {
        return normalize(name);
    }
    let base = base.trim_end_matches('/');
    normalize(&format!("{base}/{name}"))
}

pub fn parent(path: &str) -> Option<String> {
    let normalized = normalize(path);
    if normalized == "/" {
        return None;
    }
    match normalized.rfind('/') {
        Some(0) => Some("/".to_owned()),
        Some(i) => Some(normalized[..i].to_owned()),
        None => None,
    }
}

pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

/// True when `path` is `root` or sits under it. Both sides are normalized
/// first so `..` cannot be used to claim containment.
pub fn is_within(root: &str, path: &str) -> bool {
    let root = normalize(root);
    let path = normalize(path);
    if root == "/" {
        return path.starts_with('/');
    }
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

/// Single-quote for a POSIX shell, for paths spliced into an exec command.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_only_a_leading_tilde() {
        assert_eq!(expand_home("~", "/home/me"), "/home/me");
        assert_eq!(expand_home("~/src", "/home/me"), "/home/me/src");
        assert_eq!(expand_home("/etc/~/x", "/home/me"), "/etc/~/x");
        assert_eq!(expand_home("~user/src", "/home/me"), "~user/src");
    }

    #[test]
    fn tolerates_a_trailing_slash_on_home() {
        assert_eq!(expand_home("~/src", "/home/me/"), "/home/me/src");
    }

    #[test]
    fn normalizes_dot_and_double_dot() {
        assert_eq!(normalize("/a/./b"), "/a/b");
        assert_eq!(normalize("/a/b/../c"), "/a/c");
        assert_eq!(normalize("/a//b///c"), "/a/b/c");
        assert_eq!(normalize("/a/b/"), "/a/b");
    }

    #[test]
    fn keeps_double_dot_at_the_root() {
        assert_eq!(normalize("/../.."), "/");
        assert_eq!(normalize("/a/../../.."), "/");
    }

    #[test]
    fn keeps_leading_double_dot_on_a_relative_path() {
        assert_eq!(normalize("../a"), "../a");
        assert_eq!(normalize("../../a"), "../../a");
        assert_eq!(normalize("a/../../b"), "../b");
    }

    #[test]
    fn normalizes_the_root_and_empty_cases() {
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize(""), ".");
        assert_eq!(normalize("."), ".");
    }

    #[test]
    fn joins_relative_and_absolute_names() {
        assert_eq!(join("/srv", "app"), "/srv/app");
        assert_eq!(join("/srv/", "app"), "/srv/app");
        assert_eq!(join("/srv", "/etc/passwd"), "/etc/passwd");
        assert_eq!(join("/srv/app", "../other"), "/srv/other");
    }

    #[test]
    fn finds_the_parent() {
        assert_eq!(parent("/a/b/c").as_deref(), Some("/a/b"));
        assert_eq!(parent("/a").as_deref(), Some("/"));
        assert_eq!(parent("/"), None);
    }

    #[test]
    fn finds_the_basename() {
        assert_eq!(basename("/a/b/c"), "c");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(basename("solo"), "solo");
    }

    #[test]
    fn containment_accepts_the_root_itself_and_its_children() {
        assert!(is_within("/srv/app", "/srv/app"));
        assert!(is_within("/srv/app", "/srv/app/src/main.rs"));
        assert!(is_within("/", "/anything"));
    }

    #[test]
    fn containment_rejects_siblings_and_prefixes() {
        assert!(!is_within("/srv/app", "/srv/application"));
        assert!(!is_within("/srv/app", "/srv"));
        assert!(!is_within("/srv/app", "/etc/passwd"));
    }

    #[test]
    fn containment_cannot_be_defeated_by_dot_dot() {
        assert!(!is_within("/srv/app", "/srv/app/../../etc/passwd"));
        assert!(is_within("/srv/app", "/srv/app/sub/../other"));
    }

    #[test]
    fn quoting_neutralizes_shell_metacharacters() {
        assert_eq!(quote("/srv/my app"), "'/srv/my app'");
        assert_eq!(quote("/srv/it's"), r"'/srv/it'\''s'");
        assert_eq!(quote("/tmp/$(id)"), "'/tmp/$(id)'");
        assert_eq!(quote("a; rm -rf /"), "'a; rm -rf /'");
    }

    #[test]
    fn a_windows_style_path_is_left_alone() {
        // Remote paths are POSIX; a backslash is a legal filename character
        // there and must never be treated as a separator.
        assert_eq!(normalize("/srv/a\\b"), "/srv/a\\b");
        assert_eq!(basename("/srv/a\\b"), "a\\b");
    }
}
