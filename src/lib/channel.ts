/** Release channel this bundle was built for. `preview` marks an unofficial,
 * unsigned side-by-side build that ships with no auto-updater and keeps its own
 * OS keychain namespace. Resolved from `VITE_TERAX_CHANNEL` at build time, so
 * nothing is checked at runtime. */
export type BuildChannel = "stable" | "preview";

/** Only an exact `preview` selects the preview channel. Every other value,
 * unset included, is stable, so a typo or a dropped environment variable can
 * never silently strip updates out of a release build. */
export function parseChannel(raw: string | undefined): BuildChannel {
  return raw?.trim().toLowerCase() === "preview" ? "preview" : "stable";
}

/** Preview bundles register no updater plugin on the Rust side and strip
 * `plugins.updater` from their Tauri config, so a check would fail at the IPC
 * boundary rather than report "up to date". The UI never asks. */
export function updaterEnabledFor(channel: BuildChannel): boolean {
  return channel !== "preview";
}

export const STABLE_KEYRING_SERVICE = "terax-ai";
export const PREVIEW_KEYRING_SERVICE = "terax-ssh-preview";

/** OS keychain service. A preview is a separate application that happens to
 * share a user account, so it stores credentials somewhere a stable install
 * will never look, and never reads a stable install's. The Rust side enforces
 * this at the IPC boundary (`secrets::scope_service`); this only keeps the
 * request the webview makes coherent with it. */
export function keyringServiceFor(channel: BuildChannel): string {
  return channel === "preview"
    ? PREVIEW_KEYRING_SERVICE
    : STABLE_KEYRING_SERVICE;
}

export const UPSTREAM_REPO_URL = "https://github.com/crynta/terax-ai";
export const FORK_REPO_URL = "https://github.com/stephenstack/terax-ai";

/** A preview build sends people to the fork that produced it. Upstream cannot
 * triage a bug found in an unofficial build it did not ship. */
export function repoUrlFor(channel: BuildChannel): string {
  return channel === "preview" ? FORK_REPO_URL : UPSTREAM_REPO_URL;
}

// Everything below is one application of the resolvers above to the channel
// this bundle was compiled for. Keep the rules in the functions, so they stay
// testable without reaching for the build environment.

export const BUILD_CHANNEL = parseChannel(import.meta.env.VITE_TERAX_CHANNEL);

export const IS_PREVIEW_BUILD = BUILD_CHANNEL === "preview";

export const UPDATER_ENABLED = updaterEnabledFor(BUILD_CHANNEL);

export const KEYRING_SERVICE = keyringServiceFor(BUILD_CHANNEL);

export const REPO_URL = repoUrlFor(BUILD_CHANNEL);

export const REPO_LABEL = REPO_URL.slice("https://github.com/".length);

export const PREVIEW_NAME = "Terax SSH Preview";
export const PREVIEW_NOTICE =
  "Unofficial SSH preview from Stephen Stack's fork. Not affiliated with Crynta. Updates are disabled; install a newer preview manually.";
