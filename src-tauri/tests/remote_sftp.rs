//! Live SFTP/exec checks against a real SSH server.
//!
//! Skipped unless TERAX_TEST_SSH is set, so CI and offline runs are unaffected:
//!   TERAX_TEST_SSH=127.0.0.1:2222 TERAX_TEST_SSH_USER=me \
//!   TERAX_TEST_SSH_PASS=secret TERAX_TEST_SSH_ROOT=/srv/proj cargo test --test remote_sftp
//!
//! The point is to exercise the code the app actually runs, not a copy of it.

use std::sync::Arc;

use tauri::ipc::Channel;
use terax_lib::modules::remote::conn::RemoteConn;
use terax_lib::modules::remote::{exec, fs, path};
use terax_lib::modules::ssh::session::PromptBus;
use terax_lib::modules::ssh::target::{AuthMethod, SshTarget};

struct Env {
    host: String,
    port: u16,
    user: String,
    pass: String,
    root: String,
}

fn env() -> Option<Env> {
    let addr = std::env::var("TERAX_TEST_SSH").ok()?;
    let (host, port) = addr.rsplit_once(':')?;
    Some(Env {
        host: host.to_owned(),
        port: port.parse().ok()?,
        user: std::env::var("TERAX_TEST_SSH_USER").ok()?,
        pass: std::env::var("TERAX_TEST_SSH_PASS").ok()?,
        root: std::env::var("TERAX_TEST_SSH_ROOT").ok()?,
    })
}

async fn connect(e: &Env) -> RemoteConn {
    let target = SshTarget {
        host: e.host.clone(),
        port: Some(e.port),
        user: e.user.clone(),
        auth: vec![AuthMethod::Password {
            password: Some(e.pass.clone()),
        }],
        term: None,
        cwd: None,
        command: None,
        keepalive_secs: None,
        connect_timeout_secs: Some(15),
        compression: None,
        env: Vec::new(),
        jumps: Vec::new(),
    };
    let bus = Arc::new(PromptBus::new(Channel::new(|_| Ok(()))));
    RemoteConn::open(&target, &bus)
        .await
        .expect("connect to the test server")
}

macro_rules! live {
    ($name:ident, $conn:ident, $e:ident, $body:block) => {
        #[test]
        fn $name() {
            let Some($e) = env() else {
                eprintln!("skipping {}: TERAX_TEST_SSH not set", stringify!($name));
                return;
            };
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let $conn = connect(&$e).await;
                $body
            });
        }
    };
}

live!(reads_a_directory_and_hides_dotfiles, c, e, {
    let entries = fs::read_dir(&c, &e.root, false).await.expect("read_dir");
    let names: Vec<&str> = entries.iter().map(|x| x.name.as_str()).collect();
    assert!(names.contains(&"src"), "expected src in {names:?}");
    assert!(
        !names.iter().any(|n| n.starts_with('.')),
        "dotfiles must be hidden: {names:?}"
    );

    let all = fs::read_dir(&c, &e.root, true).await.expect("read_dir hidden");
    assert!(
        all.iter().any(|x| x.name.starts_with('.')),
        "show_hidden must include dotfiles"
    );
});

live!(directories_sort_before_files, c, e, {
    let entries = fs::read_dir(&c, &e.root, false).await.expect("read_dir");
    let first_file = entries.iter().position(|x| !matches!(x.kind, terax_lib::modules::fs::tree::EntryKind::Dir));
    let last_dir = entries.iter().rposition(|x| matches!(x.kind, terax_lib::modules::fs::tree::EntryKind::Dir));
    if let (Some(f), Some(d)) = (first_file, last_dir) {
        assert!(d < f, "directories must come first");
    }
});

live!(round_trips_a_file, c, e, {
    let target = path::join(&e.root, "terax_roundtrip.txt");
    c.authorize_root(&e.root);
    fs::write_file(&c, &target, "first\n").await.expect("write");

    let read = fs::read_file(&c, &target, false).await.expect("read");
    match read {
        terax_lib::modules::fs::file::ReadResult::Text { content, .. } => {
            assert_eq!(content, "first\n");
        }
        _ => panic!("expected the file to read back as text"),
    }

    // The editor's conflict check depends on mtime moving.
    fs::write_file(&c, &target, "second\n").await.expect("rewrite");
    let stat = fs::stat(&c, &target).await.expect("stat");
    assert!(stat.mtime > 0, "mtime must be reported");
    assert_eq!(stat.size, 7);

    fs::delete(&c, std::slice::from_ref(&target)).await.expect("delete");
});

