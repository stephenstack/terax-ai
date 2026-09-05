import type { TerminalAppearanceOverride } from "@/modules/terminal";

/**
 * Auth methods are tried in the order they appear on a profile, mirroring
 * `ssh -o PreferredAuthentications`. Secrets never live here: a password or
 * key passphrase is either prompted for at connect time or read from the OS
 * keychain by id.
 */
export type RemoteAuthMethod =
  | { kind: "agent" }
  | { kind: "keyFile"; path: string }
  | { kind: "password" }
  | { kind: "keyboardInteractive" };

export type RemoteAuthKind = RemoteAuthMethod["kind"];

/**
 * Per-profile terminal overrides. Every field is optional and falls back to
 * the global preference, so a profile only stores what it actually changes.
 * Defined by the terminal module, which is what consumes it.
 */
export type RemoteAppearance = TerminalAppearanceOverride;

export type RemoteProfile = {
  id: string;
  name: string;
  /** Group membership, or null for an ungrouped host. */
  groupId: string | null;
  host: string;
  /** null means the SSH default (22). */
  port: number | null;
  user: string;
  auth: RemoteAuthMethod[];
  term?: string;
  /** Directory to enter once the remote shell is live. */
  cwd?: string;
  /** Run instead of the login shell. */
  command?: string;
  keepaliveSecs?: number;
  connectTimeoutSecs?: number;
  compression?: boolean;
  env: Array<[string, string]>;
  appearance: RemoteAppearance;
  /** Accent used by the panel and tab, matching the spaces colour vocabulary. */
  color?: string;
  createdAt: number;
  updatedAt: number;
};

export type RemoteGroup = {
  id: string;
  name: string;
  color?: string;
  collapsed: boolean;
  /** Explicit ordering so groups keep the arrangement the user chose. */
  order: number;
};

/** Shape sent to `ssh_open`; mirrors the Rust `SshTarget`. */
export type SshTarget = {
  host: string;
  port: number | null;
  user: string;
  auth: Array<
    | { kind: "agent" }
    | { kind: "keyFile"; path: string; passphrase?: string }
    | { kind: "password"; password?: string }
    | { kind: "keyboardInteractive" }
  >;
  term?: string;
  cwd?: string;
  command?: string;
  keepaliveSecs?: number;
  connectTimeoutSecs?: number;
  compression?: boolean;
  env: Array<[string, string]>;
};

export type HostKeyStatus = "trusted" | "unknown" | "changed";

/** Structured events from the Rust connect task. */
export type SshEvent =
  | { type: "phase"; phase: "connecting" | "authenticating" | "opening" }
  | {
      type: "hostKey";
      promptId: number;
      host: string;
      port: number;
      fingerprint: string;
      algorithm: string;
      status: HostKeyStatus;
      conflictLine: number | null;
    }
  | {
      type: "authPrompt";
      promptId: number;
      kind: "password" | "passphrase" | "keyboard-interactive";
      prompt: string;
      echo: boolean;
      instructions: string | null;
    }
  | { type: "banner"; text: string }
  | { type: "error"; message: string }
  | { type: "ready" };

export type DiscoveredKey = {
  path: string;
  name: string;
  encrypted: boolean;
};

export type SshConfigHost = {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  identity_files: string[];
  proxy_jump: string | null;
  forward_agent: boolean | null;
  identities_only: boolean | null;
  connect_timeout: number | null;
  server_alive_interval: number | null;
  compression: boolean | null;
};

export const DEFAULT_SSH_PORT = 22;
