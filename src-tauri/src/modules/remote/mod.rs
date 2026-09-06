//! Remote workspaces: an SSH connection that backs the file explorer, the
//! editor, and source control for a directory on another machine.
//!
//! Separate from `modules::ssh`, which owns interactive terminal sessions. The
//! two share the connect and authentication path but nothing else: a workspace
//! outlives any individual terminal and needs SFTP plus exec, not a PTY.

pub mod conn;
pub mod exec;
pub mod forward;
pub mod fs;
pub mod path;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tauri::ipc::Channel;

use crate::modules::ssh::session::{PromptBus, SshEvent};
use crate::modules::ssh::target::SshTarget;
use conn::RemoteConn;

/// A handle to the managed state for callers that cannot take `tauri::State`,
/// notably the synchronous git process layer.
static GLOBAL: std::sync::OnceLock<Arc<RemoteState>> = std::sync::OnceLock::new();

pub fn set_global(state: Arc<RemoteState>) {
    let _ = GLOBAL.set(state);
}

pub fn global() -> Option<&'static Arc<RemoteState>> {
    GLOBAL.get()
}

pub struct RemoteState {
    conns: RwLock<HashMap<u32, Arc<RemoteConn>>>,
    /// Prompt buses for connections still handshaking, for the same reason
    /// `SshState` keeps them: a host-key question fires before `remote_open`
    /// returns.
    pending: Mutex<HashMap<u32, Arc<PromptBus>>>,
    closed_while_opening: Mutex<HashSet<u32>>,
    next_id: AtomicU32,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            conns: RwLock::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            closed_while_opening: Mutex::new(HashSet::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl RemoteState {
    pub fn get(&self, id: u32) -> Option<Arc<RemoteConn>> {
        self.conns.read().unwrap().get(&id).cloned()
    }

    /// Register an already-open connection. Only used by the live tests, which
    /// build a connection directly rather than through `remote_open`.
    #[doc(hidden)]
    pub fn insert_for_test(&self, conn: Arc<RemoteConn>) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns.write().unwrap().insert(id, conn);
        id
    }

    /// Look up a connection for an fs/git command, with a message the UI can
    /// show rather than a bare "no session".
    pub fn require(&self, id: u32) -> Result<Arc<RemoteConn>, String> {
        self.get(id)
            .ok_or_else(|| "the connection to this remote workspace was lost".to_owned())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOpened {
    pub conn: u32,
    pub home: String,
    pub host: String,
    pub user: String,
}

#[tauri::command]
pub fn remote_reserve(state: tauri::State<Arc<RemoteState>>) -> u32 {
    state.next_id.fetch_add(1, Ordering::Relaxed)
}

#[tauri::command]
pub async fn remote_open(
    state: tauri::State<'_, Arc<RemoteState>>,
    id: u32,
    target: SshTarget,
    on_event: Channel<SshEvent>,
) -> Result<RemoteOpened, String> {
    let bus = Arc::new(PromptBus::new(on_event));
    state.pending.lock().unwrap().insert(id, bus.clone());

    let result = RemoteConn::open(&target, &bus).await;

    state.pending.lock().unwrap().remove(&id);

    match result {
        Ok(c) => {
            if state.closed_while_opening.lock().unwrap().remove(&id) {
                c.disconnect().await;
                return Err("cancelled".to_string());
            }
            let opened = RemoteOpened {
                conn: id,
                home: c.home.clone(),
                host: c.host.clone(),
                user: c.user.clone(),
            };
            state.conns.write().unwrap().insert(id, Arc::new(c));
            log::info!("remote workspace opened id={id}");
            Ok(opened)
        }
        Err(e) => {
            state.closed_while_opening.lock().unwrap().remove(&id);
            log::warn!("remote_open id={id} failed: {e}");
            Err(e)
        }
    }
}

/// Answer a host-key or auth question raised while a workspace is connecting.
/// Only in-flight handshakes ask questions, so this looks nowhere else.
#[tauri::command]
pub fn remote_prompt_respond(
    state: tauri::State<Arc<RemoteState>>,
    id: u32,
    prompt_id: u64,
    value: Option<String>,
) -> Result<(), String> {
    let bus = state
        .pending
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no pending connection".to_string())?;
    bus.respond(prompt_id, value)
}

/// Whether a connection is still usable. The frontend caches an open
/// workspace and needs to know a cached entry has not gone stale.
#[tauri::command]
pub fn remote_is_open(state: tauri::State<Arc<RemoteState>>, id: u32) -> bool {
    state.get(id).is_some()
}

#[tauri::command]
pub async fn remote_close(
    state: tauri::State<'_, Arc<RemoteState>>,
    tunnels: tauri::State<'_, forward::TunnelState>,
    id: u32,
) -> Result<(), String> {
    // A forward on a dead connection would accept sockets and immediately
    // fail every one of them.
    tunnels.close_for_conn(id).await;
    if let Some(bus) = state.pending.lock().unwrap().remove(&id) {
        bus.cancel_all();
        state.closed_while_opening.lock().unwrap().insert(id);
    }
    let c = state.conns.write().unwrap().remove(&id);
    if let Some(c) = c {
        c.disconnect().await;
        log::info!("remote workspace closed id={id}");
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_close_all(
    state: tauri::State<'_, Arc<RemoteState>>,
) -> Result<usize, String> {
    {
        let mut pending = state.pending.lock().unwrap();
        let mut tombstones = state.closed_while_opening.lock().unwrap();
        for (id, bus) in pending.drain() {
            bus.cancel_all();
            tombstones.insert(id);
        }
    }
    let drained: Vec<Arc<RemoteConn>> = {
        let mut conns = state.conns.write().unwrap();
        conns.drain().map(|(_, c)| c).collect()
    };
    let count = drained.len();
    for c in drained {
        c.disconnect().await;
    }
    if count > 0 {
        log::info!("remote_close_all: reaped {count} connection(s)");
    }
    Ok(count)
}

#[tauri::command]
pub async fn tunnel_open(
    state: tauri::State<'_, Arc<RemoteState>>,
    tunnels: tauri::State<'_, forward::TunnelState>,
    conn: u32,
    spec: forward::ForwardSpec,
) -> Result<forward::ForwardInfo, String> {
    let c = state.require(conn)?;
    forward::open_local(&tunnels, conn, c, &spec).await
}

#[tauri::command]
pub async fn tunnel_close(
    tunnels: tauri::State<'_, forward::TunnelState>,
    id: u32,
) -> Result<bool, String> {
    Ok(tunnels.close(id).await)
}

#[tauri::command]
pub fn tunnel_list(tunnels: tauri::State<forward::TunnelState>) -> Vec<forward::ForwardInfo> {
    tunnels.list()
}

#[tauri::command]
pub async fn tunnel_close_all(
    tunnels: tauri::State<'_, forward::TunnelState>,
) -> Result<usize, String> {
    Ok(tunnels.close_all().await)
}

/// Register a directory as an open remote workspace root and hand back its
/// canonical form, mirroring `workspace_authorize` for the local case.
#[tauri::command]
pub async fn remote_authorize(
    state: tauri::State<'_, Arc<RemoteState>>,
    conn: u32,
    path: String,
) -> Result<String, String> {
    let c = state.require(conn)?;
    let resolved = resolve(&c, &path);
    // Canonicalize on the server so a symlinked root is registered as what it
    // actually is; containment checks compare against the real path.
    let canonical = fs::canonicalize(&c, &resolved)
        .await
        .unwrap_or_else(|_| resolved.clone());
    c.authorize_root(&canonical);
    Ok(canonical)
}

/// Read a remote file from synchronous code.
///
/// Bridges to the async runtime with a channel, the same way the git process
/// layer does, so the sync git operations can read a working-tree file without
/// every caller becoming async.
pub fn read_file_blocking(conn: u32, path: &str) -> Result<Vec<u8>, String> {
    let state = global().ok_or_else(|| "remote state unavailable".to_owned())?;
    let connection = state.require(conn)?;
    let path = path.to_owned();
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let sftp = connection.sftp().await;
        let _ = tx.send(
            sftp.read(path.clone())
                .await
                .map_err(|e| format!("could not read {path}: {e}")),
        );
    });
    rx.recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| "timed out reading the remote file".to_owned())?
}

/// Copy a remote file into the local downloads directory, returning where it
/// landed.
///
/// Streamed rather than read into memory: a download is the one path where the
/// file has no reason to be bounded by anything the editor would accept, and
/// the bytes never enter the webview at all.
#[tauri::command]
pub async fn remote_download(
    state: tauri::State<'_, Arc<RemoteState>>,
    conn: u32,
    path: String,
) -> Result<String, String> {
    let connection = state.require(conn)?;
    let remote = resolve(&connection, &path);
    let name = path::basename(&remote);
    if name.is_empty() {
        return Err("that path has no file name".to_owned());
    }

    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "could not find a downloads directory".to_owned())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let dest = unique_download_path(&dir, name);

    let sftp = connection.sftp().await;
    let mut source = sftp
        .open(remote.clone())
        .await
        .map_err(|e| format!("could not open {remote}: {e}"))?;
    let mut target = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("could not create {}: {e}", dest.display()))?;

    let copied = tokio::io::copy(&mut source, &mut target).await;
    if let Err(e) = copied {
        // A partial file is worse than none: it looks like a finished download.
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(format!("could not download {remote}: {e}"));
    }
    tokio::io::AsyncWriteExt::flush(&mut target)
        .await
        .map_err(|e| format!("could not finish writing {}: {e}", dest.display()))?;

    Ok(dest.to_string_lossy().into_owned())
}

/// Never clobber an existing download: `notes.txt` becomes `notes (2).txt`.
fn unique_download_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = std::path::Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_owned());
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 2..10_000 {
        let candidate = match &ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

/// Resolve a path the frontend sent against the remote home, so `~` works and
/// a relative path is anchored somewhere sensible.
pub fn resolve(c: &RemoteConn, raw: &str) -> String {
    let expanded = path::expand_home(raw, &c.home);
    if expanded.starts_with('/') {
        path::normalize(&expanded)
    } else {
        path::join(&c.home, &expanded)
    }
}
