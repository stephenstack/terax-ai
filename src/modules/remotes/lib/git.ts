import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { browserEnv, useRemoteBrowserStore } from "./browser";

export type RemoteGitFile = {
  path: string;
  statusLabel: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

export type RemoteGitSnapshot = {
  repo: { repoRoot: string; branch: string; upstream: string | null; isDetached: boolean } | null;
  status: {
    repoRoot: string;
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    changedFiles: RemoteGitFile[];
  } | null;
};

type State = {
  /** The directory the snapshot describes, so a stale reply can be dropped. */
  cwd: string | null;
  snapshot: RemoteGitSnapshot | null;
  loading: boolean;
  /** Label of the action in flight, which also disables the others. */
  busy: string | null;
  error: string | null;
  refresh: (cwd: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
};

async function authorize(cwd: string): Promise<void> {
  const { conn, borrowed } = useRemoteBrowserStore.getState();
  // Reading git status needs the directory authorized on the connection. On a
  // borrowed one that would widen what the workspace, and so the AI tools,
  // may write to, so only the browser's own connection is opened up this way.
  if (conn === null || borrowed) return;
  await invoke("remote_authorize", { conn, path: cwd }).catch(() => undefined);
}

export const useRemoteGitStore = create<State>((set, get) => ({
  cwd: null,
  snapshot: null,
  loading: false,
  busy: null,
  error: null,

  refresh: async (cwd) => {
    const env = browserEnv();
    if (!env) {
      set({ cwd: null, snapshot: null, error: null });
      return;
    }
    set({ loading: true, error: null });
    await authorize(cwd);
    try {
      const snapshot = await invoke<RemoteGitSnapshot>("git_panel_snapshot", {
        cwd,
        workspace: env,
      });
      // The user may have moved on while this was in flight.
      if (useRemoteBrowserStore.getState().cwd !== cwd) return;
      set({ cwd, snapshot, loading: false, error: null });
    } catch (e) {
      if (useRemoteBrowserStore.getState().cwd !== cwd) return;
      set({ cwd, snapshot: null, loading: false, error: String(e) });
    }
  },

  commit: async (message) => {
    const env = browserEnv();
    const root = get().snapshot?.status?.repoRoot;
    if (!env || !root) return;
    const files = get().snapshot?.status?.changedFiles ?? [];
    if (files.length === 0) return;
    set({ busy: "Committing", error: null });
    try {
      // `git commit` takes what is staged, so everything listed is staged
      // first. The button says how many, so nothing is swept in unseen.
      await invoke("git_stage", {
        repoRoot: root,
        paths: files.map((f) => f.path),
        workspace: env,
      });
      await invoke("git_commit", {
        repoRoot: root,
        message,
        workspace: env,
      });
      set({ busy: null });
    } catch (e) {
      set({ busy: null, error: String(e) });
    }
    const cwd = get().cwd;
    if (cwd) await get().refresh(cwd);
  },

  fetch: async () => {
    await run(set, get, "Fetching", "git_fetch");
  },

  pull: async () => {
    await run(set, get, "Pulling", "git_pull_ff_only");
  },

  push: async () => {
    await run(set, get, "Pushing", "git_push");
  },
}));

async function run(
  set: (partial: Partial<State>) => void,
  get: () => State,
  label: string,
  command: string,
): Promise<void> {
  const env = browserEnv();
  const root = get().snapshot?.status?.repoRoot;
  if (!env || !root) return;
  set({ busy: label, error: null });
  try {
    await invoke(command, { repoRoot: root, workspace: env });
    set({ busy: null });
  } catch (e) {
    set({ busy: null, error: String(e) });
  }
  const cwd = get().cwd;
  if (cwd) await get().refresh(cwd);
}
