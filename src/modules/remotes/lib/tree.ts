import type { RemoteGroup, RemoteProfile } from "./types";
import { DEFAULT_SSH_PORT } from "./types";

export type RemoteTreeGroup = {
  group: RemoteGroup | null;
  profiles: RemoteProfile[];
};

/** `user@host`, with the port only when it is not the SSH default. */
export function profileAddress(profile: RemoteProfile): string {
  const base = `${profile.user}@${profile.host}`;
  return profile.port && profile.port !== DEFAULT_SSH_PORT
    ? `${base}:${profile.port}`
    : base;
}

/** What the user sees on a row: their label, falling back to the address. */
export function profileLabel(profile: RemoteProfile): string {
  const name = profile.name.trim();
  return name || profileAddress(profile);
}

function matches(profile: RemoteProfile, needle: string): boolean {
  return (
    profileLabel(profile).toLowerCase().includes(needle) ||
    profile.host.toLowerCase().includes(needle) ||
    profile.user.toLowerCase().includes(needle)
  );
}

function byName(a: RemoteProfile, b: RemoteProfile): number {
  return profileLabel(a).localeCompare(profileLabel(b), undefined, {
    sensitivity: "base",
  });
}

/**
 * Group the profiles for rendering. Ungrouped hosts always come last so the
 * named groups stay at a stable position as hosts are added and removed.
 * A group with no matching hosts is dropped while filtering, but kept when
 * the query is empty so an empty group is still visible and editable.
 */
export function buildRemoteTree(
  profiles: RemoteProfile[],
  groups: RemoteGroup[],
  query = "",
): RemoteTreeGroup[] {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? profiles.filter((p) => matches(p, needle))
    : profiles;

  const known = new Set(groups.map((g) => g.id));
  const byGroup = new Map<string, RemoteProfile[]>();
  const ungrouped: RemoteProfile[] = [];
  for (const profile of visible) {
    // A profile pointing at a deleted group is orphaned, not lost: show it
    // alongside the ungrouped hosts rather than hiding it.
    if (profile.groupId && known.has(profile.groupId)) {
      const list = byGroup.get(profile.groupId);
      if (list) list.push(profile);
      else byGroup.set(profile.groupId, [profile]);
    } else {
      ungrouped.push(profile);
    }
  }

  const ordered = [...groups].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );

  const out: RemoteTreeGroup[] = [];
  for (const group of ordered) {
    const list = (byGroup.get(group.id) ?? []).sort(byName);
    if (needle && list.length === 0) continue;
    out.push({ group, profiles: list });
  }
  if (ungrouped.length > 0) {
    out.push({ group: null, profiles: ungrouped.sort(byName) });
  }
  return out;
}

/** Flat list of rows a keyboard nav can step through, honouring collapse. */
export function visibleProfiles(tree: RemoteTreeGroup[]): RemoteProfile[] {
  return tree.flatMap(({ group, profiles }) =>
    group?.collapsed ? [] : profiles,
  );
}

export function nextGroupOrder(groups: RemoteGroup[]): number {
  return groups.reduce((max, g) => Math.max(max, g.order), -1) + 1;
}

/**
 * A name that does not collide with an existing one, so duplicating a host
 * does not produce two identically-labelled rows.
 */
export function uniqueName(existing: string[], desired: string): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const base = desired.trim() || "Host";
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}
