import { LazyStore } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { nextGroupOrder } from "./tree";
import { normalizeGroupColor, normalizeVisuals } from "./visuals";
import type { RemoteGroup, RemoteProfile } from "./types";

const STORE_PATH = "terax-remotes.json";
const KEY_PROFILES = "profiles";
const KEY_GROUPS = "groups";
const KEY_SSH_CONFIG_PATH = "sshConfigPath";

/** Where the OpenSSH config import reads from until the user points elsewhere. */
export const DEFAULT_SSH_CONFIG_PATH = "~/.ssh/config";

/** Settings lives in its own webview, so writes are mirrored as an event. */
const REMOTES_CHANGED_EVENT = "terax://remotes-changed";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

function newId(): string {
  return crypto.randomUUID();
}

export function emptyProfile(): RemoteProfile {
  const now = Date.now();
  return {
    id: newId(),
    name: "",
    groupId: null,
    host: "",
    port: null,
    user: "",
    auth: [{ kind: "agent" }, { kind: "password" }],
    env: [],
    jumps: [],
    forwards: [],
    appearance: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fill in fields added after a profile was first saved. Without this a stored
 * profile from an earlier version yields `undefined` where the UI and the
 * connect path both expect a list.
 */
function normalizeGroups(groups: RemoteGroup[]): RemoteGroup[] {
  return groups.map((g) => ({ ...g, color: normalizeGroupColor(g.color) }));
}

function normalize(profiles: RemoteProfile[]): RemoteProfile[] {
  return profiles.map((p) => ({
    ...p,
    auth: p.auth ?? [],
    env: p.env ?? [],
    jumps: p.jumps ?? [],
    forwards: p.forwards ?? [],
    appearance: p.appearance ?? {},
    ...normalizeVisuals(p),
  }));
}

type Snapshot = {
  profiles: RemoteProfile[];
  groups: RemoteGroup[];
  sshConfigPath: string;
};

type State = Snapshot & {
  hydrated: boolean;
  init: () => Promise<void>;
  setSshConfigPath: (path: string) => Promise<void>;
  importSnapshot: (profiles: RemoteProfile[], groups: RemoteGroup[]) => Promise<void>;
  saveProfile: (profile: RemoteProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  addProfiles: (profiles: RemoteProfile[]) => Promise<void>;
  createGroup: (name: string) => Promise<RemoteGroup>;
  updateGroup: (
    id: string,
    patch: { name?: string; color?: string },
  ) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  toggleGroup: (id: string) => Promise<void>;
  moveToGroup: (profileId: string, groupId: string | null) => Promise<void>;
};

let initPromise: Promise<void> | null = null;

async function persist(
  profiles: RemoteProfile[],
  groups: RemoteGroup[],
  sshConfigPath: string,
) {
  await store.set(KEY_PROFILES, profiles);
  await store.set(KEY_GROUPS, groups);
  await store.set(KEY_SSH_CONFIG_PATH, sshConfigPath);
  await store.save();
  await emit<Snapshot>(REMOTES_CHANGED_EVENT, { profiles, groups, sshConfigPath });
}

export const useRemotesStore = create<State>((set, get) => ({
  profiles: [],
  groups: [],
  sshConfigPath: DEFAULT_SSH_CONFIG_PATH,
  hydrated: false,

  init: () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const entries = await store.entries();
        const map = new Map<string, unknown>(entries);
        const stored = map.get(KEY_SSH_CONFIG_PATH);
        set({
          profiles: normalize((map.get(KEY_PROFILES) as RemoteProfile[]) ?? []),
          groups: normalizeGroups((map.get(KEY_GROUPS) as RemoteGroup[]) ?? []),
          sshConfigPath:
            typeof stored === "string" && stored.trim()
              ? stored
              : DEFAULT_SSH_CONFIG_PATH,
          hydrated: true,
        });
        void listen<Snapshot>(REMOTES_CHANGED_EVENT, (e) => {
          set({
            profiles: normalize(e.payload.profiles),
            groups: normalizeGroups(e.payload.groups),
            sshConfigPath: e.payload.sshConfigPath,
          });
        });
      } catch (e) {
        initPromise = null;
        throw e;
      }
    })();
    return initPromise;
  },

  saveProfile: async (profile) => {
    const { profiles, groups, sshConfigPath } = get();
    const next = { ...profile, updatedAt: Date.now() };
    const index = profiles.findIndex((p) => p.id === profile.id);
    const updated =
      index >= 0
        ? profiles.map((p, i) => (i === index ? next : p))
        : [...profiles, next];
    set({ profiles: updated });
    await persist(updated, groups, sshConfigPath);
  },

  deleteProfile: async (id) => {
    const { profiles, groups, sshConfigPath } = get();
    const removed = profiles.find((p) => p.id === id);
    const updated = profiles.filter((p) => p.id !== id);
    set({ profiles: updated });
    await persist(updated, groups, sshConfigPath);
    // Nothing names the blob once the profile is gone.
    const imageId = removed?.background?.imageId;
    if (imageId) {
      const { deleteBgImage } = await import("@/modules/theme/bgImageStore");
      await deleteBgImage(imageId).catch(() => undefined);
    }
  },

  addProfiles: async (incoming) => {
    if (incoming.length === 0) return;
    const { profiles, groups, sshConfigPath } = get();
    const updated = [...profiles, ...incoming];
    set({ profiles: updated });
    await persist(updated, groups, sshConfigPath);
  },

  createGroup: async (name) => {
    const { profiles, groups, sshConfigPath } = get();
    const group: RemoteGroup = {
      id: newId(),
      name: name.trim() || "Group",
      collapsed: false,
      order: nextGroupOrder(groups),
    };
    const updated = [...groups, group];
    set({ groups: updated });
    await persist(profiles, updated, sshConfigPath);
    return group;
  },

  updateGroup: async (id, patch) => {
    const { profiles, groups, sshConfigPath } = get();
    const updated = groups.map((g) => {
      if (g.id !== id) return g;
      const name = patch.name?.trim();
      return {
        ...g,
        name: name || g.name,
        color:
          patch.color === undefined
            ? g.color
            : normalizeGroupColor(patch.color),
      };
    });
    set({ groups: updated });
    await persist(profiles, updated, sshConfigPath);
  },

  deleteGroup: async (id) => {
    const { profiles, groups, sshConfigPath } = get();
    const nextGroups = groups.filter((g) => g.id !== id);
    // Deleting a group must never delete its hosts; orphan them instead.
    const nextProfiles = profiles.map((p) =>
      p.groupId === id ? { ...p, groupId: null } : p,
    );
    set({ groups: nextGroups, profiles: nextProfiles });
    await persist(nextProfiles, nextGroups, sshConfigPath);
  },

  toggleGroup: async (id) => {
    const { profiles, groups, sshConfigPath } = get();
    const updated = groups.map((g) =>
      g.id === id ? { ...g, collapsed: !g.collapsed } : g,
    );
    set({ groups: updated });
    await persist(profiles, updated, sshConfigPath);
  },

  setSshConfigPath: async (path) => {
    const { profiles, groups } = get();
    const next = path.trim() || DEFAULT_SSH_CONFIG_PATH;
    set({ sshConfigPath: next });
    await persist(profiles, groups, next);
  },

  /**
   * One write for a whole import: hosts and the groups they land in have to
   * become visible together, or a host would briefly point at a group that
   * does not exist yet and render as orphaned.
   */
  importSnapshot: async (nextProfiles, nextGroups) => {
    const { sshConfigPath } = get();
    set({ profiles: nextProfiles, groups: nextGroups });
    await persist(nextProfiles, nextGroups, sshConfigPath);
  },

  moveToGroup: async (profileId, groupId) => {
    const { profiles, groups, sshConfigPath } = get();
    const updated = profiles.map((p) =>
      p.id === profileId ? { ...p, groupId, updatedAt: Date.now() } : p,
    );
    set({ profiles: updated });
    await persist(updated, groups, sshConfigPath);
  },
}));

export function findProfile(id: string | undefined): RemoteProfile | undefined {
  if (!id) return undefined;
  return useRemotesStore.getState().profiles.find((p) => p.id === id);
}
