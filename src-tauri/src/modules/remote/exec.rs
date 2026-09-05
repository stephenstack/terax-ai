//! Search and listing on the remote side.
//!
//! Walking a tree over individual SFTP requests is unusably slow (one
//! round-trip per directory), so these hand the walk to `find` and `grep`,
//! which are already there.
//!
//! Strictly POSIX: a minimal server (BusyBox, an Alpine container) has neither
//! GNU `grep --exclude-dir` nor `-I`, and silently returns nothing when handed
//! them. Pruning therefore happens in `find`, and `-exec ... {} +` is used
//! instead of `xargs`, which needs a non-portable `-r` to avoid running on an
//! empty list.

use super::conn::RemoteConn;
use super::path;
use crate::modules::fs::grep::{GlobHit, GlobResponse, GrepHit, GrepResponse};
use crate::modules::fs::search::{ListFilesResult, SearchHit, SearchResult};

/// Directory names pruned unconditionally, matching the local walker.
const PRUNED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

fn prune_expr() -> String {
    let names: Vec<String> = PRUNED
        .iter()
        .map(|n| format!("-name {}", path::quote(n)))
        .collect();
    format!("\\( {} \\) -prune -o", names.join(" -o "))
}

/// Path relative to the search root, for display.
fn relative(root: &str, full: &str) -> String {
    let root = root.trim_end_matches('/');
    full.strip_prefix(root)
        .map(|r| r.trim_start_matches('/').to_owned())
        .unwrap_or_else(|| full.to_owned())
}

fn hidden_filter(show_hidden: bool) -> &'static str {
    // `find` has no "skip dotfiles" flag; a negated path test is the portable
    // way, and `!` is POSIX where `-not` is a GNU spelling.
    if show_hidden {
        ""
    } else {
        " ! -path '*/.*'"
    }
}

/// `find` evaluates left to right, and `-print` is an action that always
/// succeeds and prints. A test placed after it is still evaluated, but its
/// result is discarded, so the hidden filter has to come first or dotfiles are
/// listed regardless of the setting.
fn build_list_command(root: &str, depth: &str, show_hidden: bool, limit: usize) -> String {
    format!(
        "find {}{} {} -type f{} -print 2>/dev/null | head -n {}",
        path::quote(root),
        depth,
        prune_expr(),
        hidden_filter(show_hidden),
        limit + 1,
    )
}

fn build_search_command(root: &str, show_hidden: bool) -> String {
    format!(
        "find {} {} \\( -type f -o -type d \\){} -print 2>/dev/null | head -n 20000",
        path::quote(root),
        prune_expr(),
        hidden_filter(show_hidden),
    )
}

pub async fn list_files(
    conn: &RemoteConn,
    root: &str,
    limit: usize,
    max_depth: Option<usize>,
    show_hidden: bool,
) -> Result<ListFilesResult, String> {
    let depth = max_depth
        .map(|d| format!(" -maxdepth {d}"))
        .unwrap_or_default();
    // One extra result tells us the listing was cut short.
    let out = conn
        .exec(&build_list_command(root, &depth, show_hidden, limit))
        .await?;
    let text = out.stdout_text();
    let mut files: Vec<String> = text.lines().map(str::to_owned).collect();
    let truncated = files.len() > limit;
    files.truncate(limit);
    Ok(ListFilesResult { files, truncated })
}

pub async fn search(
    conn: &RemoteConn,
    root: &str,
    query: &str,
    limit: usize,
    show_hidden: bool,
) -> Result<SearchResult, String> {
    if query.trim().is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    // Name matching happens here rather than in a remote regex so the query is
    // never interpreted as a pattern by a program on the far side.
    let out = conn.exec(&build_search_command(root, show_hidden)).await?;
    let text = out.stdout_text();

    let needle = query.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut truncated = false;
    for line in text.lines() {
        if line == root {
            continue;
        }
        let name = path::basename(line);
        if !name.to_lowercase().contains(&needle) {
            continue;
        }
        if hits.len() >= limit {
            truncated = true;
            break;
        }
        hits.push(SearchHit {
            path: line.to_owned(),
            rel: relative(root, line),
            name: name.to_owned(),
            // `find -type d` would need a second pass to distinguish; a
            // trailing-slash test is not available, so ask for dirs directly.
            is_dir: false,
        });
    }

    // A second, cheap pass marks the directories among the hits.
    if !hits.is_empty() {
        let dirs = conn
            .exec(&format!(
                "find {} {} -type d -print 2>/dev/null | head -n 20000",
                path::quote(root),
                prune_expr(),
            ))
            .await?;
        let dirs_text = dirs.stdout_text();
        let dir_set: std::collections::HashSet<&str> = dirs_text.lines().collect();
        for hit in &mut hits {
            hit.is_dir = dir_set.contains(hit.path.as_str());
        }
    }

    Ok(SearchResult { hits, truncated })
}

