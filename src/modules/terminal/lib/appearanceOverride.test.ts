import { describe, expect, it } from "vitest";
import {
  pruneAppearance,
  resolveAppearance,
  type TerminalAppearance,
} from "./appearanceOverride";

const base: TerminalAppearance = {
  fontFamily: "JetBrains Mono",
  fontSize: 13,
  fontWeight: "400",
  letterSpacing: 0,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 1000,
};

describe("resolveAppearance", () => {
  it("returns the base untouched when there is nothing to override", () => {
    expect(resolveAppearance(base, undefined)).toBe(base);
    expect(resolveAppearance(base, {})).toEqual(base);
  });

  it("applies only the fields that are set", () => {
    const out = resolveAppearance(base, { fontSize: 16 });
    expect(out.fontSize).toBe(16);
    expect(out.fontFamily).toBe(base.fontFamily);
  });

  it("keeps a false override rather than falling back", () => {
    expect(resolveAppearance(base, { cursorBlink: false }).cursorBlink).toBe(
      false,
    );
  });

  it("treats a blank font family as unset", () => {
    expect(resolveAppearance(base, { fontFamily: "   " }).fontFamily).toBe(
      base.fontFamily,
    );
  });

  it("clamps an absurd font size instead of applying it", () => {
    expect(resolveAppearance(base, { fontSize: 9999 }).fontSize).toBe(72);
    expect(resolveAppearance(base, { fontSize: 1 }).fontSize).toBe(6);
  });

  it("ignores a non-finite size", () => {
    expect(resolveAppearance(base, { fontSize: Number.NaN }).fontSize).toBe(
      base.fontSize,
    );
  });

  it("allows a zero scrollback but rejects a negative one", () => {
    expect(resolveAppearance(base, { scrollback: 0 }).scrollback).toBe(0);
    expect(resolveAppearance(base, { scrollback: -5 }).scrollback).toBe(0);
  });
});

describe("pruneAppearance", () => {
  it("drops values that merely equal the base", () => {
    expect(pruneAppearance(base, { fontSize: 13, fontFamily: base.fontFamily })).toEqual(
      {},
    );
  });

  it("keeps values that genuinely differ", () => {
    expect(pruneAppearance(base, { fontSize: 16 })).toEqual({ fontSize: 16 });
  });

  it("keeps a deliberate false that differs from the base", () => {
    expect(pruneAppearance(base, { cursorBlink: false })).toEqual({
      cursorBlink: false,
    });
  });

  it("drops a false that matches a false base", () => {
    const off: TerminalAppearance = { ...base, cursorBlink: false };
    expect(pruneAppearance(off, { cursorBlink: false })).toEqual({});
  });

  it("normalizes before comparing, so a clamped value is not stored", () => {
    // 13.4 rounds to the base 13 and is therefore not an override.
    expect(pruneAppearance(base, { fontSize: 13.4 })).toEqual({});
  });

  it("trims a font family before storing it", () => {
    expect(pruneAppearance(base, { fontFamily: "  Fira Code  " })).toEqual({
      fontFamily: "Fira Code",
    });
  });

  it("round-trips through resolve without drift", () => {
    const pruned = pruneAppearance(base, { fontSize: 18, cursorStyle: "block" });
    const resolved = resolveAppearance(base, pruned);
    expect(resolved.fontSize).toBe(18);
    expect(resolved.cursorStyle).toBe("block");
    expect(resolved.fontFamily).toBe(base.fontFamily);
  });
});
