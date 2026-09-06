import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { openRemoteConnection } from "./connect";
import { usePromptStore } from "./opener";
import type { RemoteProfile } from "./types";

type RemoteWorkspace = {
  profileId: string;
  conn: number;
  /** Remote home, used to seed the explorer root when the profile has no cwd. */
  home: string;
  host: string;
  user: string;
  root: string;
};

type State = {
  /** At most one remote workspace is open at a time, mirroring the fact that
   *  the explorer and source-control panel each show a single root. */
  active: RemoteWorkspace | null;
  connecting: boolean;
  error: string | null;
  open: (profile: RemoteProfile) => Promise<RemoteWorkspace | null>;
  close: () => Promise<void>;
};

export const useRemoteWorkspaceStore = create<State>((set, get) => ({
  active: null,
  connecting: false,
  error: null,

  open: async (profile) => {
    const existing = get().active;
    // Reuse only a connection that is still alive: after a drop the cached
    // entry would be handed back forever and the host could never be reopened.
    if (existing?.profileId === profile.id) {
      const alive = await invoke<boolean>("remote_is_open", {
        id: existing.conn,
      }).catch(() => false);
      if (alive) return existing;
    }
    if (existing) await get().close();

    set({ connecting: true, error: null });
    let conn = 0;

    try {
      const opened = await openRemoteConnection(profile);
      conn = opened.conn;
      const root = await invoke<string>("remote_authorize", {
        conn: opened.conn,
        path: profile.cwd?.trim() || opened.home,
      });
      const workspace: RemoteWorkspace = {
        profileId: profile.id,
        conn: opened.conn,
        home: opened.home,
        host: opened.host,
        user: opened.user,
        root,
      };
      set({ active: workspace, connecting: false, error: null });
      return workspace;
    } catch (e) {
      // Only reachable with a live connection when authorizing failed after
      // the handshake; a failed connect cleans up after itself.
      if (conn) {
        usePromptStore.setState((prev) => ({
          queue: prev.queue.filter(
            (p) => p.scope !== "workspace" || p.sessionId !== conn,
          ),
        }));
        void invoke("remote_close", { id: conn }).catch(() => {});
      }
      set({ connecting: false, error: String(e), active: null });
      return null;
    }
  },

  close: async () => {
    const active = get().active;
    if (!active) return;
    set({ active: null, error: null });
    await invoke("remote_close", { id: active.conn }).catch(() => {});
  },
}));
