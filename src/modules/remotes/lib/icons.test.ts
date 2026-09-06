import { describe, expect, it } from "vitest";
import { fileKind, remoteFileIconUrl, remoteFolderIconUrl } from "./icons";

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
