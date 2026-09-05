import { LazyStore } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { nextGroupOrder } from "./tree";
import type { RemoteGroup, RemoteProfile } from "./types";

const STORE_PATH = "terax-remotes.json";
const KEY_PROFILES = "profiles";
const KEY_GROUPS = "groups";

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
function normalize(profiles: RemoteProfile[]): RemoteProfile[] {
  return profiles.map((p) => ({
    ...p,
    auth: p.auth ?? [],
    env: p.env ?? [],
    jumps: p.jumps ?? [],
    forwards: p.forwards ?? [],
    appearance: p.appearance ?? {},
  }));
}

type State = {
  profiles: RemoteProfile[];
  groups: RemoteGroup[];
  hydrated: boolean;
  init: () => Promise<void>;
  saveProfile: (profile: RemoteProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  addProfiles: (profiles: RemoteProfile[]) => Promise<void>;
  createGroup: (name: string) => Promise<RemoteGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  toggleGroup: (id: string) => Promise<void>;
  moveToGroup: (profileId: string, groupId: string | null) => Promise<void>;
};

let initPromise: Promise<void> | null = null;

async function persist(profiles: RemoteProfile[], groups: RemoteGroup[]) {
  await store.set(KEY_PROFILES, profiles);
  await store.set(KEY_GROUPS, groups);
  await store.save();
  await emit(REMOTES_CHANGED_EVENT, { profiles, groups });
}

export const useRemotesStore = create<State>((set, get) => ({
  profiles: [],
  groups: [],
  hydrated: false,

  init: () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const entries = await store.entries();
        const map = new Map<string, unknown>(entries);
        set({
          profiles: normalize((map.get(KEY_PROFILES) as RemoteProfile[]) ?? []),
          groups: (map.get(KEY_GROUPS) as RemoteGroup[]) ?? [],
          hydrated: true,
        });
        void listen<{ profiles: RemoteProfile[]; groups: RemoteGroup[] }>(
          REMOTES_CHANGED_EVENT,
          (e) => {
            set({
              profiles: normalize(e.payload.profiles),
              groups: e.payload.groups,
            });
          },
        );
      } catch (e) {
        initPromise = null;
        throw e;
      }
    })();
    return initPromise;
  },

  saveProfile: async (profile) => {
    const { profiles, groups } = get();
    const next = { ...profile, updatedAt: Date.now() };
    const index = profiles.findIndex((p) => p.id === profile.id);
    const updated =
      index >= 0
        ? profiles.map((p, i) => (i === index ? next : p))
        : [...profiles, next];
    set({ profiles: updated });
    await persist(updated, groups);
  },

  deleteProfile: async (id) => {
    const { profiles, groups } = get();
    const updated = profiles.filter((p) => p.id !== id);
    set({ profiles: updated });
    await persist(updated, groups);
  },

  addProfiles: async (incoming) => {
    if (incoming.length === 0) return;
    const { profiles, groups } = get();
    const updated = [...profiles, ...incoming];
    set({ profiles: updated });
    await persist(updated, groups);
  },

  createGroup: async (name) => {
    const { profiles, groups } = get();
    const group: RemoteGroup = {
      id: newId(),
      name: name.trim() || "Group",
      collapsed: false,
      order: nextGroupOrder(groups),
    };
    const updated = [...groups, group];
    set({ groups: updated });
    await persist(profiles, updated);
    return group;
  },

  renameGroup: async (id, name) => {
    const { profiles, groups } = get();
    const updated = groups.map((g) =>
      g.id === id ? { ...g, name: name.trim() || g.name } : g,
    );
    set({ groups: updated });
    await persist(profiles, updated);
  },

  deleteGroup: async (id) => {
    const { profiles, groups } = get();
    const nextGroups = groups.filter((g) => g.id !== id);
    // Deleting a group must never delete its hosts; orphan them instead.
    const nextProfiles = profiles.map((p) =>
      p.groupId === id ? { ...p, groupId: null } : p,
    );
    set({ groups: nextGroups, profiles: nextProfiles });
    await persist(nextProfiles, nextGroups);
  },

  toggleGroup: async (id) => {
    const { profiles, groups } = get();
    const updated = groups.map((g) =>
      g.id === id ? { ...g, collapsed: !g.collapsed } : g,
    );
    set({ groups: updated });
    await persist(profiles, updated);
  },

  moveToGroup: async (profileId, groupId) => {
    const { profiles, groups } = get();
    const updated = profiles.map((p) =>
      p.id === profileId ? { ...p, groupId, updatedAt: Date.now() } : p,
    );
    set({ profiles: updated });
    await persist(updated, groups);
  },
}));

export function findProfile(id: string | undefined): RemoteProfile | undefined {
  if (!id) return undefined;
  return useRemotesStore.getState().profiles.find((p) => p.id === id);
}
