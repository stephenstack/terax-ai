//! SFTP-backed filesystem operations.
//!
//! Returns the exact shapes the local `fs` module returns, so the explorer and
//! editor consume a remote workspace without knowing it is remote.

use russh_sftp::protocol::{FileType, OpenFlags};

use super::conn::{ExecOutput, RemoteConn};
use super::path;
use crate::modules::fs::file::{FileStat, ReadResult, StatKind, FORCE_MAX_READ_BYTES, MAX_READ_BYTES};
use crate::modules::fs::tree::{DirEntry, EntryKind};

/// Prefer the server's own message; fall back to ours when it said nothing.
fn remote_error(out: &ExecOutput, fallback: &str) -> String {
    let stderr = out.stderr_text();
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn kind_of(ty: FileType, was_symlink: bool) -> EntryKind {
    if was_symlink {
        EntryKind::Symlink
    } else if ty.is_dir() {
        EntryKind::Dir
    } else {
        EntryKind::File
    }
}

/// SFTP reports mtime in whole seconds; the frontend compares milliseconds.
fn mtime_millis(mtime: Option<u32>) -> u64 {
    mtime.map(|t| t as u64 * 1000).unwrap_or(0)
}

pub async fn read_dir(
    conn: &RemoteConn,
    dir: &str,
    show_hidden: bool,
) -> Result<Vec<DirEntry>, String> {
    let sftp = conn.sftp().await;
    let listing = sftp
        .read_dir(dir.to_owned())
        .await
        .map_err(|e| format!("could not list {dir}: {e}"))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in listing {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata();
        let was_symlink = meta.file_type().is_symlink();
        // A symlink's own stat says nothing about what it points at, and the
        // explorer needs the target's kind to decide whether it is expandable.
        let resolved = if was_symlink {
            sftp.metadata(path::join(dir, &name)).await.ok()
        } else {
            None
        };
        let effective = resolved.as_ref().unwrap_or(&meta);
        entries.push(DirEntry {
            name,
            kind: kind_of(effective.file_type(), was_symlink),
            size: effective.size.unwrap_or(0),
            mtime: mtime_millis(effective.mtime),
            // Remote git decorations would cost a `git status` per listing;
            // the source-control panel covers the same ground on demand.
            gitignored: false,
        });
    }

    entries.sort_by(|a, b| {
        let dir_first = matches!(b.kind, EntryKind::Dir).cmp(&matches!(a.kind, EntryKind::Dir));
        dir_first.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn list_subdirs(
    conn: &RemoteConn,
    dir: &str,
    show_hidden: bool,
) -> Result<Vec<String>, String> {
    Ok(read_dir(conn, dir, show_hidden)
        .await?
        .into_iter()
        .filter(|e| matches!(e.kind, EntryKind::Dir))
        .map(|e| e.name)
        .collect())
}

/// True when the bytes look like something the editor cannot show. Same rule
/// as the local reader: a NUL in the first block means binary.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|b| *b == 0)
}

pub async fn read_file(
    conn: &RemoteConn,
    file: &str,
    force: bool,
) -> Result<ReadResult, String> {
    let sftp = conn.sftp().await;
    let meta = sftp
        .metadata(file.to_owned())
        .await
        .map_err(|e| format!("could not open {file}: {e}"))?;
    let size = meta.size.unwrap_or(0);
    let limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    if size > limit {
        return Ok(ReadResult::TooLarge { size, limit });
    }

    let bytes = sftp
        .read(file.to_owned())
        .await
        .map_err(|e| format!("could not read {file}: {e}"))?;
    if looks_binary(&bytes) {
        return Ok(ReadResult::Binary { size });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            mtime: mtime_millis(meta.mtime),
        }),
        Err(_) => Ok(ReadResult::Binary { size }),
    }
}

/// Write and return the new mtime, which the editor uses for its conflict
/// check. There is no atomic rename here: SFTP `rename` fails when the target
/// exists on many servers, and a failed swap would be worse than a direct
/// write.
pub async fn write_file(conn: &RemoteConn, file: &str, content: &str) -> Result<u64, String> {
    let sftp = conn.sftp().await;
    write_bytes(&sftp, file, content.as_bytes()).await?;
    let meta = sftp
        .metadata(file.to_owned())
        .await
        .map_err(|e| format!("could not stat {file} after writing: {e}"))?;
    Ok(mtime_millis(meta.mtime))
}

pub async fn stat(conn: &RemoteConn, target: &str) -> Result<FileStat, String> {
    let sftp = conn.sftp().await;
    let link = sftp
        .symlink_metadata(target.to_owned())
        .await
        .map_err(|e| format!("could not stat {target}: {e}"))?;
    let was_symlink = link.file_type().is_symlink();
    let meta = if was_symlink {
        sftp.metadata(target.to_owned()).await.unwrap_or(link)
    } else {
        link
    };
    Ok(FileStat {
        size: meta.size.unwrap_or(0),
        mtime: mtime_millis(meta.mtime),
        kind: if was_symlink {
            StatKind::Symlink
        } else if meta.file_type().is_dir() {
            StatKind::Dir
        } else {
            StatKind::File
        },
    })
}

pub async fn canonicalize(conn: &RemoteConn, target: &str) -> Result<String, String> {
    let sftp = conn.sftp().await;
    sftp.canonicalize(target.to_owned())
        .await
        .map_err(|e| format!("could not resolve {target}: {e}"))
}

pub async fn create_file(conn: &RemoteConn, file: &str) -> Result<(), String> {
    let sftp = conn.sftp().await;
    if sftp.try_exists(file.to_owned()).await.unwrap_or(false) {
        return Err(format!("{} already exists", path::basename(file)));
    }
    // EXCLUDE makes the create fail rather than truncate if the file appeared
    // between the check and the open.
    sftp.open_with_flags(
        file.to_owned(),
        OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
    )
    .await
    .map_err(|e| format!("could not create {file}: {e}"))?;
    Ok(())
}

pub async fn create_dir(conn: &RemoteConn, dir: &str) -> Result<(), String> {
    let sftp = conn.sftp().await;
    if sftp.try_exists(dir.to_owned()).await.unwrap_or(false) {
        return Err(format!("{} already exists", path::basename(dir)));
    }
    sftp.create_dir(dir.to_owned())
        .await
        .map_err(|e| format!("could not create {dir}: {e}"))
}

pub async fn rename(conn: &RemoteConn, from: &str, to: &str) -> Result<(), String> {
    let sftp = conn.sftp().await;
    if sftp.try_exists(to.to_owned()).await.unwrap_or(false) {
        return Err(format!("{} already exists", path::basename(to)));
    }
    sftp.rename(from.to_owned(), to.to_owned())
        .await
        .map_err(|e| format!("could not rename {from}: {e}"))
}

/// Recursive delete. SFTP has no recursive remove, and walking a large tree
/// over individual requests is slow, so hand the work to the remote shell.
pub async fn delete(conn: &RemoteConn, targets: &[String]) -> Result<(), String> {
    if targets.is_empty() {
        return Ok(());
    }
    let args: Vec<String> = targets.iter().map(|t| path::quote(t)).collect();
    let out = conn
        .exec(&format!("rm -rf -- {}", args.join(" ")))
        .await?;
    if out.ok() {
        Ok(())
    } else {
        Err(remote_error(&out, "could not delete"))
    }
}

/// Upload local files or directories into a remote directory.
///
/// Used by drag-and-drop, where the sources are paths on this machine. Refuses
/// to overwrite, matching the local copy.
pub async fn upload(conn: &RemoteConn, sources: &[String], dest_dir: &str) -> Result<(), String> {
    for source in sources {
        let src = std::path::Path::new(source);
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid source: {source}"))?;
        let target = path::join(dest_dir, name);
        {
            let sftp = conn.sftp().await;
            if sftp.try_exists(target.clone()).await.unwrap_or(false) {
                return Err(format!("{name} already exists"));
            }
        }
        upload_entry(conn, src, &target).await?;
    }
    Ok(())
}

async fn upload_entry(
    conn: &RemoteConn,
    src: &std::path::Path,
    target: &str,
) -> Result<(), String> {
    let meta = std::fs::metadata(src).map_err(|e| format!("could not read {src:?}: {e}"))?;
    if meta.is_dir() {
        {
            let sftp = conn.sftp().await;
            sftp.create_dir(target.to_owned())
                .await
                .map_err(|e| format!("could not create {target}: {e}"))?;
        }
        let entries =
            std::fs::read_dir(src).map_err(|e| format!("could not read {src:?}: {e}"))?;
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            // Recursion through a boxed future: an async fn cannot call itself
            // directly without an infinitely sized future.
            Box::pin(upload_entry(
                conn,
                &entry.path(),
                &path::join(target, &name),
            ))
            .await?;
        }
        return Ok(());
    }

    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "{} is too large to upload ({} MB limit)",
            path::basename(target),
            MAX_UPLOAD_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(src).map_err(|e| format!("could not read {src:?}: {e}"))?;
    let sftp = conn.sftp().await;
    write_bytes(&sftp, target, &bytes).await
}

/// A drag-and-drop upload is buffered in memory, so cap it well below anything
/// that would strain the process.
const MAX_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;

/// Write a whole file, creating it if absent and truncating if present.
///
/// `SftpSession::write` opens with `WRITE` alone: a new file fails outright,
/// and an existing one is overwritten in place without truncating, so saving
/// a shortened file would leave the old tail behind.
async fn write_bytes(
    sftp: &russh_sftp::client::SftpSession,
    file: &str,
    bytes: &[u8],
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut handle = sftp
        .open_with_flags(
            file.to_owned(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| format!("could not open {file} for writing: {e}"))?;
    handle
        .write_all(bytes)
        .await
        .map_err(|e| format!("could not write {file}: {e}"))?;
    handle
        .shutdown()
        .await
        .map_err(|e| format!("could not flush {file}: {e}"))
}

pub async fn copy(conn: &RemoteConn, from: &str, to: &str) -> Result<(), String> {
    let out = conn
        .exec(&format!(
            "cp -R -- {} {}",
            path::quote(from),
            path::quote(to)
        ))
        .await?;
    if out.ok() {
        Ok(())
    } else {
        Err(remote_error(&out, &format!("could not copy {from}")))
    }
}
