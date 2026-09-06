import { describe, expect, it } from "vitest";
import { useRemoteSections } from "./sections";

describe("remote sections", () => {
  // Importing this module used to throw: the store initializer read a const
  // declared below it, which is a temporal dead zone error at import time and
  // took the whole window down with it.
  it("initializes on import", () => {
    const s = useRemoteSections.getState();
    expect(s.filesExpanded).toBe(true);
    expect(s.sizes).toBeTypeOf("object");
  });

  it("remembers a height and ignores a settled drag", () => {
    useRemoteSections.getState().setSize("remotes-files", 40);
    expect(useRemoteSections.getState().sizes["remotes-files"]).toBe(40);
    useRemoteSections.getState().setSize("remotes-files", 40.2);
    expect(useRemoteSections.getState().sizes["remotes-files"]).toBe(40);
  });

  it("toggles one section without touching the other", () => {
    const before = useRemoteSections.getState().gitExpanded;
    useRemoteSections.getState().toggle("files");
    expect(useRemoteSections.getState().filesExpanded).toBe(false);
    expect(useRemoteSections.getState().gitExpanded).toBe(before);
  });
});
