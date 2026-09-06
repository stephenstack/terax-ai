import { describe, expect, it } from "vitest";
import { ACCENT_COLORS, ACCENT_NAMES, normalizeAccent } from "./accentColors";

describe("normalizeAccent", () => {
  it("accepts a palette colour unchanged", () => {
    expect(normalizeAccent(ACCENT_COLORS[0])).toBe(ACCENT_COLORS[0]);
  });

  it("expands shorthand hex and lowercases it", () => {
    expect(normalizeAccent("#AbC")).toBe("#aabbcc");
    expect(normalizeAccent("f00")).toBe("#ff0000");
  });

  it("canonicalizes full hex with or without the hash", () => {
    expect(normalizeAccent("  #1A2B3C ")).toBe("#1a2b3c");
    expect(normalizeAccent("1a2b3c")).toBe("#1a2b3c");
  });

  it("rejects anything that is not a colour we recognise", () => {
    for (const bad of [
      "",
      "   ",
      "red",
      "#12345",
      "#gggggg",
      "rgb(1,2,3)",
      "red; position: fixed",
      "url(javascript:alert(1))",
    ]) {
      expect(normalizeAccent(bad)).toBeNull();
    }
  });
});

describe("ACCENT_NAMES", () => {
  it("names every palette colour", () => {
    expect(ACCENT_NAMES).toHaveLength(ACCENT_COLORS.length);
    expect(new Set(ACCENT_NAMES).size).toBe(ACCENT_NAMES.length);
  });
});
