# Terax SSH Preview (unofficial)

An unsigned Windows preview build of Terax, published from Stephen Stack's fork
so the SSH remote sessions and remote workspaces work can be tested on real
machines before it lands upstream.

This build is **not affiliated with, endorsed by, or supported by Crynta**, and
it is not the official Terax. It carries its own application identity so it
installs beside a stable Terax rather than replacing it:

| | |
| --- | --- |
| Application name | Terax SSH Preview |
| Identifier | `io.github.stephenstack.terax.sshpreview` |
| Version | `0.8.6-ssh.1` |
| Git tag | `preview-v0.8.6-ssh.1` |
| Platform | Windows x64 only |
| Installer | NSIS `.exe`, per-user (no administrator rights) |
| Code signing | none |
| Auto-update | disabled, permanently |
| Keychain service | `terax-ssh-preview` (stable uses `terax-ai`) |

The stable app uses the identifier `app.crynta.terax`. The two never share an
install directory, Start Menu entry, settings store, session store, OS keychain
namespace, or remote host list.

## What is included

Everything in Terax 0.8.6, plus the SSH work this preview exists to exercise:

- **SSH remote sessions.** Interactive PTY sessions over `russh`, driven through
  the same terminal surface as a local shell. Host profiles with groups, agent /
  public key / password / keyboard-interactive authentication, `known_hosts`
  verification with trust-on-first-use prompts, per-host session and appearance
  options, and import from `~/.ssh/config`.
- **Remote workspaces.** The file explorer, editor, fuzzy find, content search
  and source control panel pointed at a directory on another machine over SFTP.
  Git runs on the far side, not locally.
- **Jump hosts.** `ProxyJump` chains up to 8 hops, each opened as a
  `direct-tcpip` channel on the previous bastion.
- **Local port forwarding.** `ssh -L` style forwards, bound to `127.0.0.1` by
  default, torn down with their connection.
- **AI agent over SSH.** The agent's `run_command` and shell tools execute on
  the connected remote host when a remote workspace is active.

## What is experimental

Treat all of the following as unproven on anything but the maintainer's own
machines:

- The whole SSH and remote-workspace surface. It has unit tests plus a live
  test suite (`src-tauri/tests/remote_sftp.rs`, opt-in via `TERAX_TEST_SSH`),
  but far less real-world exposure than the local terminal.
- Behaviour against minimal servers (BusyBox, Alpine, embedded devices, network
  appliances) and against non-OpenSSH servers.
- Long-lived connections across sleep, VPN changes, and flaky links.
- Remote git on large repositories, where every operation is a round trip.
- Per-host appearance overrides when several remote tabs are open at once.

## Installation

1. Download `Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe` and the matching
   `.sha256` file from the release page.
2. Verify the checksum before running anything. See below.
3. Run the installer. It installs per-user under
   `%LOCALAPPDATA%\Terax SSH Preview` and needs no administrator rights.
4. Launch **Terax SSH Preview** from the Start Menu. The About panel in Settings
   shows the channel as `Preview (unofficial, no updates)` and the identifier as
   `io.github.stephenstack.terax.sshpreview`. If it shows anything else, you are
   running the stable app.

To uninstall, use Apps and Features and remove **Terax SSH Preview**. That
leaves a stable Terax install untouched.

## Verifying the download

The expected SHA256 is printed in the release notes and stored alongside the
installer as `Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe.sha256`.

PowerShell:

```powershell
Get-FileHash .\Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe -Algorithm SHA256
```

Compare the printed `Hash` against the value in the release notes. Casing does
not matter. To compare automatically instead of by eye:

```powershell
$expected = (Get-Content .\Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe.sha256).Split(" ")[0]
$actual = (Get-FileHash .\Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe -Algorithm SHA256).Hash
if ($actual -ieq $expected) { "OK" } else { "MISMATCH - do not run this file" }
```

Command Prompt, without PowerShell:

```bat
certutil -hashfile Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe SHA256
```

Git Bash or WSL, verifying against the published file directly:

```bash
sha256sum -c Terax-SSH-Preview_0.8.6-ssh.1_x64-setup.exe.sha256
```

If the hashes do not match, delete the file and do not run it.

## Credentials are not shared with stable Terax

This build does not import anything from a stable Terax install, and cannot read
what that install has stored. **You will need to enter your API keys again.**

The two builds use different OS keychain services:

| Build | Keychain service |
| --- | --- |
| Terax (stable) | `terax-ai` |
| Terax SSH Preview | `terax-ssh-preview` |

