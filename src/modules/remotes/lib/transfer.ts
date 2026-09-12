import { normalizeAccent } from "@/lib/accentColors";
import type { TerminalCursorStyle } from "@/modules/settings/store";
import type { TerminalAppearanceOverride } from "@/modules/terminal";
import { nextGroupOrder, uniqueName } from "./tree";
import type {
  RemoteAuthMethod,
  RemoteForward,
  RemoteGroup,
  RemoteProfile,
  SshConfigHost,
} from "./types";

export const REMOTES_EXPORT_KIND = "terax-remotes";
export const REMOTES_EXPORT_VERSION = 1;
export const REMOTES_EXPORT_EXT = ".json";

/**
 * The on-disk shape moved between instances. Deliberately a plain snapshot of
 * the two stored collections: anything richer would have to be migrated twice,
 * once in the store and once here.
 */
export type RemotesExport = {
  kind: typeof REMOTES_EXPORT_KIND;
  version: number;
  exportedAt: number;
  groups: RemoteGroup[];
  profiles: RemoteProfile[];
};

/** How an incoming host that already exists on this instance is handled. */
export type ImportMode = "skip" | "replace" | "copy";

export type ImportResult = {
  profiles: RemoteProfile[];
  groups: RemoteGroup[];
  added: number;
  replaced: number;
  skipped: number;
  groupsAdded: number;
};

export type ParseResult =
  | { ok: true; data: RemotesExport }
  | { ok: false; error: string };

const MAX_PORT = 65535;
const CURSOR_STYLES: readonly TerminalCursorStyle[] = [
  "bar",
  "block",
  "underline",
];

