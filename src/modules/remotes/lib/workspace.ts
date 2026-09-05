import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { WorkspaceEnv } from "@/modules/workspace";
import { promptKey, usePromptStore } from "./opener";
import { profileToTarget } from "./target";
import { findProfile } from "./store";
import type { RemoteProfile, SshEvent } from "./types";

type RemoteOpened = {
  conn: number;
  home: string;
  host: string;
  user: string;
};

export type RemoteWorkspace = {
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
    if (existing?.profileId === profile.id) return existing;
    if (existing) await get().close();

    set({ connecting: true, error: null });

    const onEvent = new Channel<SshEvent>();
    let conn = 0;
    onEvent.onmessage = (event) => {
      const s = usePromptStore.getState();
      if (event.type === "hostKey" && event.status !== "trusted") {
        s.push({
          kind: "hostKey",
          sessionId: conn,
          promptId: event.promptId,
          host: event.host,
          port: event.port,
          fingerprint: event.fingerprint,
          algorithm: event.algorithm,
          status: event.status,
          conflictLine: event.conflictLine,
          profileName: profile.name || profile.host,
          // Workspace prompts are answered on a different command than
          // terminal ones, because they live in a different connection pool.
          scope: "workspace",
        });
      } else if (event.type === "authPrompt") {
        s.push({
          kind: "auth",
          sessionId: conn,
          promptId: event.promptId,
          authKind: event.kind,
          prompt: event.prompt,
          echo: event.echo,
          instructions: event.instructions,
          profileName: profile.name || profile.host,
          scope: "workspace",
        });
      }
    };

    try {
      conn = await invoke<number>("remote_reserve");
      const opened = await invoke<RemoteOpened>("remote_open", {
        id: conn,
        target: profileToTarget(profile),
        onEvent,
      });
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
      // Drop any prompt still queued against this attempt.
      usePromptStore.setState((prev) => ({
        queue: prev.queue.filter((p) => p.sessionId !== conn),
      }));
      void invoke("remote_close", { id: conn }).catch(() => {});
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

/** The workspace env for the open remote workspace, or null when there is none. */
export function remoteWorkspaceEnv(): WorkspaceEnv | null {
  const active = useRemoteWorkspaceStore.getState().active;
  if (!active) return null;
  return { kind: "ssh", conn: active.conn, profileId: active.profileId };
}

export function closeAllRemoteWorkspaces(): Promise<number> {
  return invoke<number>("remote_close_all");
}

/** Re-resolve a profile at connect time so an edit since opening is picked up. */
export function currentProfile(id: string): RemoteProfile | undefined {
  return findProfile(id);
}

export { promptKey };
