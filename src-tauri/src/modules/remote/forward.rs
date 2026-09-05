//! Local port forwarding.
//!
//! `ssh -L`: a socket on this machine, whose traffic is carried over the SSH
//! connection and opened as a TCP connection from the far side. The common use
//! is reaching a service bound to the remote's own loopback, such as a dev
//! server or a database that is deliberately not exposed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use super::conn::RemoteConn;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    /// Local address to bind. Defaults to loopback: binding a forward on all
    /// interfaces exposes the remote service to the whole network, which is
    /// never what someone means by default.
    #[serde(default)]
    pub bind_address: Option<String>,
    /// 0 asks the OS for a free port, reported back in `ForwardInfo`.
    pub local_port: u16,
    /// Host to connect to *from the remote*, so `localhost` is the remote's.
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: u32,
    pub conn: u32,
    pub bind_address: String,
    /// The port actually bound, which differs from the request when it was 0.
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

struct Forward {
    info: ForwardInfo,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct TunnelState {
    forwards: RwLock<HashMap<u32, Forward>>,
    next_id: AtomicU32,
}

impl TunnelState {
    fn allocate(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn list(&self) -> Vec<ForwardInfo> {
        let mut out: Vec<ForwardInfo> = self
            .forwards
            .read()
            .unwrap()
            .values()
            .map(|f| f.info.clone())
            .collect();
        out.sort_by_key(|f| f.id);
        out
    }

    /// Stop a forward and wait for its listener to actually go away.
    ///
    /// Aborting alone is not enough to promise anything: the task owns the
    /// listening socket, so the port stays bound until it has finished
    /// unwinding. Callers reasonably expect to be able to rebind the same port
    /// immediately after closing.
    pub async fn close(&self, id: u32) -> bool {
        let removed = self.forwards.write().unwrap().remove(&id);
        match removed {
            Some(f) => {
                f.task.abort();
                let _ = f.task.await;
                true
            }
            None => false,
        }
    }

    /// Drop every forward riding on a connection that is going away.
    pub async fn close_for_conn(&self, conn: u32) -> usize {
        let doomed: Vec<Forward> = {
            let mut forwards = self.forwards.write().unwrap();
            let ids: Vec<u32> = forwards
                .values()
                .filter(|f| f.info.conn == conn)
                .map(|f| f.info.id)
                .collect();
            ids.iter().filter_map(|id| forwards.remove(id)).collect()
        };
        let count = doomed.len();
        for f in doomed {
            f.task.abort();
            let _ = f.task.await;
        }
        count
    }

    pub async fn close_all(&self) -> usize {
        let drained: Vec<Forward> = {
            let mut forwards = self.forwards.write().unwrap();
            forwards.drain().map(|(_, f)| f).collect()
        };
        let count = drained.len();
        for f in drained {
            f.task.abort();
            let _ = f.task.await;
        }
        count
    }
}

/// Bind the local socket and start accepting.
///
/// The listener is bound before returning, so a port clash surfaces as a
/// rejected call rather than a forward that silently never works.
pub async fn open_local(
    state: &TunnelState,
    conn_id: u32,
    conn: Arc<RemoteConn>,
    spec: &ForwardSpec,
) -> Result<ForwardInfo, String> {
    let bind_address = spec
        .bind_address
        .clone()
        .unwrap_or_else(|| "127.0.0.1".to_owned());
    if spec.remote_host.trim().is_empty() {
        return Err("a forward needs a remote host".to_owned());
    }
    if spec.remote_port == 0 {
        return Err("a forward needs a remote port".to_owned());
    }

    let listener = TcpListener::bind((bind_address.as_str(), spec.local_port))
        .await
        .map_err(|e| format!("could not bind {bind_address}:{}: {e}", spec.local_port))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("could not read the bound port: {e}"))?
        .port();

    let id = state.allocate();
    let info = ForwardInfo {
        id,
        conn: conn_id,
        bind_address,
        local_port,
        remote_host: spec.remote_host.clone(),
        remote_port: spec.remote_port,
    };

    let accept_info = info.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    log::warn!("forward {id} stopped accepting: {e}");
                    return;
                }
            };
            let conn = conn.clone();
            let host = accept_info.remote_host.clone();
            let port = accept_info.remote_port;
            // One task per connection: a slow or stuck peer must not stop the
            // listener from serving the next one.
            tauri::async_runtime::spawn(async move {
                let channel = match conn.open_forward_channel(&host, port, &peer.to_string()).await
                {
                    Ok(c) => c,
                    Err(e) => {
                        log::debug!("forward {id} could not reach {host}:{port}: {e}");
                        return;
                    }
                };
                let mut socket = socket;
                let mut stream = channel.into_stream();
                if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut stream).await {
                    // A peer hanging up mid-transfer is routine.
                    log::debug!("forward {id} closed: {e}");
                }
            });
        }
    });

    state
        .forwards
        .write()
        .unwrap()
        .insert(id, Forward { info: info.clone(), task });
    log::info!(
        "forward {id} listening on {}:{} -> {}:{}",
        info.bind_address,
        info.local_port,
        info.remote_host,
        info.remote_port
    );
    Ok(info)
}