live!(overwriting_with_shorter_content_truncates, c, e, {
    // SftpSession::write opens WRITE-only, which leaves the old tail in place.
    // Saving a shortened file in the editor would otherwise silently corrupt it.
    c.authorize_root(&e.root);
    let target = path::join(&e.root, "terax_truncate.txt");
    fs::write_file(&c, &target, "aaaaaaaaaaaaaaaaaaaa\n").await.expect("write long");
    fs::write_file(&c, &target, "bb\n").await.expect("write short");

    let read = fs::read_file(&c, &target, false).await.expect("read");
    match read {
        terax_lib::modules::fs::file::ReadResult::Text { content, size, .. } => {
            assert_eq!(content, "bb\n", "stale bytes were left behind");
            assert_eq!(size, 3);
        }
        _ => panic!("expected text"),
    }
    fs::delete(&c, std::slice::from_ref(&target)).await.expect("delete");
});

live!(creates_a_file_that_does_not_exist_yet, c, e, {
    c.authorize_root(&e.root);
    let target = path::join(&e.root, "terax_new_file.txt");
    let _ = fs::delete(&c, std::slice::from_ref(&target)).await;
    fs::write_file(&c, &target, "fresh\n").await.expect("write to a new path");
    assert!(fs::stat(&c, &target).await.is_ok());
    fs::delete(&c, std::slice::from_ref(&target)).await.expect("delete");
});

live!(create_rename_and_delete, c, e, {
    c.authorize_root(&e.root);
    let a = path::join(&e.root, "terax_a.txt");
    let b = path::join(&e.root, "terax_b.txt");
    let _ = fs::delete(&c, &[a.clone(), b.clone()]).await;

    fs::create_file(&c, &a).await.expect("create");
    assert!(
        fs::create_file(&c, &a).await.is_err(),
        "creating over an existing file must fail"
    );
    fs::rename(&c, &a, &b).await.expect("rename");
    assert!(fs::stat(&c, &b).await.is_ok());
    assert!(fs::stat(&c, &a).await.is_err());
    fs::delete(&c, std::slice::from_ref(&b)).await.expect("delete");
});

live!(mutations_outside_the_root_are_refused, c, e, {
    c.authorize_root(&e.root);
    assert!(c.authorize_mutation(&path::join(&e.root, "ok.txt")).is_ok());
    assert!(
        c.authorize_mutation("/etc/passwd").is_err(),
        "a path outside the workspace must be refused"
    );
    assert!(
        c.authorize_mutation(&format!("{}/../../etc/passwd", e.root)).is_err(),
        "dot-dot must not escape the workspace"
    );
});

live!(searches_by_filename, c, e, {
    let res = exec::search(&c, &e.root, "main", 50, false).await.expect("search");
    assert!(
        res.hits.iter().any(|h| h.name == "main.rs"),
        "expected main.rs in {:?}",
        res.hits.iter().map(|h| &h.name).collect::<Vec<_>>()
    );
    let hit = res.hits.iter().find(|h| h.name == "main.rs").unwrap();
    assert_eq!(hit.rel, "src/main.rs", "rel must be relative to the root");
});

live!(greps_file_contents, c, e, {
    let res = exec::grep(&c, &e.root, "hello world", 50, true).await.expect("grep");
    assert!(!res.hits.is_empty(), "expected a match");
    let hit = &res.hits[0];
    assert!(hit.rel.ends_with("main.rs"), "got {}", hit.rel);
    assert!(hit.line > 0, "line numbers are 1-based");
    assert!(hit.text.contains("hello world"));
});

