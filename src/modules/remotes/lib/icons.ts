import catppuccin from "@iconify-json/catppuccin/icons.json";
import { EXT_TO_LANGUAGE_ID } from "@/modules/explorer/lib/constants";
import type { RemoteIconSet } from "@/modules/settings/store";
import * as fileIconsMod from "@/modules/explorer/lib/fileIcons";
import * as folderIconsMod from "@/modules/explorer/lib/folderIcons";

type IconifySet = {
  width?: number;
  height?: number;
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
};

type Naming = {
  file: (kind: string) => string;
  folder: (kind: string) => string;
  folderOpen: (kind: string) => string;
  defaults: [file: string, folder: string, folderOpen: string];
};

const NAMING: Record<Exclude<RemoteIconSet, "plain">, Naming> = {
  catppuccin: {
    file: (k) => k,
    folder: (k) => k,
    folderOpen: (k) => `${k}-open`,
    defaults: ["file", "folder", "folder-open"],
  },
  material: {
    file: (k) => k,
    folder: (k) => k,
    folderOpen: (k) => `${k}-open`,
    defaults: ["document", "folder-base", "folder-base-open"],
  },
  vscode: {
    file: (k) => `file-type-${k}`,
    folder: (k) => k.replace(/^folder-/, "folder-type-"),
    folderOpen: (k) => `${k.replace(/^folder-/, "folder-type-")}-opened`,
    defaults: ["default-file", "default-folder", "default-folder-opened"],
  },
};

const fileNames = fileIconsMod.fileNames as Record<string, string>;
const fileExtensions = fileIconsMod.fileExtensions as Record<string, string>;
const languageIds = fileIconsMod.languageIds as Record<string, string>;
const folderNames = folderIconsMod.folderNames as Record<string, string>;

const loaded = new Map<RemoteIconSet, IconifySet>();
const pending = new Map<RemoteIconSet, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

// Catppuccin is already in the bundle for the explorer, so importing it here
// costs nothing. The others are fetched only if someone selects them.
loaded.set("catppuccin", catppuccin as unknown as IconifySet);

export function loadIconSet(set: RemoteIconSet): void {
  if (set === "plain" || loaded.has(set) || pending.has(set)) return;
  const load =
    set === "material"
      ? import("../icons/material.json")
      : import("../icons/vscode.json");
  pending.set(
    set,
    load
      .then((mod) => {
        loaded.set(set, mod.default as unknown as IconifySet);
        version += 1;
        for (const fn of listeners) fn();
      })
      .catch(() => undefined)
      .finally(() => {
        pending.delete(set);
      }),
  );
}

/** Re-render once a set finishes loading, since the URLs change underneath. */
export function subscribeIconSets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Snapshot for useSyncExternalStore. It has to change when a set arrives, or
 * React compares two equal snapshots and skips the render that would draw the
 * icons that just became available.
 */
export function iconSetsVersion(): number {
  return version;
}

const urlCache = new Map<string, string>();

function dataUrl(set: RemoteIconSet, name: string): string | null {
  const data = loaded.get(set);
  if (!data) return null;
  const key = `${set}:${name}`;
  const cached = urlCache.get(key);
  if (cached !== undefined) return cached || null;

  const direct = data.icons[name];
  const alias = data.aliases?.[name];
  const body = direct?.body ?? (alias ? data.icons[alias.parent]?.body : null);
  if (!body) {
    urlCache.set(key, "");
    return null;
  }
  const w = data.width ?? 16;
  const h = data.height ?? 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  urlCache.set(key, url);
  return url;
}

const slug = (name: string) => name.replace(/_/g, "-");

function extOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 || dot === name.length - 1 ? "" : name.slice(dot + 1);
}

/** The icon kind for a file name, independent of which set renders it. */
export function fileKind(name: string): string | null {
  const lower = name.toLowerCase();
  const byName = fileNames[lower];
  if (byName) return slug(byName);

  let ext = extOf(lower);
  while (ext) {
    const byExt = fileExtensions[ext];
    if (byExt) return slug(byExt);
    const lang = EXT_TO_LANGUAGE_ID[ext];
    const byLang = lang ? languageIds[lang] : undefined;
    if (byLang) return slug(byLang);
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }
  return null;
}

export function remoteFileIconUrl(
  set: RemoteIconSet,
  name: string,
): string | null {
  if (set === "plain") return null;
  const naming = NAMING[set];
  const kind = fileKind(name);
  const url = kind ? dataUrl(set, naming.file(kind)) : null;
  return url ?? dataUrl(set, naming.defaults[0]);
}

export function remoteFolderIconUrl(
  set: RemoteIconSet,
  name: string,
): string | null {
  if (set === "plain") return null;
  const naming = NAMING[set];
  const mapped = folderNames[name.toLowerCase()];
  const url = mapped ? dataUrl(set, naming.folder(slug(mapped))) : null;
  return url ?? dataUrl(set, naming.defaults[1]);
}
