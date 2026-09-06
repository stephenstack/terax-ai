# SSH and remote workspaces

Terax can open a terminal on another machine, and can point the file explorer,
editor, search and source control at a directory there.

## Hosts

The **Remotes** panel is the third tab in the sidebar rail. A host is a saved
profile: address, user, authentication, and whatever session and appearance
options you want for it. Hosts can be put in groups, and a group can be
collapsed.

Right-click a host for:

- **Open terminal** - a tab whose panes are SSH sessions on that host.
- **Open as workspace** - point the explorer, editor and git panel at it.
- **Port forwards** - start or stop any forward configured for that host.

Nothing connects until you ask it to.

### Importing what you already have

**Import from ~/.ssh/config** reads your OpenSSH config and offers every host
in it. The file is only ever read, never written. Wildcard blocks such as
`Host *` are applied as defaults rather than imported as hosts, and resolution
follows OpenSSH's first-obtained-value-wins rule, so what you get should match
what `ssh` would do. `IdentityFile`, `ProxyJump`, `User`, `Port`,
`ConnectTimeout`, `ServerAliveInterval` and `Compression` come across. A host
with no `User` inherits your local username, as `ssh` does.

## Authentication

Methods are tried in the order you list them, like
`PreferredAuthentications`:

- **SSH agent** - the running agent's keys, in the agent's own order. The
  editor shows how many identities it can see, so you know before you connect.
  On Windows both the built-in OpenSSH agent (named pipe) and PuTTY's Pageant
  are supported, OpenSSH first.
- **Key file** - a private key on disk. Keys in `~/.ssh` are offered by name,
  and one that is encrypted is labelled as such. You are asked for the
  passphrase only if the key actually needs one.
- **Password**
- **Keyboard interactive** - for servers that ask their own questions,
  including most one-time-password setups.

**Passwords and passphrases are never stored in a profile.** You are asked when
a connection needs one. Cancelling that prompt aborts the connection; it does
not submit an empty answer.

## Host keys

Checked against `~/.ssh/known_hosts` exactly as `ssh` does, including hashed
host names and per-port entries.

- **Known and matching** - connects without asking.
- **Unknown** - you are shown the fingerprint and asked. *Accept once* trusts
  it for this connection only; *Accept and remember* records it.
- **Changed** - the key does not match what is recorded. This happens after a
  legitimate server rebuild, and it is also exactly what a
  machine-in-the-middle looks like. It is never accepted automatically, and
  closing the dialog is a refusal. Accepting a replacement removes the
  superseded entry, so the decision sticks instead of warning again next time.

Server certificates are refused: Terax has no CA trust configuration yet, and
accepting an identity it cannot verify would be worse than failing.

## Jump hosts

Set **Jump hosts** on a profile, one per line as `[user@]host[:port]`, nearest
bastion first. This is `ProxyJump`: Terax connects to the bastion, opens a
channel from it to the next hop, and runs the next SSH session over that
channel. Each hop is authenticated in its own right.

A bastion has to permit it. If yours has `AllowTcpForwarding no` in its
`sshd_config`, the connection is refused and Terax says so.

## Port forwards

Configured per host on the **Tunnels** tab, started from the panel. A forward
is `ssh -L`: a socket on your machine whose traffic is carried over the SSH
connection and connected from the far side. That is what lets you reach a
service bound to the server's *own* loopback, such as a dev server or a
database that is deliberately not exposed.

- The remote host is resolved **on the server**, so `localhost` there means
  the server's loopback, not yours.
- Leave the local port empty to let the OS choose one; the port actually bound
  is reported when the forward starts.
- The bind address defaults to `127.0.0.1`. Anything else exposes the remote
  service to your whole network.
- Forwards need the host open as a workspace, since they ride on that
  connection, and they stop when it closes.

Remote forwards (`ssh -R`) are not implemented.

## Remote workspaces