live!(greps_a_path_containing_a_colon, c, e, {
    // A colon is legal in a POSIX filename and would break naive splitting.
    let res = exec::grep(&c, &e.root, "hello there", 50, true).await.expect("grep");
    assert!(
        res.hits.iter().any(|h| h.rel.contains("we:ird")),
        "expected the colon-named file, got {:?}",
        res.hits.iter().map(|h| &h.rel).collect::<Vec<_>>()
    );
});

live!(lists_files_and_prunes_dot_git, c, e, {
    let res = exec::list_files(&c, &e.root, 500, Some(8), false).await.expect("list");
    assert!(res.files.iter().any(|f| f.ends_with("src/main.rs")));
    assert!(
        !res.files.iter().any(|f| f.contains("/.git/")),
        ".git must be pruned"
    );
});

live!(globs_by_pattern, c, e, {
    let res = exec::glob(&c, &e.root, "*.rs", 50).await.expect("glob");
    assert!(res.hits.iter().any(|h| h.rel.ends_with("main.rs")));
});

live!(runs_git_on_the_far_side, c, _e, {
    let out = c.exec("git --version").await.expect("git --version");
    assert!(out.ok(), "git should be installed on the test server");
    assert!(out.stdout_text().starts_with("git version"));
});

live!(exec_reports_a_failing_command, c, _e, {
    let out = c.exec("exit 3").await.expect("exec");
    assert_eq!(out.code, 3);
    assert!(!out.ok());
});

live!(exec_separates_stdout_from_stderr, c, _e, {
    let out = c.exec("echo out; echo err 1>&2").await.expect("exec");
    assert_eq!(out.stdout_text().trim(), "out");
    assert_eq!(out.stderr_text().trim(), "err");
});

// --- ProxyJump ------------------------------------------------------------
//
// Set TERAX_TEST_JUMP to a bastion `[user@]host:port`; TERAX_TEST_SSH then
// names a target reachable *only* from that bastion, so a pass proves the
// connection was actually tunnelled rather than made directly.

fn jump_env() -> Option<(Env, String)> {
    let e = env()?;
    let jump = std::env::var("TERAX_TEST_JUMP").ok()?;
    Some((e, jump))
}

#[test]
fn connects_through_a_jump_host() {
    let Some((e, jump)) = jump_env() else {
        eprintln!("skipping: TERAX_TEST_JUMP not set");
        return;
    };
    let (jump_user, jump_host, jump_port) =
        terax_lib::modules::ssh::target::parse_jump(&jump).expect("parse jump");

    let hop = SshTarget {
        host: jump_host,
        port: jump_port,
        user: jump_user.unwrap_or_else(|| e.user.clone()),
        auth: vec![AuthMethod::Password {
            password: Some(e.pass.clone()),
        }],
        term: None,
        cwd: None,
        command: None,
        keepalive_secs: None,
        connect_timeout_secs: Some(15),
        compression: None,
        env: Vec::new(),
        jumps: Vec::new(),
    };
    let target = SshTarget {
        host: e.host.clone(),
        port: Some(e.port),
        user: e.user.clone(),
        auth: vec![AuthMethod::Password {
            password: Some(e.pass.clone()),
        }],
        term: None,
        cwd: None,
        command: None,
        keepalive_secs: None,
        connect_timeout_secs: Some(15),
        compression: None,
        env: Vec::new(),
        jumps: vec![hop],
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let bus = Arc::new(PromptBus::new(Channel::new(|_| Ok(()))));
        let c = RemoteConn::open(&target, &bus)
            .await
            .expect("connect through the jump host");

        // Content that only exists on the far side of the bastion.
        let out = c.exec("cat /config/inner/secret.txt").await.expect("exec");
        assert!(out.ok(), "stderr: {}", out.stderr_text());
        assert_eq!(out.stdout_text().trim(), "behind the bastion");

        // And SFTP works over the tunnel, not just exec.
        let entries = fs::read_dir(&c, "/config/inner", false).await.expect("read_dir");
        assert!(entries.iter().any(|x| x.name == "secret.txt"));
    });
}

