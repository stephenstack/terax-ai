//! A live connection to a remote workspace.
//!
//! One SSH connection per open remote workspace, carrying an SFTP session for
//! file operations and opening short-lived exec channels for anything better
//! answered by a program on the far side (git, find, grep).

use std::sync::Arc;

use russh::client;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tokio::sync::Mutex;

use crate::modules::ssh::session::{connect_authenticated, Handler, PromptBus};
use crate::modules::ssh::target::SshTarget;

/// Output of a remote command. Bytes, not text: a git diff can carry content
/// that is not valid UTF-8, and a lossy conversion would corrupt it.
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
    /// True when output hit the cap and was cut short.
    pub truncated: bool,
}

impl ExecOutput {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    /// Lossy text, for callers that only ever deal in paths and messages.
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

pub struct RemoteConn {
    handle: client::Handle<Handler>,
    /// Directories the user has opened as a workspace on this connection.
    /// Mutations must land inside one, mirroring the local `WorkspaceRegistry`
    /// so a path from the frontend cannot reach arbitrary parts of the server.
    roots: std::sync::Mutex<Vec<String>>,
    /// SFTP is a single multiplexed channel; serialise access to it. Requests
    /// are short, and a second SFTP channel per operation would be far more
    /// expensive than the wait.
    sftp: Mutex<SftpSession>,
    pub host: String,
    pub user: String,
    /// Remote home, resolved once at connect so `~` can be expanded without a
    /// round trip on every path.
    pub home: String,
}

/// A remote command's output is bounded so a `cat` of something enormous
/// cannot exhaust memory on this side.
const MAX_EXEC_OUTPUT: usize = 16 * 1024 * 1024;

impl RemoteConn {
    pub async fn open(target: &SshTarget, bus: &Arc<PromptBus>) -> Result<Self, String> {
        let (handle, resolved) = connect_authenticated(target, bus).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("could not open a channel: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("the server refused the sftp subsystem: {e}"))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("could not start sftp: {e}"))?;

        // `canonicalize(".")` is the SFTP way to ask where the session starts,
        // which is the user's home on every server that has one.
        let home = sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| format!("/home/{}", resolved.user));

        Ok(Self {
            handle,
            roots: std::sync::Mutex::new(Vec::new()),
            sftp: Mutex::new(sftp),
            host: resolved.host,
            user: resolved.user,
            home,
        })
    }

    pub async fn sftp(&self) -> tokio::sync::MutexGuard<'_, SftpSession> {
        self.sftp.lock().await
    }

    pub fn authorize_root(&self, root: &str) {
        let mut roots = self.roots.lock().unwrap();
        if !roots.iter().any(|r| r == root) {
            roots.push(root.to_owned());
        }
    }

    /// A mutation target must sit inside a directory the user actually opened.
    pub fn authorize_mutation(&self, target: &str) -> Result<(), String> {
        let roots = self.roots.lock().unwrap();
        if roots.iter().any(|r| super::path::is_within(r, target)) {
            Ok(())
        } else {
            Err(format!(
                "{target} is outside the authorized remote workspace"
            ))
        }
    }

    /// Run a command on the remote and collect its output.
    pub async fn exec(&self, command: &str) -> Result<ExecOutput, String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("could not open a channel: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("could not run the remote command: {e}"))?;

        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut code = 0i32;
        let mut truncated = false;

        while let Some(msg) = channel.wait().await {
            match msg {
                // Once the cap is hit nothing more is appended: dropping only
                // the oversized chunk and taking later ones would splice
                // non-contiguous bytes into what looks like a valid prefix,
                // and a caller parsing a diff or a path list cannot tell.
                ChannelMsg::Data { data } => {
                    if truncated || stdout.len() + data.len() > MAX_EXEC_OUTPUT {
                        truncated = true;
                    } else {
                        stdout.extend_from_slice(&data);
                    }
                }
                // ext 1 is stderr; anything else is not something we asked for.
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    if !truncated && stderr.len() + data.len() <= MAX_EXEC_OUTPUT {
                        stderr.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
                // Not Eof: the server sends exit-status after it, so breaking
                // there would report success for every failing command.
                ChannelMsg::Close => break,
                _ => {}
            }
        }

        Ok(ExecOutput {
            stdout,
            stderr,
            code,
            truncated,
        })
    }

    /// Open a `direct-tcpip` channel: the far side makes the TCP connection,
    /// which is what lets a forward reach a service on the remote's loopback.
    pub async fn open_forward_channel(
        &self,
        host: &str,
        port: u16,
        originator: &str,
    ) -> Result<russh::Channel<client::Msg>, String> {
        self.handle
            .channel_open_direct_tcpip(host.to_owned(), port as u32, originator.to_owned(), 0)
            .await
            .map_err(|e| format!("could not open a forward to {host}:{port}: {e}"))
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}
