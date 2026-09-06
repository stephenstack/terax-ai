/**
 * Vendor the icon sets the remote browser offers, trimmed to the icons our
 * name and extension mapping can actually reach.
 *
 * The upstream packages are megabytes and every chunk counts against the
 * bundle budget, so shipping them whole is not an option. They stay
 * devDependencies and only the generated JSON is imported at runtime.
 *
 * Run with: pnpm build:icons
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/modules/remotes/icons");

const { fileNames, fileExtensions, languageIds } = await import(
  join(root, "src/modules/explorer/lib/fileIcons.ts")
);
const { folderNames } = await import(
  join(root, "src/modules/explorer/lib/folderIcons.ts")
);

const slug = (name) => name.replace(/_/g, "-");

const fileKinds = new Set(
  [
    ...Object.values(fileNames),
    ...Object.values(fileExtensions),
    ...Object.values(languageIds),
  ].map(slug),
);
const folderKinds = new Set(Object.values(folderNames).map(slug));

/** How each set names the icon for a given kind, and what it falls back to. */
// Catppuccin is deliberately absent: the explorer already imports that
// package, so the browser reuses the very same module for free. Only sets
// nothing else pulls in have to be vendored.
const SETS = {
  material: {
    pkg: "@iconify-json/material-icon-theme/icons.json",
    file: (k) => k,
    folder: (k) => k,
    folderOpen: (k) => `${k}-open`,
    // This set calls its generics "document" and "folder-base".
    defaults: ["document", "folder-base", "folder-base-open"],
  },
  vscode: {
    pkg: "@iconify-json/vscode-icons/icons.json",
    file: (k) => `file-type-${k}`,
    folder: (k) => k.replace(/^folder-/, "folder-type-"),
    folderOpen: (k) => `${k.replace(/^folder-/, "folder-type-")}-opened`,
    defaults: ["default-file", "default-folder", "default-folder-opened"],
  },
};

mkdirSync(outDir, { recursive: true });

for (const [id, spec] of Object.entries(SETS)) {
  const { default: set } = await import(spec.pkg, { with: { type: "json" } });
  const wanted = new Set(spec.defaults);
  for (const k of fileKinds) wanted.add(spec.file(k));
  for (const k of folderKinds) {
    wanted.add(spec.folder(k));
    wanted.add(spec.folderOpen(k));
  }

  const icons = {};
  for (const name of wanted) {
    const direct = set.icons[name];
    if (direct) {
      icons[name] = { body: direct.body };
      continue;
    }
    const alias = set.aliases?.[name];
    const parent = alias && set.icons[alias.parent];
    if (parent) icons[name] = { body: parent.body };
  }

  const out = {
    width: set.width ?? 16,
    height: set.height ?? 16,
    icons,
  };
  const file = join(outDir, `${id}.json`);
  writeFileSync(file, JSON.stringify(out));
  const kb = Math.round(JSON.stringify(out).length / 1024);
  console.log(
    `${id}: ${Object.keys(icons).length}/${wanted.size} icons, ${kb} KB`,
  );
}
