import { describe, expect, it } from "vitest";
import { traceEager } from "../../scripts/eager-graph.mjs";

// Locks the startup-bundle invariant: the heavy editor / AI / markdown stacks
// must stay out of the eager graph of both window entries so they load only
// when the user opens those surfaces. A static import that re-introduces any of
// these (e.g. a barrel re-export of chat runtime, or a `cn`-style util getting
// absorbed into a feature chunk) will fail here. xterm and motion are
// intentionally eager (terminal-first shell) and are not asserted against.
const HEAVY = ["@ai-sdk", "ai", "streamdown", "@codemirror", "@uiw"];

function heavyEagerHits(entry: string): string[] {
  const { hits } = traceEager(entry, HEAVY);
  return [...hits.entries()].map(([pkg, info]) => `${pkg} <- ${info.file}`);
}

// Surfaces that must stay behind a lazy import: a user who never opens them
// should not pay for them at startup. Listed by file so a stray static import
// from a barrel fails here rather than silently growing the eager chunk.
const LAZY_SURFACES = [
  "src/modules/remotes/RemotesPanel.tsx",
  "src/modules/remotes/HostDialog.tsx",
  "src/modules/remotes/ImportConfigDialog.tsx",
  "src/modules/remotes/RemotePrompts.tsx",
];

describe("startup bundle budget", () => {
  it("main window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/main.tsx")).toEqual([]);
  });

  it("settings window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/settings/main.tsx")).toEqual([]);
  });

  it("keeps the remotes UI out of the main window eager graph", () => {
    const { files } = traceEager("src/main.tsx");
    expect(LAZY_SURFACES.filter((f) => files.has(f))).toEqual([]);
  });

  it("still reaches the remote opener eagerly, so a restored tab can spawn", () => {
    const { files } = traceEager("src/main.tsx");
    expect(files.has("src/modules/remotes/lib/opener.ts")).toBe(true);
  });
});
