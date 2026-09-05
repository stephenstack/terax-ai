//! SSH connection lifecycle: connect, verify, authenticate, and pump a shell
//! channel to the frontend.
//!
//! The channel has exactly one owner (the pump task). Writes and resizes reach
//! it through an mpsc queue rather than a shared lock, so a slow network write
//! can never block a keystroke on the UI thread.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use std::collections::HashMap;
use tauri::ipc::{Channel, Response};
use tokio::sync::{mpsc, oneshot};

use super::hostkey::{self, HostKeyInfo, HostKeyStatus};
use super::target::{self, AuthMethod, ResolvedTarget, SshTarget};

/// Matches the PTY path: coalesce a short burst into one IPC message rather
/// than paying a round-trip per network read.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
/// Bounded so a runaway `yes` on the remote cannot grow the queue without end.
const MAX_PENDING: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub enum SessionCmd {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Signal(String),
    Close,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshEvent {
    /// Coarse connect progress, so the pane can show what is happening rather
    /// than a blank grid.
    Phase {
        phase: &'static str,
    },
    HostKey {
        prompt_id: u64,
        host: String,
        port: u16,
        fingerprint: String,
        algorithm: String,
        status: HostKeyStatus,
        conflict_line: Option<usize>,
    },
    AuthPrompt {
        prompt_id: u64,
        kind: &'static str,
        /// Human-readable label from the server, or our own for a passphrase.
        prompt: String,
        echo: bool,
        /// Present for keyboard-interactive, which may carry server text.
        instructions: Option<String>,
    },
    Banner {
        text: String,
    },
    Error {
        message: String,
    },
    Ready,
}

/// Routes interactive questions from the connect task to the UI and back.
pub struct PromptBus {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    events: Channel<SshEvent>,
}

impl PromptBus {
    pub fn new(events: Channel<SshEvent>) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            events,
        }
    }

    pub fn emit(&self, event: SshEvent) {
        if let Err(e) = self.events.send(event) {
            log::debug!("ssh event channel closed: {e}");
        }
    }

    /// Emit a question and wait for `ssh_prompt_respond`. A closed receiver
    /// means the pane went away, which cancels the connect rather than hanging.
    async fn ask(&self, build: impl FnOnce(u64) -> SshEvent) -> Result<String, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.emit(build(id));
        match rx.await {
            Ok(value) => Ok(value),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("cancelled".to_owned())
            }
        }
    }

    pub fn respond(&self, prompt_id: u64, value: String) -> Result<(), String> {
        let tx = self
            .pending
            .lock()
            .unwrap()
            .remove(&prompt_id)
            .ok_or_else(|| "no such prompt".to_owned())?;
        tx.send(value).map_err(|_| "prompt abandoned".to_owned())
    }

    /// Fail every outstanding prompt so a closing session does not strand the
    /// connect task awaiting an answer that can no longer arrive.
    pub fn cancel_all(&self) {
        self.pending.lock().unwrap().clear();
    }
}

pub struct SshSession {
    pub cmd_tx: mpsc::UnboundedSender<SessionCmd>,
    pub bus: Arc<PromptBus>,
    pub exited: AtomicBool,
}

impl SshSession {
    pub fn close(&self) {
        self.bus.cancel_all();
        let _ = self.cmd_tx.send(SessionCmd::Close);
    }
}

struct Handler {
    host: String,
    port: u16,
    bus: Arc<PromptBus>,
    known_hosts: std::path::PathBuf,
    /// Set when the user accepted a key for this connection only, so we do not
    /// write it to known_hosts on success.
    accepted_once: Arc<AtomicBool>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // A certificate is validated by its CA, not by known_hosts. We do
            // not ship CA trust configuration yet, so refuse rather than
            // silently accept an unverifiable identity.
            russh::keys::PublicKeyOrCertificate::Certificate(_) => {
                self.bus.emit(SshEvent::Error {
                    message: "server offered a certificate; certificate trust is not configured"
                        .to_owned(),
                });
                return Ok(false);
            }
        };

        let info: HostKeyInfo =
            match hostkey::verify(&self.host, self.port, &key, &self.known_hosts) {
                Ok(info) => info,
                Err(e) => {
                    self.bus.emit(SshEvent::Error { message: e });
                    return Ok(false);
                }
            };

        if info.status == HostKeyStatus::Trusted {
            return Ok(true);
        }

        let host = self.host.clone();
        let port = self.port;
        let answer = self
            .bus
            .ask(|prompt_id| SshEvent::HostKey {
                prompt_id,
                host,
                port,
                fingerprint: info.fingerprint.clone(),
                algorithm: info.algorithm.clone(),
                status: info.status,
                conflict_line: info.conflict_line,
            })
            .await
            .unwrap_or_else(|_| "reject".to_owned());

        match answer.as_str() {
            "accept-and-remember" => {
                if let Err(e) = hostkey::learn(&self.host, self.port, &key, &self.known_hosts) {
                    // Recording is best-effort: the user already chose to trust
                    // this key, so connect and tell them it was not persisted.
                    self.bus.emit(SshEvent::Error {
                        message: format!("connected, but the key was not saved: {e}"),
                    });
                }
                Ok(true)
            }
            "accept" => {
                self.accepted_once.store(true, Ordering::Release);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !banner.trim().is_empty() {
            self.bus.emit(SshEvent::Banner {
                text: banner.to_owned(),
            });
        }
        Ok(())
    }
}