#[test]
fn a_direct_connection_to_the_jump_only_target_fails() {
    let Some((e, _)) = jump_env() else {
        eprintln!("skipping: TERAX_TEST_JUMP not set");
        return;
    };
    // Guards the test above: if the target were reachable directly, a pass
    // there would prove nothing about tunnelling.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let target = SshTarget {
            host: e.host.clone(),
            port: Some(e.port),
            user: e.user.clone(),
            auth: vec![AuthMethod::Password {
                password: Some(e.pass.clone()),
            }],
            term: None,
            cwd: None,
            command: None,
            keepalive_secs: None,
            connect_timeout_secs: Some(5),
            compression: None,
            env: Vec::new(),
            jumps: Vec::new(),
        };
        let bus = Arc::new(PromptBus::new(Channel::new(|_| Ok(()))));
        assert!(
            RemoteConn::open(&target, &bus).await.is_err(),
            "the target must not be reachable without the jump host"
        );
    });
}

// --- Local port forwarding ------------------------------------------------
//
// TERAX_TEST_FORWARD_PORT names a port bound to the *remote's* loopback, so it
// is unreachable from this machine except through the tunnel.

live!(forwards_a_local_port_to_the_remote_loopback, c, _e, {
    let Ok(port) = std::env::var("TERAX_TEST_FORWARD_PORT") else {
        eprintln!("skipping: TERAX_TEST_FORWARD_PORT not set");
        return;
    };
    let remote_port: u16 = port.parse().expect("port");

    let tunnels = terax_lib::modules::remote::forward::TunnelState::default();
    let spec = terax_lib::modules::remote::forward::ForwardSpec {
        bind_address: None,
        // 0 asks the OS for a free port, so the test cannot clash with
        // anything already listening here.
        local_port: 0,
        remote_host: "127.0.0.1".into(),
        remote_port,
    };

    let info = terax_lib::modules::remote::forward::open_local(
        &tunnels,
        1,
        std::sync::Arc::new(c),
        &spec,
    )
    .await
    .expect("open forward");

    assert_eq!(info.bind_address, "127.0.0.1", "must default to loopback");
    assert_ne!(info.local_port, 0, "the bound port must be reported back");
    assert_eq!(tunnels.list().len(), 1);

    // Reach the remote-only service through the tunnel.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", info.local_port))
        .await
        .expect("connect through the forward");
    sock.write_all(b"GET / HTTP/1.0\r\n\r\n").await.expect("write");
    // Read until the marker appears rather than to EOF: the remote service
    // holds the connection open, so waiting for EOF would always time out.
    let mut buf = Vec::new();
    let text = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut chunk = [0u8; 1024];
        loop {
            let n = sock.read(&mut chunk).await.expect("read");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let seen = String::from_utf8_lossy(&buf).into_owned();
            if seen.contains("remote service alive") {
                return seen;
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
    .await
    .expect("the forward did not deliver a response in time");
    assert!(
        text.contains("remote service alive"),
        "expected the remote service's response, got {text:?}"
    );

    // Closing must free the listener, not leave it accepting.
    assert!(tunnels.close(info.id).await);
    assert!(tunnels.list().is_empty());
    let after = tokio::net::TcpStream::connect(("127.0.0.1", info.local_port)).await;
    assert!(after.is_err(), "the port must be released on close");
});

live!(a_forward_needs_a_remote_host_and_port, c, _e, {
    let tunnels = terax_lib::modules::remote::forward::TunnelState::default();
    let conn = std::sync::Arc::new(c);
    let bad_host = terax_lib::modules::remote::forward::ForwardSpec {
        bind_address: None,
        local_port: 0,
        remote_host: "  ".into(),
        remote_port: 80,
    };
    assert!(
        terax_lib::modules::remote::forward::open_local(&tunnels, 1, conn.clone(), &bad_host)
            .await
            .is_err()
    );
    let bad_port = terax_lib::modules::remote::forward::ForwardSpec {
        bind_address: None,
        local_port: 0,
        remote_host: "127.0.0.1".into(),
        remote_port: 0,
    };
    assert!(
        terax_lib::modules::remote::forward::open_local(&tunnels, 1, conn, &bad_port)
            .await
            .is_err()
    );
    assert!(tunnels.list().is_empty(), "a rejected spec must not register");
});