function newId(): string {
  return crypto.randomUUID();
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function whole(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : undefined;
}

function decimal(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Rebuild each method field by field rather than spreading: a file written by
 * another tool (or an older Terax that leaked one) must not be able to carry a
 * `password` or `passphrase` into the profile store, which never holds secrets.
 */
function readAuth(value: unknown): RemoteAuthMethod[] {
  const out: RemoteAuthMethod[] = [];
  for (const entry of list(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const kind = (entry as { kind?: unknown }).kind;
    if (kind === "agent" || kind === "password" || kind === "keyboardInteractive") {
      out.push({ kind });
    } else if (kind === "keyFile") {
      const path = text((entry as { path?: unknown }).path);
      if (path) out.push({ kind: "keyFile", path });
    }
  }
  return out;
}

function readEnv(value: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of list(value)) {
    if (!Array.isArray(entry)) continue;
    const [name, val] = entry;
    if (typeof name !== "string" || typeof val !== "string") continue;
    const key = name.trim();
    if (key) out.push([key, val]);
  }
  return out;
}

function readForwards(value: unknown): RemoteForward[] {
  const out: RemoteForward[] = [];
  for (const entry of list(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const remoteHost = text(raw.remoteHost);
    const remotePort = whole(raw.remotePort, 1, MAX_PORT);
    if (!remoteHost || remotePort === undefined) continue;
    out.push({
      // 0 is legal here: it means "let the OS pick".
      id: newId(),
      localPort: whole(raw.localPort, 0, MAX_PORT) ?? 0,
      remoteHost,
      remotePort,
      bindAddress: text(raw.bindAddress),
      label: text(raw.label),
    });
  }
  return out;
}

function readAppearance(value: unknown): TerminalAppearanceOverride {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const cursorStyle = CURSOR_STYLES.find((s) => s === raw.cursorStyle);
  const out: TerminalAppearanceOverride = {};
  const fontFamily = text(raw.fontFamily);
  const fontWeight = text(raw.fontWeight);
  const fontSize = whole(raw.fontSize, 1, 200);
  const letterSpacing = decimal(raw.letterSpacing, -20, 20);
  const scrollback = whole(raw.scrollback, 0, 1_000_000);
  if (fontFamily) out.fontFamily = fontFamily;
  if (fontWeight) out.fontWeight = fontWeight;
  if (fontSize !== undefined) out.fontSize = fontSize;
  if (letterSpacing !== undefined) out.letterSpacing = letterSpacing;
  if (cursorStyle) out.cursorStyle = cursorStyle;
  const blink = flag(raw.cursorBlink);
  if (blink !== undefined) out.cursorBlink = blink;
  if (scrollback !== undefined) out.scrollback = scrollback;
  return out;
}

function readStrings(value: unknown): string[] {
  return list(value)
    .map((v) => text(v))
    .filter((v): v is string => v !== undefined);
}

/**
 * A profile is only as trustworthy as the file it came from, and several of
 * its fields reach a style attribute or an `ssh_open` argument, so every one
 * is rebuilt from a validated primitive. A host without an address is not a
 * host and is dropped rather than imported as an unusable row.
 */
function readProfile(value: unknown, now: number): RemoteProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const host = text(raw.host);
  if (!host) return null;

  const color = text(raw.color);
  return {
    id: text(raw.id) ?? newId(),
    name: text(raw.name) ?? "",
    groupId: text(raw.groupId) ?? null,
    host,
    port: whole(raw.port, 1, MAX_PORT) ?? null,
    user: text(raw.user) ?? "",
    auth: readAuth(raw.auth),
    term: text(raw.term),
    cwd: text(raw.cwd),
    command: text(raw.command),
    keepaliveSecs: whole(raw.keepaliveSecs, 0, 86_400),
    connectTimeoutSecs: whole(raw.connectTimeoutSecs, 1, 3600),
    compression: flag(raw.compression),
    env: readEnv(raw.env),
    jumps: readStrings(raw.jumps),
    forwards: readForwards(raw.forwards),
    appearance: readAppearance(raw.appearance),
    color: color ? (normalizeAccent(color) ?? undefined) : undefined,
    createdAt: whole(raw.createdAt, 0, Number.MAX_SAFE_INTEGER) ?? now,
    updatedAt: whole(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER) ?? now,
  };
}

function readGroup(value: unknown, index: number): RemoteGroup | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const name = text(raw.name);
  if (!name) return null;
  const color = text(raw.color);
  return {
    id: text(raw.id) ?? newId(),
    name,
    color: color ? (normalizeAccent(color) ?? undefined) : undefined,
    collapsed: flag(raw.collapsed) ?? false,
    order: whole(raw.order, 0, 1_000_000) ?? index,
  };
}

/**
 * The portable form of a profile. `background` is deliberately dropped: the
 * image itself lives in this instance's blob store and the id would resolve to
 * nothing on the machine the file is carried to.
 */
function toPortable(profile: RemoteProfile): RemoteProfile {
  const { background: _background, ...rest } = profile;
  return rest;
}

export function buildExport(
  profiles: RemoteProfile[],
  groups: RemoteGroup[],
  now = Date.now(),
): RemotesExport {
  return {
    kind: REMOTES_EXPORT_KIND,
    version: REMOTES_EXPORT_VERSION,
    exportedAt: now,
    groups,
    profiles: profiles.map(toPortable),
  };
}

export function serializeExport(
  profiles: RemoteProfile[],
  groups: RemoteGroup[],
  now = Date.now(),
): string {
  return `${JSON.stringify(buildExport(profiles, groups, now), null, 2)}\n`;
}

export function parseExport(input: string, now = Date.now()): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "not valid JSON",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "not a Terax remotes export" };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.kind !== REMOTES_EXPORT_KIND) {
    return { ok: false, error: "not a Terax remotes export" };
  }
  const version = whole(raw.version, 1, 1_000_000);
  if (version === undefined) {
    return { ok: false, error: "export has no version" };
  }
  if (version > REMOTES_EXPORT_VERSION) {
    return {
      ok: false,
      error: `this file was written by a newer Terax (format ${version})`,
    };
  }

  const groups = list(raw.groups)
    .map((g, i) => readGroup(g, i))
    .filter((g): g is RemoteGroup => g !== null);
  const profiles = list(raw.profiles)
    .map((p) => readProfile(p, now))
    .filter((p): p is RemoteProfile => p !== null);

  if (profiles.length === 0 && groups.length === 0) {
    return { ok: false, error: "export contains no hosts or groups" };
  }
  return {
    ok: true,
    data: {
      kind: REMOTES_EXPORT_KIND,
      version,
      exportedAt: whole(raw.exportedAt, 0, Number.MAX_SAFE_INTEGER) ?? now,
      groups,
      profiles,
    },
  };
}

/**
 * Fold an export into what this instance already has.
 *
 * Groups match by name rather than id, because two instances that both have a
 * "Production" group mean the same thing by it even though the ids were
 * generated independently. Hosts match by `user@host:port` for the same
 * reason, which is also the key the `~/.ssh/config` import already dedupes on.
 */