**Open as workspace** connects and points the explorer, editor, fuzzy finder,
content search and source control at a directory on that host. The status bar
shows which environment you are in and is how you get back to local.

Files are read and written over SFTP. Search, content search and git run as
commands on the server, because walking a large tree over per-directory SFTP
round trips is unusably slow. Only POSIX features are used, so a minimal
server (BusyBox, an Alpine container) works without installing anything.

What differs from a local workspace:

- **No file watching.** SFTP has no change notification, so the explorer does
  not update by itself when something changes on the server outside Terax.
  Your own actions refresh it.
- **No git decorations in the explorer.** That would cost a `git status` per
  directory listing. The source-control panel covers the same ground.
- **No LSP.** Language servers still run locally, so they are not offered for
  a remote workspace.
- **Mutations are confined** to the directory you opened. A path outside it is
  refused, and `..` cannot be used to get around that.

## Per-host appearance

A profile can override the terminal font, size, weight, letter spacing, cursor
and scrollback. Leave a field empty to follow your global settings.

One thing to know: the terminal renderer keeps a single shared configuration
across its pooled panes rather than per-pane state. A host's overrides
therefore apply while one of its panes is the active one, and the global
settings come back when you focus something else.

## Testing against a real server

`src-tauri/tests/remote_sftp.rs` runs the real code against a real SSH server.
It is skipped unless configured, so it does not affect CI or an offline run:

```sh
TERAX_TEST_SSH=127.0.0.1:2222 \
TERAX_TEST_SSH_USER=me \
TERAX_TEST_SSH_PASS=secret \
TERAX_TEST_SSH_ROOT=/srv/project \
cargo test --test remote_sftp -- --test-threads=2
```

The host must already be in `known_hosts`, or the connect will block waiting
for a trust prompt that a test cannot answer.

Optional:

- `TERAX_TEST_JUMP=[user@]host:port` enables the ProxyJump tests. Point
  `TERAX_TEST_SSH` at a host reachable *only* through that bastion, or the
  paired guard test cannot prove anything about tunnelling.
- `TERAX_TEST_FORWARD_PORT` enables the forwarding test. It should name a port
  bound to the server's own loopback.

An unconfigured run is not a passing run. The `live!` macro returns early when
`TERAX_TEST_SSH` is unset, and a test that returns early reports `ok`, so all
21 of these count as passing in a normal `cargo test` while touching nothing.
Treat a green suite as covering the remote code only when the variables above
were actually set.

### The fixture the tests expect

The assertions name specific content, so a server seeded differently fails in
ways that look like defects. Under `TERAX_TEST_SSH_ROOT`:

- `src/main.rs` containing `hello world`, and a second file whose *path*
  contains `we:ird` containing `hello there`. Together they check that a
  colon in a filename does not break the grep parsing.
- At least one tracked file with an uncommitted modification, or the remote
  `git status` assertion has nothing to find. The root itself must be a git
  repo, owned by the SSH user: a repo owned by someone else trips git's
  `dubious ownership` guard and the resolve fails.
- A dotfile and a dot-directory, so the hidden-file filter has something to
  hide.

`TERAX_TEST_FORWARD_PORT` must name a *real* server on the remote loopback
that reads the request before replying, and its body must contain
`remote service alive`. A one-shot `nc` responder is not good enough: it exits
with the request still unread, and the resulting RST surfaces as a
`ConnectionReset` that reads exactly like a broken tunnel.

The server must also permit forwarding. `linuxserver/openssh-server` ships
`AllowTcpForwarding no`, which fails the forwarding test identically to a real
bug. If it fails, confirm the server first with `ssh -L` before suspecting
this code.

For the ProxyJump tests, the far host must be reachable only through the
bastion. Putting the test runner on the same private network defeats the
paired guard test, which proves tunnelling by requiring that a *direct*
connection fails. Resolve the far host's name on the bastion's side, and seed
`known_hosts` with both hosts' keys.
