use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

#[derive(Clone, Debug)]
pub struct ResolvedGitDirectory {
    pub workspace: WorkspaceEnv,
    pub git_path: String,
    pub local_path: PathBuf,
}

pub fn split_upstream(upstream: &str) -> (Option<String>, Option<String>) {
    match upstream.split_once('/') {
        Some((remote, branch)) => (Some(remote.to_string()), Some(branch.to_string())),
        None => (None, Some(upstream.to_string())),
    }
}

pub fn display_path(path: &Path) -> String {
    crate::modules::fs::to_canon(path)
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn canonical_dir(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    if let Some(conn) = workspace.remote_conn() {
        return remote_dir(conn, path, workspace);
    }
    let candidate = resolve_path(path, workspace);
    if !candidate.is_dir() {
        return Err(GitError::NotADirectory(path.to_string()));
    }
    let local_path = registry
        .canonicalize_cached(&candidate)
        .map_err(GitError::Io)?;
    let git_path = if workspace.is_wsl() {
        normalize_git_path(path)
    } else {
        display_path(&local_path)
    };
    Ok(ResolvedGitDirectory {
        workspace: workspace.clone(),
        git_path,
        local_path,
    })
}

/// Resolve a directory on a remote workspace.
///
/// There is no local path and no local filesystem to consult, so this is
/// string arithmetic against the connection's home. Whether the directory
/// exists is left to git, which reports it better than a probe would and
/// saves a round trip.
fn remote_dir(conn: u32, path: &str, workspace: &WorkspaceEnv) -> Result<ResolvedGitDirectory> {
    let state = crate::modules::remote::global()
        .ok_or_else(|| GitError::Spawn("remote state unavailable".into()))?;
    let connection = state
        .get(conn)
        .ok_or_else(|| GitError::NotADirectory(path.to_string()))?;
    let git_path = crate::modules::remote::resolve(&connection, path);
    Ok(ResolvedGitDirectory {
        workspace: workspace.clone(),
        // Carries the remote path so pathspec arithmetic still works. Nothing
        // ever hands it to the local filesystem: every consumer branches on
        // `workspace.remote_conn()` first.
        local_path: PathBuf::from(&git_path),
        git_path,
    })
}

/// Whether this directory is inside a workspace the user opened.
///
/// A remote workspace is authorized on its own connection; the local registry
/// knows nothing about the other machine, so consulting it would reject every
/// remote path. Single-sourced because several git entry points check this
/// directly rather than going through `authorized_repo_root`.
pub fn ensure_authorized(registry: &WorkspaceRegistry, dir: &ResolvedGitDirectory) -> Result<()> {
    let Some(conn) = dir.workspace.remote_conn() else {
        if registry.is_authorized(&dir.local_path) {
            return Ok(());
        }
        return Err(GitError::PathOutsideWorkspace(dir.local_path.clone()));
    };
    let state = crate::modules::remote::global()
        .ok_or_else(|| GitError::Spawn("remote state unavailable".into()))?;
    let connection = state
        .get(conn)
        .ok_or_else(|| GitError::PathOutsideWorkspace(dir.local_path.clone()))?;
    connection
        .authorize_mutation(&dir.git_path)
        .map_err(|_| GitError::PathOutsideWorkspace(dir.local_path.clone()))
}

/// Remember a resolved repo root so later operations inside it are allowed.
/// Best effort, matching the local behaviour it replaces.
pub fn remember_authorized(registry: &WorkspaceRegistry, dir: &ResolvedGitDirectory) {
    match dir.workspace.remote_conn() {
        Some(conn) => {
            if let Some(state) = crate::modules::remote::global() {
                if let Some(connection) = state.get(conn) {
                    connection.authorize_root(&dir.git_path);
                }
            }
        }
        None => {
            let _ = registry.authorize(&dir.local_path);
        }
    }
}

pub fn authorized_repo_root(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let canonical = canonical_dir(registry, path, workspace)?;
    ensure_authorized(registry, &canonical)?;
    Ok(canonical)
}

/// Validate a repo-relative path for a remote workspace.
///
/// Pure containment arithmetic: there is no remote filesystem to canonicalize
/// against, and a deleted path has to resolve for staging a removal anyway.
pub fn resolve_within_remote_repo(repo_root: &str, rel: &str) -> Result<String> {
    if !is_safe_pathspec(rel) {
        return Err(GitError::InvalidPath(rel.into()));
    }
    let joined = crate::modules::remote::path::join(repo_root, rel);
    if !crate::modules::remote::path::is_within(repo_root, &joined) {
        return Err(GitError::PathOutsideWorkspace(PathBuf::from(joined)));
    }
    Ok(joined)
}

pub fn resolve_within_repo(repo_root: &Path, rel: &str) -> Result<PathBuf> {
    if !is_safe_pathspec(rel) {
        return Err(GitError::InvalidPath(rel.into()));
    }
    let joined = repo_root.join(rel);
    match std::fs::canonicalize(&joined) {
        Ok(canonical) => {
            if !canonical.starts_with(repo_root) {
                return Err(GitError::PathOutsideWorkspace(canonical));
            }
            Ok(canonical)
        }
        // Deleted path (staging a removal): validate via nearest existing ancestor.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            resolve_deleted_within_repo(repo_root, &joined, rel)
        }
        Err(e) => Err(GitError::Io(e)),
    }
}