export function applyImport(
  existing: { profiles: RemoteProfile[]; groups: RemoteGroup[] },
  data: RemotesExport,
  selectedIds: ReadonlySet<string>,
  mode: ImportMode,
  now = Date.now(),
): ImportResult {
  const chosen = data.profiles.filter((p) => selectedIds.has(p.id));

  const groups = [...existing.groups];
  const byName = new Map(groups.map((g) => [g.name.trim().toLowerCase(), g]));
  const referenced = new Set(
    chosen.map((p) => p.groupId).filter((id): id is string => id !== null),
  );
  const populated = new Set(
    data.profiles.map((p) => p.groupId).filter((id): id is string => id !== null),
  );
  const groupIdFor = new Map<string, string>();
  let groupsAdded = 0;

  for (const group of data.groups) {
    // An exported group is carried over when a chosen host needs it, or when
    // it held no hosts at all: an empty grouping is still the user's work.
    if (!referenced.has(group.id) && populated.has(group.id)) continue;
    const key = group.name.trim().toLowerCase();
    const match = byName.get(key);
    if (match) {
      groupIdFor.set(group.id, match.id);
      continue;
    }
    const created: RemoteGroup = {
      ...group,
      id: newId(),
      order: nextGroupOrder(groups),
    };
    groups.push(created);
    byName.set(key, created);
    groupIdFor.set(group.id, created.id);
    groupsAdded += 1;
  }

  let profiles = [...existing.profiles];
  const names = profiles.map((p) => p.name).filter(Boolean);
  let added = 0;
  let replaced = 0;
  let skipped = 0;

  for (const incoming of chosen) {
    const groupId = incoming.groupId
      ? (groupIdFor.get(incoming.groupId) ?? null)
      : null;
    const candidate: RemoteProfile = { ...incoming, groupId, updatedAt: now };
    const key = profileKey(candidate);
    const existingIndex =
      mode === "copy" ? -1 : profiles.findIndex((p) => profileKey(p) === key);

    if (existingIndex >= 0 && mode === "skip") {
      skipped += 1;
      continue;
    }
    if (existingIndex >= 0) {
      const current = profiles[existingIndex];
      if (!current) continue;
      profiles = profiles.map((p, i) =>
        i === existingIndex
          ? { ...candidate, id: current.id, createdAt: current.createdAt }
          : p,
      );
      replaced += 1;
      continue;
    }
    const name = uniqueName(names, candidate.name || candidate.host);
    names.push(name);
    profiles.push({ ...candidate, id: newId(), name, createdAt: now });
    added += 1;
  }

  return { profiles, groups, added, replaced, skipped, groupsAdded };
}

/**
 * Turn a parsed `~/.ssh/config` entry into a profile, keeping the alias as the
 * name so the row reads the way the user's own config does.
 */
export function profileFromConfigHost(
  host: SshConfigHost,
  existingNames: string[],
  now = Date.now(),
): RemoteProfile {
  const auth: RemoteAuthMethod[] = host.identity_files.map((path) => ({
    kind: "keyFile",
    path,
  }));
  // IdentitiesOnly means "do not fall back to the agent's other keys".
  if (!host.identities_only) auth.push({ kind: "agent" });
  auth.push({ kind: "password" });

  return {
    id: newId(),
    name: uniqueName(existingNames, host.alias),
    groupId: null,
    host: host.hostname ?? host.alias,
    port: host.port,
    user: host.user ?? "",
    auth,
    connectTimeoutSecs: host.connect_timeout ?? undefined,
    keepaliveSecs: host.server_alive_interval ?? undefined,
    compression: host.compression ?? undefined,
    env: [],
    // ProxyJump takes a comma-separated chain, nearest bastion first.
    jumps: (host.proxy_jump ?? "")
      .split(",")
      .map((j) => j.trim())
      .filter(Boolean),
    forwards: [],
    appearance: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** The `user@host:port` identity of a config entry, for the duplicate check. */
export function configHostKey(host: SshConfigHost): string {
  return `${host.user ?? ""}@${host.hostname ?? host.alias}:${host.port ?? 22}`.toLowerCase();
}

/** The same identity for a stored profile. */
export function profileKey(profile: RemoteProfile): string {
  return `${profile.user}@${profile.host}:${profile.port ?? 22}`.toLowerCase();
}

/** Absolute form of a path a user typed with a leading `~`. */
export function expandHome(path: string, home: string): string {
  const trimmed = path.trim();
  if (trimmed !== "~" && !trimmed.startsWith("~/")) return trimmed;
  const base = home.replace(/[\\/]+$/, "");
  return trimmed === "~" ? base : `${base}/${trimmed.slice(2)}`;
}

/** Default export filename, dated so successive exports do not overwrite. */
export function exportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `terax-remotes-${stamp}${REMOTES_EXPORT_EXT}`;
}