pub async fn grep(
    conn: &RemoteConn,
    root: &str,
    query: &str,
    limit: usize,
    case_sensitive: bool,
) -> Result<GrepResponse, String> {
    if query.is_empty() {
        return Ok(GrepResponse {
            hits: Vec::new(),
            truncated: false,
            files_scanned: 0,
        });
    }
    let flags = if case_sensitive { "-n" } else { "-ni" };
    // `/dev/null` as an extra operand forces the filename prefix even when the
    // batch holds a single file, which is the portable equivalent of `-H`.
    // `-e` keeps a query starting with `-` from being read as a flag.
    let cmd = format!(
        "find {} {} -type f{} -exec grep {} -e {} /dev/null {{}} + 2>/dev/null | head -n {}",
        path::quote(root),
        prune_expr(),
        hidden_filter(true),
        flags,
        path::quote(query),
        limit + 1,
    );
    let out = conn.exec(&cmd).await?;
    let text = out.stdout_text();

    let mut hits: Vec<GrepHit> = Vec::new();
    for line in text.lines() {
        // Without GNU `-I` a binary file can still match; its line carries NUL
        // or control bytes, which the UI has no way to render.
        if line.chars().any(|c| c == '\0') {
            continue;
        }
        // grep -n prints `path:line:text`; a path may itself contain a colon,
        // so split from the left only as far as the two known fields.
        let Some((file, rest)) = split_grep_line(line, root) else {
            continue;
        };
        let Some((number, text)) = rest.split_once(':') else {
            continue;
        };
        let Ok(number) = number.parse::<u64>() else {
            continue;
        };
        hits.push(GrepHit {
            path: file.to_owned(),
            rel: relative(root, file),
            line: number,
            text: text.to_owned(),
        });
    }
    let truncated = hits.len() > limit;
    hits.truncate(limit);

    let files_scanned = hits
        .iter()
        .map(|h| h.path.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    Ok(GrepResponse {
        hits,
        truncated,
        files_scanned,
    })
}

/// Split `path:line:text` when the path itself may contain colons. The path
/// always starts with the search root, so match the longest prefix that is
/// followed by a digit run and another colon.
fn split_grep_line<'a>(line: &'a str, root: &str) -> Option<(&'a str, &'a str)> {
    if !line.starts_with(root) {
        return line.split_once(':');
    }
    let mut from = root.len();
    while let Some(offset) = line[from..].find(':') {
        let at = from + offset;
        let rest = &line[at + 1..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with(':') {
            return Some((&line[..at], rest));
        }
        from = at + 1;
    }
    line.split_once(':')
}

pub async fn glob(
    conn: &RemoteConn,
    root: &str,
    pattern: &str,
    limit: usize,
) -> Result<GlobResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".to_owned());
    }
    // `find -path` takes a glob directly, so the pattern never reaches a shell.
    let cmd = format!(
        "find {} {} -type f -path {} -print 2>/dev/null | head -n {}",
        path::quote(root),
        prune_expr(),
        path::quote(&format!("*{pattern}*")),
        limit + 1,
    );
    let out = conn.exec(&cmd).await?;
    let text = out.stdout_text();
    let mut hits: Vec<GlobHit> = text
        .lines()
        .map(|l| GlobHit {
            path: l.to_owned(),
            rel: relative(root, l),
        })
        .collect();
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(GlobResponse { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_strips_the_root() {
        assert_eq!(relative("/srv/app", "/srv/app/src/main.rs"), "src/main.rs");
        assert_eq!(relative("/srv/app/", "/srv/app/a.txt"), "a.txt");
        assert_eq!(relative("/srv/app", "/srv/app"), "");
    }

    #[test]
    fn relative_leaves_an_unrelated_path_alone() {
        assert_eq!(relative("/srv/app", "/etc/passwd"), "/etc/passwd");
    }

    #[test]
    fn grep_line_splits_a_plain_path() {
        let (file, rest) = split_grep_line("/srv/app/a.rs:12:hello", "/srv/app").unwrap();
        assert_eq!(file, "/srv/app/a.rs");
        assert_eq!(rest, "12:hello");
    }

    #[test]
    fn grep_line_splits_a_path_containing_a_colon() {
        // A colon is a legal filename character on POSIX.
        let (file, rest) = split_grep_line("/srv/app/we:ird.rs:3:x", "/srv/app").unwrap();
        assert_eq!(file, "/srv/app/we:ird.rs");
        assert_eq!(rest, "3:x");
    }

    #[test]
    fn grep_line_keeps_colons_in_the_matched_text() {
        let (file, rest) = split_grep_line("/srv/app/a.rs:7:let x = a:b:c;", "/srv/app").unwrap();
        assert_eq!(file, "/srv/app/a.rs");
        assert_eq!(rest, "7:let x = a:b:c;");
    }

    #[test]
    fn prune_expression_quotes_every_name() {
        let expr = prune_expr();
        assert!(expr.contains("-name '.git'"));
        assert!(expr.contains("-name 'node_modules'"));
        assert!(expr.starts_with("\\("));
        assert!(expr.ends_with("-prune -o"));
    }

    #[test]
    fn the_hidden_filter_precedes_the_print_action() {
        // -print always succeeds and prints, so a test placed after it is
        // evaluated and discarded: dotfiles would be listed anyway.
        for cmd in [
            build_list_command("/srv", "", false, 10),
            build_search_command("/srv", false),
        ] {
            let filter = cmd.find("! -path").expect("filter present");
            let print = cmd.find("-print").expect("print present");
            assert!(filter < print, "filter must come first in: {cmd}");
        }
    }

    #[test]
    fn hidden_filter_is_only_applied_when_hiding() {
        assert_eq!(hidden_filter(true), "");
        assert!(hidden_filter(false).contains("! -path"), "POSIX negation, not the GNU -not spelling");
    }
}