This is deliberate, not an oversight. An unofficial build compiled from a fork
should not be able to read the credentials you gave the official application,
and keys you enter into an experimental build should not leak back into it. The
separation is enforced in Rust at the IPC boundary
(`secrets::scope_service`), not merely by the frontend asking politely for a
different name, so it holds for every read, write, batch read and delete, and
for any secret helper added later.

SSH passwords and private-key passphrases are never stored by either build. They
are prompted for on every connection, so there is nothing to migrate. Your
`~/.ssh` directory, `~/.ssh/config` and `known_hosts` are ordinary files owned
by you and are shared by both builds, exactly as they are with OpenSSH itself.

To remove this build's credentials without touching a stable install, uninstall
it and delete any `terax-ssh-preview` entries from Windows Credential Manager
(Control Panel, then Credential Manager, then Windows Credentials).

## The SmartScreen warning

This installer is unsigned, so Windows will warn about it. That warning is
expected and is not evidence that the file is safe or unsafe; the checksum above
is the only thing that tells you the file is the one that was built.

You will see **"Windows protected your PC"** with **"Microsoft Defender
SmartScreen prevented an unrecognized app from starting"**. To proceed:

1. Click **More info**.
2. Confirm the publisher line reads `Unknown publisher`, which is expected for
   an unsigned build.
3. Click **Run anyway**.