fn client_config(resolved: &ResolvedTarget) -> client::Config {
    let mut config = client::Config {
        // Interactive typing is latency-bound, not throughput-bound; Nagle
        // batching a keystroke behind an ACK is exactly the wrong trade.
        nodelay: true,
        ..Default::default()
    };
    if let Some(secs) = resolved.keepalive_secs {
        config.keepalive_interval = Some(Duration::from_secs(secs as u64));
        config.keepalive_max = 3;
    }
    config
}

/// Ask for a passphrase only when the key is actually encrypted: try the file
/// unlocked first, and prompt only if that specific failure comes back.
async fn load_key(
    path: &str,
    passphrase: Option<&str>,
    bus: &PromptBus,
) -> Result<russh::keys::PrivateKey, String> {
    let expanded = expand_tilde(path);
    if let Some(pass) = passphrase {
        return load_secret_key(&expanded, Some(pass))
            .map_err(|e| format!("could not open {path}: {e}"));
    }
    match load_secret_key(&expanded, None) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => {
            let answer = bus
                .ask(|prompt_id| SshEvent::AuthPrompt {
                    prompt_id,
                    kind: "passphrase",
                    prompt: format!("Passphrase for {path}"),
                    echo: false,
                    instructions: None,
                })
                .await?;
            load_secret_key(&expanded, Some(&answer))
                .map_err(|_| format!("wrong passphrase for {path}"))
        }
        Err(e) => Err(format!("could not open {path}: {e}")),
    }
}

fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

async fn try_agent(handle: &mut client::Handle<Handler>, user: &str) -> Result<bool, String> {
    let mut agent = match russh::keys::agent::client::AgentClient::connect_env().await {
        Ok(agent) => agent,
        Err(e) => {
            log::debug!("ssh agent unavailable: {e}");
            return Ok(false);
        }
    };
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("agent refused to list identities: {e}"))?;
    if identities.is_empty() {
        log::debug!("ssh agent holds no identities");
        return Ok(false);
    }
    for identity in identities {
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
            // Certificate identities need CA trust we do not configure yet.
            continue;
        };
        let hash_alg = handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten();
        match handle
            .authenticate_publickey_with(user, key, hash_alg, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(true),
            Ok(_) => continue,
            Err(e) => {
                log::debug!("agent identity rejected: {e:?}");
                continue;
            }
        }
    }
    Ok(false)
}

async fn try_keyboard_interactive(
    handle: &mut client::Handle<Handler>,
    user: &str,
    bus: &PromptBus,
) -> Result<bool, String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|e| format!("keyboard-interactive failed: {e}"))?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest {
                instructions,
                prompts,
                ..
            } => {
                let mut answers = Vec::with_capacity(prompts.len());
                for prompt in prompts {
                    let instructions = if instructions.trim().is_empty() {
                        None
                    } else {
                        Some(instructions.clone())
                    };
                    let label = prompt.prompt.clone();
                    let echo = prompt.echo;
                    answers.push(
                        bus.ask(|prompt_id| SshEvent::AuthPrompt {
                            prompt_id,
                            kind: "keyboard-interactive",
                            prompt: label,
                            echo,
                            instructions,
                        })
                        .await?,
                    );
                }
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| format!("keyboard-interactive failed: {e}"))?;
            }
        }
    }
}

