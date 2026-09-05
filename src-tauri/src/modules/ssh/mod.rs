//! SSH remote sessions.
//!
//! Deliberately shaped to mirror `modules::pty`: the frontend opens a session,
//! writes raw bytes with an id header, resizes, and closes. The difference is
//! that connecting is interactive (host keys, passwords), so an extra event
//! channel carries prompts the UI has to answer.

pub mod config;
mod hostkey;
mod session;
mod target;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tauri::ipc::{Channel, Response};

use session::{PromptBus, SessionCmd, SshEvent, SshSession};
use target::SshTarget;

pub struct SshState {
    sessions: RwLock<HashMap<u32, Arc<SshSession>>>,
    /// Buses for handshakes that have not produced a session yet. A host-key
    /// prompt fires before `ssh_open` returns, so the answer has to reach a bus
    /// that is not reachable through `sessions` yet.
    pending: Mutex<HashMap<u32, Arc<PromptBus>>>,
    // Starts at 1 for the same reason as PtyState: the frontend treats 0 as
    // "unset". Never reused.
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl SshState {
    fn get(&self, id: u32) -> Option<Arc<SshSession>> {
        self.sessions.read().unwrap().get(&id).cloned()
    }
}

/// Allocate the id before connecting so prompts emitted mid-handshake can be
/// answered against a session the frontend already knows about.
#[tauri::command]
pub fn ssh_reserve(state: tauri::State<SshState>) -> u32 {
    state.next_id.fetch_add(1, Ordering::Relaxed)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_open(
    state: tauri::State<'_, SshState>,
    id: u32,
    cols: u16,
    rows: u16,
    target: SshTarget,
    on_data: Channel<Response>,
    on_event: Channel<SshEvent>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    // Register the bus before the handshake so `ssh_prompt_respond` can find it
    // while `spawn` is still awaiting an answer.
    let bus = Arc::new(PromptBus::new(on_event));
    state.pending.lock().unwrap().insert(id, bus.clone());

    let result = session::spawn(session::SpawnArgs {
        target,
        cols,
        rows,
        on_data,
        on_exit,
        bus,
    })
    .await;

    state.pending.lock().unwrap().remove(&id);

    match result {
        Ok(sess) => {
            state.sessions.write().unwrap().insert(id, sess);
            log::info!("ssh opened id={id} cols={cols} rows={rows}");
            Ok(id)
        }
        Err(e) => {
            log::warn!("ssh_open id={id} failed: {e}");
            Err(e)
        }
    }
}

// Raw body + id header, matching pty_write: no JSON round-trip per keystroke.
#[tauri::command]
pub fn ssh_write(
    state: tauri::State<SshState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-ssh-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "ssh_write: missing x-ssh-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("ssh_write: expected raw body".to_string());
    };
    let session = state.get(id).ok_or_else(|| {
        log::warn!("ssh_write: unknown id={id}");
        "no session".to_string()
    })?;
    session
        .cmd_tx
        .send(SessionCmd::Data(bytes.clone()))
        .map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub fn ssh_resize(
    state: tauri::State<SshState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state.get(id).ok_or_else(|| {
        log::warn!("ssh_resize: unknown id={id}");
        "no session".to_string()
    })?;
    session
        .cmd_tx
        .send(SessionCmd::Resize { cols, rows })
        .map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub fn ssh_signal(state: tauri::State<SshState>, id: u32, signal: String) -> Result<(), String> {
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    session
        .cmd_tx
        .send(SessionCmd::Signal(signal))
        .map_err(|_| "session closed".to_string())
}

/// Answer an outstanding host-key or auth prompt. Looks in the live sessions
/// first, then the in-flight handshakes.
#[tauri::command]
pub fn ssh_prompt_respond(
    state: tauri::State<SshState>,
    id: u32,
    prompt_id: u64,
    value: String,
) -> Result<(), String> {
    if let Some(session) = state.get(id) {
        return session.bus.respond(prompt_id, value);
    }
    let bus = state
        .pending
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no session".to_string())?;
    bus.respond(prompt_id, value)
}

#[tauri::command]
pub fn ssh_close(state: tauri::State<SshState>, id: u32) -> Result<(), String> {
    // Cancel any in-flight prompt too: closing a pane mid-password must not
    // leave the connect task parked forever.
    if let Some(bus) = state.pending.lock().unwrap().remove(&id) {
        bus.cancel_all();
    }
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        s.close();
        log::info!("ssh closed id={id}");
    } else {
        log::debug!("ssh_close: unknown id={id}");
    }
    Ok(())
}

/// A webview reload orphans every session in this still-running process.
#[tauri::command]
pub fn ssh_close_all(state: tauri::State<SshState>) -> Result<usize, String> {
    for (_, bus) in state.pending.lock().unwrap().drain() {
        bus.cancel_all();
    }
    let drained: Vec<(u32, Arc<SshSession>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (_, s) in drained {
        s.close();
    }
    if count > 0 {
        log::info!("ssh_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredKey {
    pub path: String,
    pub name: String,
    pub encrypted: bool,
}

/// List private keys sitting in `~/.ssh`, so the host editor can offer them
/// instead of making the user type a path.
#[tauri::command]
pub fn ssh_discover_keys() -> Result<Vec<DiscoveredKey>, String> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut keys = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // A private key has no extension; its `.pub` sibling and the config,
        // known_hosts, and authorized_keys files are not candidates.
        if name.ends_with(".pub")
            || matches!(
                name,
                "config" | "known_hosts" | "known_hosts.old" | "authorized_keys"
            )
        {
            continue;
        }
        let encrypted = match russh::keys::load_secret_key(&path, None) {
            Ok(_) => false,
            Err(russh::keys::Error::KeyIsEncrypted) => true,
            // Not a key we can read at all: leave it out rather than offering
            // something that cannot authenticate.
            Err(_) => continue,
        };
        keys.push(DiscoveredKey {
            path: path.to_string_lossy().into_owned(),
            name: name.to_owned(),
            encrypted,
        });
    }
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

/// Whether an agent is reachable and how many identities it holds, so the UI
/// can grey out the agent option honestly instead of failing at connect time.
#[tauri::command]
pub async fn ssh_agent_identities() -> Result<Vec<String>, String> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| format!("no ssh-agent: {e}"))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("agent error: {e}"))?;
    Ok(identities
        .into_iter()
        .filter_map(|i| match i {
            russh::keys::agent::AgentIdentity::PublicKey { key, comment } => {
                Some(if comment.trim().is_empty() {
                    key.fingerprint(Default::default()).to_string()
                } else {
                    comment
                })
            }
            _ => None,
        })
        .collect())
}

/// Parse `~/.ssh/config` for the import flow.
#[tauri::command]
pub fn ssh_read_config() -> Result<Vec<config::SshConfigHost>, String> {
    let Some(path) = dirs::home_dir().map(|h| h.join(".ssh").join("config")) else {
        return Ok(Vec::new());
    };
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(config::parse_ssh_config(&contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}