Your browser may also warn on download ("is not commonly downloaded" or "can't
be downloaded securely") and require you to keep the file explicitly.

If you are not comfortable bypassing SmartScreen, do not install this build.
Build it yourself from source instead:

```powershell
$env:TERAX_CHANNEL = "preview"
$env:VITE_TERAX_CHANNEL = "preview"
pnpm install --frozen-lockfile
pnpm tauri build --config src-tauri/tauri.preview.conf.json
```

## Basic SSH testing steps

A short pass that exercises the parts most likely to break. Use a throwaway
server, not production infrastructure.

1. **Add a host.** Open the Remotes panel in the activity bar, add a host with
   its address, user and authentication method. Alternatively use **Import from
   `~/.ssh/config`** and pick a host you already have.
2. **First connect.** Open the host. You should get a host key prompt saying the
   key is unknown. Accept it, and confirm the session opens and the shell
   prompt is live. Type `hostname` and `whoami` and check they report the
   remote machine, not yours.
3. **Host key re-check.** Close the tab and reconnect. There should be no second
   prompt, because the key is now in `~/.ssh/known_hosts`.
4. **Interactivity.** Run something full-screen (`htop`, `vim`, `less`), resize
   the window, and confirm the remote program redraws at the new size. Press
   Ctrl-C during a `sleep 30` and confirm it interrupts.
5. **Multiple panes.** Split the tab. Every pane in a remote tab is its own
   session against the same host. Confirm both are independently usable.
6. **Remote workspace.** Switch the workspace to the remote host and open a
   directory. Check that the file tree lists remote files, that opening and
   saving a file works, and that fuzzy find (Ctrl-P) and content search return
   remote results.
7. **Remote git.** Point the workspace at a git repository on the remote. Check
   the source control panel shows the remote repository's status, that a diff
   renders, and that staging and committing work. Confirm with `git log` in the
   remote terminal.
8. **Jump host.** If you have a bastion, configure it as a jump host on a
   profile whose target is not reachable directly, and confirm the session
   opens.
9. **Port forward.** Add a local forward to a service on the remote's loopback
   (for example `8080` to `127.0.0.1:8080`) and open `http://127.0.0.1:8080`
   locally. Close the forward and confirm the port is released.
10. **Updater.** Open Settings and then About. The update button must be
    disabled and read "Updates disabled in preview builds". If it offers an
    update, that is a bug worth reporting immediately.

## Known limitations

- **Windows x64 only.** No macOS, Linux, or arm64 build is published for this
  preview.
- **No auto-update.** Nothing in this build checks for updates. To move to a
  newer preview, download and run the newer installer.
- **Unsigned.** SmartScreen warns on every fresh install.
- **Remote file watching does not exist.** SFTP has no change notification, so
  the explorer does not react to files changed by something else on the remote.
  Refresh manually.
- **Remote port forwarding (`ssh -R`) is not implemented.** Only local
  forwarding (`ssh -L`) works.
- **Server certificates are refused.** Certificate authority trust is not
  configurable, so a host presenting a CA-signed certificate cannot connect.
- **Passwords and passphrases are never stored.** They are prompted for on every
  connection by design.
- **WSL workspaces are excluded from language server support.**
- **Session ids are not PTY ids.** Local shell features that depend on a real
  foreground process group (such as close guards for a running command) do not
  apply to remote panes.
- **Credentials are not imported from stable Terax, by design.** You must enter
  your API keys again in this build. See "Credentials are not shared" below.
- **Only one build should hold the CLI at a time.** The preview writes its
  control descriptor to a preview-specific directory
  (`%LOCALAPPDATA%\terax-ssh-preview`) rather than the stable one, so running
  both at once is safe, but the `terax` shell alias inside each app targets that
  app only.

## Security warning

Read this before pointing the build at anything you care about.

- **This is an unofficial build from a fork.** It was compiled by Stephen Stack,
  not by Crynta, and it is not signed by anyone. The only integrity check
  available to you is the SHA256 above, published in the same place as the
  file. That proves the file matches what the workflow produced; it does not
  prove anything about who produced it. If that is not enough assurance for
  your environment, build from source.
- **It handles credentials.** The app talks to your SSH agent, reads your
  private key files and `~/.ssh/config`, prompts for passwords and passphrases,
  and writes accepted host keys into `~/.ssh/known_hosts`.
- **Use throwaway or non-production hosts.** Preview software with full shell,
  filesystem and git access on a remote machine can lose work. Test against
  hosts and repositories you can afford to break, and make sure anything on
  them is backed up or already pushed.
- **Accepting a changed host key is a real decision.** If Terax warns that a
  host key changed, that is the same warning OpenSSH gives, and it can mean a
  machine-in-the-middle. Do not accept it unless you know why the key changed.
- **The AI agent can run commands on the remote host.** When a remote workspace
  is active, approving a command approves it on that machine. Read the approval
  cards before accepting them.
- **BYOK keys live in this build's own OS keychain namespace**, never a stable
  install's. That isolation runs both ways: an unofficial build cannot read
  credentials you gave the official app, and credentials you give this build do
  not leak into it.
- If you find a security problem in Terax itself rather than in this preview
  packaging, follow the upstream process in [SECURITY.md](../SECURITY.md)
  rather than opening a public issue.

## How to report problems

Report against **this fork**, not upstream. Problems reproduced in an unofficial
build are not upstream's to triage until someone confirms them on a stable
release.

Open an issue at <https://github.com/stephenstack/terax-ai/issues> and include:

1. The exact version string from Settings and then About (`0.8.6-ssh.1`) and the
   identifier shown there.
2. Windows version (`winver`).
3. Remote server operating system and SSH server version
   (`ssh -V` on the remote, or the banner Terax prints on connect).
4. Authentication method used (agent, key, password, keyboard-interactive).
5. Whether a jump host or port forward was involved.
6. What you did, what you expected, what happened.
7. Logs. The preview writes to
   `%LOCALAPPDATA%\io.github.stephenstack.terax.sshpreview\logs`. Redact
   hostnames, usernames and anything else you do not want public before
   attaching them.

Never paste a private key, password, passphrase, or API key into an issue.

If the same problem reproduces on an official stable Terax release, say so, and
report it upstream at <https://github.com/crynta/terax-ai/issues> instead.

## How the updater is disabled

Three independent layers, so no single edit can quietly turn updates back on.
The details are in `docs/architecture/two-process-model.md` terms:

1. **Configuration.** `src-tauri/tauri.preview.conf.json` sets
   `"plugins": { "updater": null }`. Tauri merges configuration with JSON Merge
   Patch (RFC 7396), where a `null` deletes the key, so the built bundle carries
   no updater endpoint and no public key at all. It also sets
   `createUpdaterArtifacts: false`, so no `.sig` files and no `latest.json` are
   produced that a stable install could ever consume.
2. **Rust.** `src-tauri/build.rs` bakes `TERAX_CHANNEL` into the binary, and
   `modules::channel` gates plugin registration on it. On a preview build
   `tauri_plugin_updater` is never registered, so the updater commands do not
   exist at the IPC boundary. This is also required rather than merely tidy: the
   plugin's config type requires `pubkey`, so registering it against a stripped
   config would fail startup.
3. **Frontend.** `src/lib/channel.ts` resolves `VITE_TERAX_CHANNEL` at build
   time. `useUpdater` reports a `disabled` status and never calls `check()`,
   `UpdaterDialog` renders nothing, and the About panel disables the update
   button.

Only an exact value of `preview` selects the preview channel on either side. Any
other value, unset included, builds a normal stable app with updates on, so a
typo can never silently ship a release that cannot update itself.

The build workflow (`.github/workflows/preview-ssh.yml`) asserts all of this
after building: it fails if any `.sig` or `latest.json` was produced, and it
searches the compiled binary for the production updater endpoint and minisign
public key and fails if either is present.