async fn authenticate(
    handle: &mut client::Handle<Handler>,
    resolved: &ResolvedTarget,
    bus: &PromptBus,
) -> Result<(), String> {
    let user = &resolved.user;
    // Some servers grant access outright; asking costs one round-trip and
    // avoids prompting for a password that was never required.
    if let Ok(AuthResult::Success) = handle.authenticate_none(user.clone()).await {
        return Ok(());
    }

    let mut last_error: Option<String> = None;
    for method in &resolved.methods {
        let outcome = match method {
            AuthMethod::Agent => try_agent(handle, user).await,
            AuthMethod::KeyFile { path, passphrase } => {
                match load_key(path, passphrase.as_deref(), bus).await {
                    Ok(key) => {
                        let hash_alg = handle
                            .best_supported_rsa_hash()
                            .await
                            .ok()
                            .flatten()
                            .flatten();
                        handle
                            .authenticate_publickey(
                                user.clone(),
                                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                            )
                            .await
                            .map(|r| r.success())
                            .map_err(|e| format!("key authentication failed: {e}"))
                    }
                    Err(e) => Err(e),
                }
            }
            AuthMethod::Password { password } => {
                let password = match password {
                    Some(p) => p.clone(),
                    None => {
                        bus.ask(|prompt_id| SshEvent::AuthPrompt {
                            prompt_id,
                            kind: "password",
                            prompt: format!("{}@{}'s password", resolved.user, resolved.host),
                            echo: false,
                            instructions: None,
                        })
                        .await?
                    }
                };
                handle
                    .authenticate_password(user.clone(), password)
                    .await
                    .map(|r| r.success())
                    .map_err(|e| format!("password authentication failed: {e}"))
            }
            AuthMethod::KeyboardInteractive => try_keyboard_interactive(handle, user, bus).await,
        };

        match outcome {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            // A cancelled prompt is the user's decision, not a method failure:
            // stop rather than falling through to the next prompt.
            Err(e) if e == "cancelled" => return Err(e),
            Err(e) => {
                log::debug!("ssh auth method failed: {e}");
                last_error = Some(e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "authentication failed".to_owned()))
}

/// Drive the shell channel until it closes. Owns the channel outright.
async fn pump(
    mut channel: russh::Channel<client::Msg>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCmd>,
    on_data: Channel<Response>,
    exit_code: Arc<Mutex<i32>>,
) {
    let mut pending: Vec<u8> = Vec::new();
    let mut flush = tokio::time::interval(FLUSH_COALESCE);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut dropped: usize = 0;

    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if pending.len() + data.len() > MAX_PENDING {
                            dropped += data.len();
                        } else {
                            pending.extend_from_slice(&data);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        *exit_code.lock().unwrap() = exit_status as i32;
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        // Mirror the shell convention so the frontend can treat
                        // a signalled remote command like a local one.
                        log::debug!("ssh remote exited on signal {signal_name:?}");
                        *exit_code.lock().unwrap() = 128;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCmd::Data(bytes)) => {
                        if let Err(e) = channel.data_bytes(bytes).await {
                            log::debug!("ssh write failed: {e}");
                            break;
                        }
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        let g = target::clamp_geometry(cols, rows);
                        if let Err(e) = channel
                            .window_change(g.cols as u32, g.rows as u32, 0, 0)
                            .await
                        {
                            log::debug!("ssh resize failed: {e}");
                        }
                    }
                    Some(SessionCmd::Signal(name)) => {
                        if let Some(sig) = parse_signal(&name) {
                            let _ = channel.signal(sig).await;
                        }
                    }
                    Some(SessionCmd::Close) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                }
            }
            _ = flush.tick() => {
                if !pending.is_empty() {
                    let chunk = std::mem::take(&mut pending);
                    if let Err(e) = on_data.send(Response::new(chunk)) {
                        log::debug!("ssh data channel closed: {e}");
                        break;
                    }
                }
                if dropped > 0 {
                    log::warn!("ssh backpressure: dropped {dropped} bytes (cap {MAX_PENDING})");
                    dropped = 0;
                }
            }
        }
    }

    if !pending.is_empty() {
        let _ = on_data.send(Response::new(pending));
    }
}

fn parse_signal(name: &str) -> Option<russh::Sig> {
    use russh::Sig;
    Some(match name.to_ascii_uppercase().as_str() {
        "INT" => Sig::INT,
        "TERM" => Sig::TERM,
        "KILL" => Sig::KILL,
        "HUP" => Sig::HUP,
        "QUIT" => Sig::QUIT,
        "USR1" => Sig::USR1,
        _ => return None,
    })
}

pub struct SpawnArgs {
    pub target: SshTarget,
    pub cols: u16,
    pub rows: u16,
    pub on_data: Channel<Response>,
    pub on_exit: Channel<i32>,
    /// Created by the caller so prompts emitted during the handshake are
    /// answerable before this function returns.
    pub bus: Arc<PromptBus>,
}