pub fn is_safe_pathspec(rel: &str) -> bool {
    if rel.is_empty() || rel.contains(':') || rel.contains('\0') {
        return false;
    }
    if rel.chars().any(|c| (c as u32) < 0x20) {
        return false;
    }
    // Reject `.`/`..` so the deleted-path branch can't be used to escape the repo.
    !rel.split(['/', '\\']).any(|c| c == "." || c == "..")
}

fn resolve_deleted_within_repo(repo_root: &Path, joined: &Path, rel: &str) -> Result<PathBuf> {
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut cursor = joined;
    loop {
        let name = cursor
            .file_name()
            .ok_or_else(|| GitError::InvalidPath(rel.into()))?;
        let parent = cursor
            .parent()
            .ok_or_else(|| GitError::InvalidPath(rel.into()))?;
        tail.push(name);
        match std::fs::canonicalize(parent) {
            Ok(canonical_parent) => {
                if !canonical_parent.starts_with(repo_root) {
                    return Err(GitError::PathOutsideWorkspace(canonical_parent));
                }
                let mut resolved = canonical_parent;
                for component in tail.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                cursor = parent;
            }
            Err(e) => return Err(GitError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_upstream_separates_remote_and_branch() {
        assert_eq!(
            split_upstream("origin/main"),
            (Some("origin".to_string()), Some("main".to_string()))
        );
    }

    #[test]
    fn split_upstream_splits_on_the_first_slash_only() {
        assert_eq!(
            split_upstream("origin/feature/x"),
            (Some("origin".to_string()), Some("feature/x".to_string()))
        );
    }

    #[test]
    fn split_upstream_without_slash_yields_branch_only() {
        assert_eq!(split_upstream("main"), (None, Some("main".to_string())));
    }

    #[test]
    fn normalize_git_path_converts_backslashes_to_slashes() {
        assert_eq!(normalize_git_path("a\\b\\c"), "a/b/c");
        assert_eq!(normalize_git_path("a/b"), "a/b");
    }

    #[test]
    fn safe_pathspec_accepts_normal_paths() {
        assert!(is_safe_pathspec("src/main.rs"));
        assert!(is_safe_pathspec("a/b/c-d_e.txt"));
        assert!(is_safe_pathspec("folder with spaces/file.md"));
        assert!(is_safe_pathspec("file.with.dots"));
    }

    #[test]
    fn safe_pathspec_rejects_colon() {
        assert!(!is_safe_pathspec("evil:path"));
        assert!(!is_safe_pathspec(":head"));
        assert!(!is_safe_pathspec("a/b:c"));
    }

    #[test]
    fn safe_pathspec_rejects_nul_and_control() {
        assert!(!is_safe_pathspec("foo\0bar"));
        assert!(!is_safe_pathspec("foo\nbar"));
        assert!(!is_safe_pathspec("foo\rbar"));
        assert!(!is_safe_pathspec("foo\tbar"));
    }

    #[test]
    fn safe_pathspec_rejects_empty() {
        assert!(!is_safe_pathspec(""));
    }

    #[test]
    fn resolve_within_repo_rejects_colon_path() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "evil:path");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }

    #[test]
    fn resolve_within_repo_rejects_nul_path() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "evil\0path");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }

    #[test]
    fn safe_pathspec_rejects_dot_components() {
        assert!(!is_safe_pathspec("../escape"));
        assert!(!is_safe_pathspec("a/../b"));
        assert!(!is_safe_pathspec("./a"));
        assert!(!is_safe_pathspec("a/."));
        assert!(!is_safe_pathspec(".."));
    }

    #[test]
    fn resolve_within_repo_handles_deleted_directory() {
        let base = std::env::temp_dir().join("terax_git_deleted_dir_test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("envs/__pycache__")).unwrap();
        let repo_root = std::fs::canonicalize(&base).unwrap();
        std::fs::remove_dir_all(repo_root.join("envs")).unwrap();
        let resolved =
            resolve_within_repo(&repo_root, "envs/__pycache__/g1.pyc").expect("deleted path");
        assert_eq!(resolved, repo_root.join("envs/__pycache__/g1.pyc"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_within_repo_rejects_deleted_escape() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "../outside.txt");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }
}
