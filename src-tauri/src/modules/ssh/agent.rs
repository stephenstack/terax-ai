//! Talking to a running ssh-agent.
//!
//! The transport differs per platform and the stream types are not unifiable,
//! so the connect step is `cfg`-gated and everything after it is generic over
//! the stream. Unix has one socket from `SSH_AUTH_SOCK`; Windows has two
//! possible agents, OpenSSH's named pipe and PuTTY's Pageant.

use russh::client::{self, AuthResult};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;

use super::session::Handler;

/// The name to show for an identity: its comment, or its fingerprint when the
/// agent did not supply one.
fn identity_label(identity: AgentIdentity) -> Option<String> {
    match identity {
        AgentIdentity::PublicKey { key, comment } => Some(if comment.trim().is_empty() {
            key.fingerprint(Default::default()).to_string()
        } else {
            comment
        }),
        // A certificate needs CA trust we do not configure yet.
        _ => None,
    }
}

async fn list<S>(mut agent: AgentClient<S>) -> Result<Vec<String>, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("agent error: {e}"))?;
    Ok(identities.into_iter().filter_map(identity_label).collect())
}

/// Try each identity the agent holds, in the agent's own order.
async fn authenticate_with<S>(
    handle: &mut client::Handle<Handler>,
    user: &str,
    mut agent: AgentClient<S>,
) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("agent refused to list identities: {e}"))?;
    if identities.is_empty() {
        log::debug!("ssh agent holds no identities");
        return Ok(false);
    }
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
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

#[cfg(unix)]
pub async fn identities() -> Result<Vec<String>, String> {
    let agent = AgentClient::connect_env()
        .await
        .map_err(|e| format!("no ssh-agent: {e}"))?;
    list(agent).await
}

#[cfg(unix)]
pub async fn authenticate(
    handle: &mut client::Handle<Handler>,
    user: &str,
) -> Result<bool, String> {
    match AgentClient::connect_env().await {
        Ok(agent) => authenticate_with(handle, user, agent).await,
        Err(e) => {
            // No agent is a normal configuration, not a failure: fall through
            // to the next method.
            log::debug!("ssh agent unavailable: {e}");
            Ok(false)
        }
    }
}

/// OpenSSH for Windows listens here. `SSH_AUTH_SOCK` wins when set, because a
/// user who pointed it somewhere meant it.
#[cfg(windows)]
fn pipe_path() -> std::ffi::OsString {
    std::env::var_os("SSH_AUTH_SOCK")
        .unwrap_or_else(|| std::ffi::OsString::from(r"\\.\pipe\openssh-ssh-agent"))
}

#[cfg(windows)]
pub async fn identities() -> Result<Vec<String>, String> {
    if let Ok(agent) = AgentClient::connect_named_pipe(pipe_path()).await {
        return list(agent).await;
    }
    let agent = AgentClient::connect_pageant()
        .await
        .map_err(|e| format!("no ssh-agent: {e}"))?;
    list(agent).await
}

#[cfg(windows)]
pub async fn authenticate(
    handle: &mut client::Handle<Handler>,
    user: &str,
) -> Result<bool, String> {
    // OpenSSH's agent first, then Pageant: a machine can have both, and the
    // OpenSSH one is the default on Windows 10 and later.
    if let Ok(agent) = AgentClient::connect_named_pipe(pipe_path()).await {
        if authenticate_with(handle, user, agent).await? {
            return Ok(true);
        }
    }
    match AgentClient::connect_pageant().await {
        Ok(agent) => authenticate_with(handle, user, agent).await,
        Err(e) => {
            log::debug!("ssh agent unavailable: {e}");
            Ok(false)
        }
    }
}