/// Connect and hand back a live session. Returns only once the shell channel
/// is open, so a failure surfaces as a rejected promise rather than a dead pane.
pub async fn spawn(args: SpawnArgs) -> Result<Arc<SshSession>, String> {
    let SpawnArgs {
        target,
        cols,
        rows,
        on_data,
        on_exit,
        bus,
    } = args;

    let resolved = target::resolve_target(&target)?;
    let known_hosts = hostkey::default_known_hosts_path()?;
    let accepted_once = Arc::new(AtomicBool::new(false));

    bus.emit(SshEvent::Phase {
        phase: "connecting",
    });

    let handler = Handler {
        host: resolved.host.clone(),
        port: resolved.port,
        bus: bus.clone(),
        known_hosts,
        accepted_once,
    };

    let config = Arc::new(client_config(&resolved));
    let connect = client::connect(config, resolved.addr.clone(), handler);
    let mut handle = tokio::time::timeout(
        Duration::from_secs(resolved.connect_timeout_secs as u64),
        connect,
    )
    .await
    .map_err(|_| {
        format!(
            "timed out connecting to {} after {}s",
            resolved.addr, resolved.connect_timeout_secs
        )
    })?
    .map_err(|e| format!("could not connect to {}: {e}", resolved.addr))?;

    bus.emit(SshEvent::Phase {
        phase: "authenticating",
    });
    authenticate(&mut handle, &resolved, &bus).await?;

    bus.emit(SshEvent::Phase { phase: "opening" });
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("could not open session channel: {e}"))?;

    for (name, value) in &target.env {
        // Servers reject anything outside AcceptEnv; that is routine, not fatal.
        let _ = channel.set_env(false, name.clone(), value.clone()).await;
    }

    let geometry = target::clamp_geometry(cols, rows);
    channel
        .request_pty(
            false,
            &resolved.term,
            geometry.cols as u32,
            geometry.rows as u32,
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| format!("could not request a remote pty: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("could not start the remote shell: {e}"))?;

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let exit_code = Arc::new(Mutex::new(0));
    let session = Arc::new(SshSession {
        cmd_tx: cmd_tx.clone(),
        bus: bus.clone(),
        exited: AtomicBool::new(false),
    });

    if let Some(line) = target::startup_command(target.cwd.as_deref(), target.command.as_deref()) {
        let _ = cmd_tx.send(SessionCmd::Data(line.into_bytes()));
    }

    bus.emit(SshEvent::Ready);

    let pump_session = session.clone();
    let pump_exit = exit_code.clone();
    tauri::async_runtime::spawn(async move {
        pump(channel, cmd_rx, on_data, pump_exit).await;
        pump_session.exited.store(true, Ordering::Release);
        pump_session.bus.cancel_all();
        let code = *exit_code.lock().unwrap();
        if let Err(e) = on_exit.send(code) {
            log::debug!("ssh exit channel closed: {e}");
        }
        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    });

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_signals_a_terminal_sends() {
        assert!(parse_signal("INT").is_some());
        assert!(parse_signal("int").is_some());
        assert!(parse_signal("TERM").is_some());
        assert!(parse_signal("NOPE").is_none());
    }

    #[test]
    fn expands_a_leading_tilde_only() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            expand_tilde("~/.ssh/id_ed25519"),
            home.join(".ssh/id_ed25519")
        );
        assert_eq!(
            expand_tilde("/abs/~/path"),
            std::path::PathBuf::from("/abs/~/path"),
            "a tilde mid-path is a literal directory name"
        );
    }

    #[tokio::test]
    async fn prompt_bus_round_trips_an_answer() {
        let events = Channel::new(|_| Ok(()));
        let bus = Arc::new(PromptBus::new(events));
        let asker = bus.clone();
        let task = tokio::spawn(async move {
            asker
                .ask(|prompt_id| SshEvent::AuthPrompt {
                    prompt_id,
                    kind: "password",
                    prompt: "pw".into(),
                    echo: false,
                    instructions: None,
                })
                .await
        });
        // The id is deterministic: the bus hands out 1 first.
        tokio::task::yield_now().await;
        bus.respond(1, "hunter2".into()).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), "hunter2");
    }

    #[tokio::test]
    async fn responding_to_an_unknown_prompt_is_an_error() {
        let events = Channel::new(|_| Ok(()));
        let bus = PromptBus::new(events);
        assert!(bus.respond(99, "x".into()).is_err());
    }

    #[tokio::test]
    async fn cancelling_unblocks_a_waiting_prompt() {
        let events = Channel::new(|_| Ok(()));
        let bus = Arc::new(PromptBus::new(events));
        let asker = bus.clone();
        let task = tokio::spawn(async move {
            asker
                .ask(|prompt_id| SshEvent::AuthPrompt {
                    prompt_id,
                    kind: "password",
                    prompt: "pw".into(),
                    echo: false,
                    instructions: None,
                })
                .await
        });
        tokio::task::yield_now().await;
        bus.cancel_all();
        assert_eq!(task.await.unwrap().unwrap_err(), "cancelled");
    }
}
