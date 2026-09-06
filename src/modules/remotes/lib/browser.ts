import type { DirEntry } from "@/modules/explorer/lib/useFileTree";
import type { WorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";
import { openRemoteConnection } from "./connect";
import type { RemoteProfile } from "./types";
import { useRemoteWorkspaceStore } from "./workspace";

/** Trailing slash only for the root itself, so joins never double up. */
export function joinRemote(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentRemote(dir: string): string | null {
  if (dir === "/" || dir === "") return null;
  const cut = dir.lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : dir.slice(0, cut);
}

type State = {
  profileId: string | null;
  conn: number | null;
  /** True when the connection belongs to the workspace and is only borrowed. */
  borrowed: boolean;
  home: string;
  cwd: string;
  entries: DirEntry[];
  showHidden: boolean;
  connecting: boolean;
  loading: boolean;
  error: string | null;
  open: (profile: RemoteProfile) => Promise<void>;
  close: () => Promise<void>;
  navigate: (dir: string) => Promise<void>;
  refresh: () => Promise<void>;
  authorizeCwd: () => Promise<void>;
  setShowHidden: (value: boolean) => void;
};

function env(conn: number, profileId: string): WorkspaceEnv {
  return { kind: "ssh", conn, profileId };
}

export const useRemoteBrowserStore = create<State>((set, get) => ({
  profileId: null,
  conn: null,
  borrowed: false,
  home: "",
  cwd: "",
  entries: [],
  showHidden: false,
  connecting: false,
  loading: false,
  error: null,

  open: async (profile) => {
    const current = get();
    if (current.profileId === profile.id && current.conn !== null) {
      const alive = await invoke<boolean>("remote_is_open", {
        id: current.conn,
      }).catch(() => false);
      if (alive) return;
    }
    if (current.conn !== null) await get().close();

    set({ connecting: true, error: null, profileId: profile.id });
    try {
      // The workspace already holds a connection to this host; a second one
      // would cost another handshake and, on a password host, another prompt.
      const workspace = useRemoteWorkspaceStore.getState().active;
      const reuse =
        workspace?.profileId === profile.id &&
        (await invoke<boolean>("remote_is_open", { id: workspace.conn }).catch(
          () => false,
        ));

      const opened = reuse
        ? { conn: workspace.conn, home: workspace.home }
        : await openRemoteConnection(profile);

      const start = profile.cwd?.trim() || opened.home;
      set({
        conn: opened.conn,
        borrowed: !!reuse,
        home: opened.home,
        connecting: false,
        error: null,
      });
      await get().navigate(start);
    } catch (e) {
      set({
        connecting: false,
        error: String(e),
        profileId: null,
        conn: null,
        entries: [],
      });
    }
  },

  close: async () => {
    const { conn, borrowed } = get();
    set({
      profileId: null,
      conn: null,
      borrowed: false,
      home: "",
      cwd: "",
      entries: [],
      error: null,
    });
    // Never close a connection the workspace is still using.
    if (conn !== null && !borrowed) {
      await invoke("remote_close", { id: conn }).catch(() => {});
    }
  },

  navigate: async (dir) => {
    const { conn, profileId } = get();
    if (conn === null || !profileId) return;
    set({ loading: true, error: null });
    try {
      const entries = await invoke<DirEntry[]>("fs_read_dir", {
        path: dir,
        showHidden: get().showHidden,
        gitDecorations: false,
        workspace: env(conn, profileId),
      });
      set({ cwd: dir, entries, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  refresh: async () => {
    const { cwd } = get();
    if (cwd) await get().navigate(cwd);
  },

  /**
   * Reads are unrestricted but writes are confined to the roots a connection
   * has been given, and browsing is not itself a reason to widen them. This
   * runs on an explicit create, rename or delete, which is the user asking for
   * this directory the same way opening it as a workspace would.
   */
  authorizeCwd: async () => {
    const { conn, cwd } = get();
    if (conn === null || !cwd) return;
    await invoke("remote_authorize", { conn, path: cwd });
  },

  setShowHidden: (value) => {
    set({ showHidden: value });
    void get().refresh();
  },
}));

/** The env the panel's own actions run against, never the app's current one. */
export function browserEnv(): WorkspaceEnv | null {
  const { conn, profileId } = useRemoteBrowserStore.getState();
  return conn !== null && profileId ? env(conn, profileId) : null;
}

/**
 * Walk the browser to wherever the terminal is standing, so a cd moves the
 * tree and the git section with it. Only when the preference asks for it: the
 * alternative is browsing somewhere and having it yanked back on the next
 * prompt.
 *
 * The cwd is only known when the host's shell emits OSC 7. Nothing happens on
 * a host that does not, which is why this cannot be the only way to navigate.
 */
export function useFollowTerminal(terminalCwd: string | undefined): void {
  const follow = usePreferencesStore((s) => s.remoteFollowTerminal);
  const conn = useRemoteBrowserStore((s) => s.conn);
  const cwd = useRemoteBrowserStore((s) => s.cwd);

  useEffect(() => {
    if (!follow || conn === null) return;
    if (!terminalCwd || terminalCwd === cwd) return;
    void useRemoteBrowserStore.getState().navigate(terminalCwd);
  }, [follow, conn, cwd, terminalCwd]);
}
