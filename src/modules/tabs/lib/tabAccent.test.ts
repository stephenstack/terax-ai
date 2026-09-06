import { describe, expect, it } from "vitest";
import { resolveTabAccent } from "./tabAccent";
import type { Tab } from "./useTabs";

function term(over: Partial<Extract<Tab, { kind: "terminal" }>>): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "s1",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...over,
  } as Tab;
}

const host = (id: string) => (id === "h1" ? "#111111" : undefined);

describe("resolveTabAccent", () => {
  it("prefers the tab's own colour over its host's", () => {
    expect(resolveTabAccent(term({ color: "#abcdef", remoteId: "h1" }), host)).toBe(
      "#abcdef",
    );
  });

  it("inherits the host colour when the tab has none", () => {
    expect(resolveTabAccent(term({ remoteId: "h1" }), host)).toBe("#111111");
  });

  it("is undefined for a local tab and for a host with no colour", () => {
    expect(resolveTabAccent(term({}), host)).toBeUndefined();
    expect(resolveTabAccent(term({ remoteId: "other" }), host)).toBeUndefined();
  });

  it("never colours a non-terminal tab", () => {
    const editor = { id: 3, kind: "editor", spaceId: "s1" } as Tab;
    expect(resolveTabAccent(editor, host)).toBeUndefined();
  });
});
