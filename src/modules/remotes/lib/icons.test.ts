import { describe, expect, it } from "vitest";
import {
  fileKind,
  iconSetsVersion,
  loadIconSet,
  remoteFileIconUrl,
  remoteFolderIconUrl,
  subscribeIconSets,
} from "./icons";

describe("fileKind", () => {
  it("matches a whole file name before falling back to its extension", () => {
    expect(fileKind("Dockerfile")).toBeTruthy();
    expect(fileKind("index.ts")).toBe("typescript");
  });

  it("prefers the most specific compound extension", () => {
    expect(fileKind("bundle.spec.ts")).toBe("typescript-test");
    expect(fileKind("plain.ts")).toBe("typescript");
  });

  it("is null for something it cannot place", () => {
    expect(fileKind("notes.zzzz")).toBeNull();
  });
});

describe("icon urls", () => {
  it("renders nothing at all for the plain set", () => {
    expect(remoteFileIconUrl("plain", "index.ts")).toBeNull();
    expect(remoteFolderIconUrl("plain", "src")).toBeNull();
  });

  it("resolves a known type from a set that is already loaded", () => {
    const url = remoteFileIconUrl("catppuccin", "index.ts");
    expect(url).toMatch(/^data:image\/svg\+xml/);
  });

  it("falls back to the generic icon rather than nothing", () => {
    const url = remoteFileIconUrl("catppuccin", "notes.zzzz");
    expect(url).toMatch(/^data:image\/svg\+xml/);
  });

  it("returns null while a lazily loaded set is not in memory", () => {
    // Nothing has selected it, so it has never been fetched.
    expect(remoteFileIconUrl("vscode", "index.ts")).toBeNull();
  });
});

describe("loading a set", () => {
  it("changes the snapshot so a render is not skipped", async () => {
    const before = iconSetsVersion();
    expect(remoteFileIconUrl("material", "index.ts")).toBeNull();

    const arrived = new Promise<void>((resolve) => {
      const stop = subscribeIconSets(() => {
        stop();
        resolve();
      });
    });
    loadIconSet("material");
    await arrived;

    // Equal snapshots would let React skip the render that draws these.
    expect(iconSetsVersion()).toBeGreaterThan(before);
    expect(remoteFileIconUrl("material", "index.ts")).toMatch(
      /^data:image\/svg\+xml/,
    );
  });
});
