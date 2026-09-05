import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ActiveForward, RemoteForward } from "./types";

type State = {
  /** Forwards currently listening, keyed by the backend's tunnel id. */
  active: ActiveForward[];
  busy: boolean;
  refresh: () => Promise<void>;
  start: (conn: number, forward: RemoteForward) => Promise<ActiveForward>;
  stop: (id: number) => Promise<void>;
  stopAll: () => Promise<void>;
};

export const useTunnelStore = create<State>((set) => ({
  active: [],
  busy: false,

  refresh: async () => {
    const active = await invoke<ActiveForward[]>("tunnel_list").catch(
      () => [] as ActiveForward[],
    );
    set({ active });
  },

  start: async (conn, forward) => {
    set({ busy: true });
    try {
      const info = await invoke<ActiveForward>("tunnel_open", {
        conn,
        spec: {
          bindAddress: forward.bindAddress?.trim() || null,
          localPort: forward.localPort,
          remoteHost: forward.remoteHost,
          remotePort: forward.remotePort,
        },
      });
      set((s) => ({ active: [...s.active, info] }));
      return info;
    } finally {
      set({ busy: false });
    }
  },

  stop: async (id) => {
    await invoke("tunnel_close", { id }).catch(() => {});
    set((s) => ({ active: s.active.filter((f) => f.id !== id) }));
  },

  stopAll: async () => {
    await invoke("tunnel_close_all").catch(() => {});
    set({ active: [] });
  },
}));

/**
 * The listening forward matching a configured one, if any.
 *
 * Matched on the remote side plus the requested bind: the local port cannot be
 * used, because a forward configured with port 0 is bound to whatever the OS
 * handed out.
 */
export function findActiveForward(
  active: ActiveForward[],
  conn: number,
  forward: RemoteForward,
): ActiveForward | undefined {
  const bind = forward.bindAddress?.trim() || "127.0.0.1";
  return active.find(
    (a) =>
      a.conn === conn &&
      a.remoteHost === forward.remoteHost &&
      a.remotePort === forward.remotePort &&
      a.bindAddress === bind &&
      (forward.localPort === 0 || a.localPort === forward.localPort),
  );
}

/** `127.0.0.1:8080 -> localhost:3000`, the shape ssh -L is usually read in. */
export function describeForward(forward: RemoteForward): string {
  const bind = forward.bindAddress?.trim() || "127.0.0.1";
  const local = forward.localPort === 0 ? "auto" : String(forward.localPort);
  return `${bind}:${local} -> ${forward.remoteHost}:${forward.remotePort}`;
}
