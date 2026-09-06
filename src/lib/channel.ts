/** Release channel this bundle was built for. `preview` marks an unofficial,
 * unsigned side-by-side build that ships with no auto-updater. Resolved from
 * `VITE_TERAX_CHANNEL` at build time, so nothing is checked at runtime. */
export type BuildChannel = "stable" | "preview";

/** Only an exact `preview` selects the preview channel. Every other value,
 * unset included, is stable, so a typo or a dropped environment variable can
 * never silently strip updates out of a release build. */
export function parseChannel(raw: string | undefined): BuildChannel {
  return raw?.trim().toLowerCase() === "preview" ? "preview" : "stable";
}

export const BUILD_CHANNEL = parseChannel(import.meta.env.VITE_TERAX_CHANNEL);

export const IS_PREVIEW_BUILD = BUILD_CHANNEL === "preview";

/** Preview bundles register no updater plugin on the Rust side and strip
 * `plugins.updater` from their Tauri config, so a check would fail at the IPC
 * boundary rather than report "up to date". The UI never asks. */
export const UPDATER_ENABLED = !IS_PREVIEW_BUILD;

export const UPSTREAM_REPO_URL = "https://github.com/crynta/terax-ai";
export const FORK_REPO_URL = "https://github.com/stephenstack/terax-ai";

/** A preview build sends people to the fork that produced it. Upstream cannot
 * triage a bug found in an unofficial build it did not ship. */
export const REPO_URL = IS_PREVIEW_BUILD ? FORK_REPO_URL : UPSTREAM_REPO_URL;

export const REPO_LABEL = REPO_URL.slice("https://github.com/".length);

/** OS keychain service names. A preview is a separate application that
 * happens to share a user account, so it stores its credentials somewhere a
 * stable install will never look, and never reads a stable install's. The Rust
 * side enforces this at the IPC boundary (`secrets::scope_service`); this
 * constant only keeps the request the webview makes coherent with it. */
export const STABLE_KEYRING_SERVICE = "terax-ai";
export const PREVIEW_KEYRING_SERVICE = "terax-ssh-preview";
export const KEYRING_SERVICE = IS_PREVIEW_BUILD
  ? PREVIEW_KEYRING_SERVICE
  : STABLE_KEYRING_SERVICE;

export const PREVIEW_NAME = "Terax SSH Preview";
export const PREVIEW_NOTICE =
  "Unofficial SSH preview from Stephen Stack's fork. Not affiliated with Crynta. Updates are disabled; install a newer preview manually.";
