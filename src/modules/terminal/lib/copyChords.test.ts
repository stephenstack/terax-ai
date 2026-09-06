import { describe, expect, it } from "vitest";
import { isPlainCopy, isPlainPaste } from "./rendererPool";

const key = (over: Partial<KeyboardEvent>) =>
  ({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    code: "",
    key: "",
    ...over,
  }) as KeyboardEvent;

describe("plain Ctrl+C", () => {
  it("copies while something is selected", () => {
    expect(isPlainCopy(key({ ctrlKey: true, code: "KeyC" }), true)).toBe(true);
  });

  it("is not a copy with nothing selected, so the interrupt survives", () => {
    // The important half: losing SIGINT would be far worse than an extra chord.
    expect(isPlainCopy(key({ ctrlKey: true, code: "KeyC" }), false)).toBe(false);
  });

  it("leaves the traditional chord to the other handler", () => {
    expect(
      isPlainCopy(key({ ctrlKey: true, shiftKey: true, code: "KeyC" }), true),
    ).toBe(false);
  });
});

describe("plain Ctrl+V", () => {
  it("pastes regardless of selection", () => {
    expect(isPlainPaste(key({ ctrlKey: true, code: "KeyV" }))).toBe(true);
  });

  it("ignores other modifiers", () => {
    expect(
      isPlainPaste(key({ ctrlKey: true, altKey: true, code: "KeyV" })),
    ).toBe(false);
  });
});
