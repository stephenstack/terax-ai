import { describe, expect, it } from "vitest";
import {
  applyEdit,
  classifyKey,
  continueSuggestion,
  suggestionFor,
} from "./commandLine";

const key = (over: Record<string, unknown>) =>
  ({ key: "", ctrlKey: false, altKey: false, metaKey: false, ...over }) as never;

describe("classifyKey", () => {
  it("collects printable characters", () => {
    expect(classifyKey(key({ key: "l" }))).toEqual({ kind: "insert", text: "l" });
  });

  it("clears the line on Enter and on Ctrl+C", () => {
    expect(classifyKey(key({ key: "Enter" })).kind).toBe("reset");
    expect(classifyKey(key({ key: "c", ctrlKey: true })).kind).toBe("reset");
  });

  it("abandons on anything that may rewrite the line unseen", () => {
    // History recall is the dangerous one: the shell replaces the line and
    // only the echo says so, which we are not reading.
    for (const k of ["ArrowUp", "Tab", "Home", "Escape"]) {
      expect(classifyKey(key({ key: k })).kind).toBe("abandon");
    }
    expect(classifyKey(key({ key: "r", ctrlKey: true })).kind).toBe("abandon");
    expect(classifyKey(key({ key: "v", metaKey: true })).kind).toBe("abandon");
  });
});

describe("applyEdit", () => {
  it("builds and trims the line", () => {
    expect(applyEdit("l", { kind: "insert", text: "s" })).toBe("ls");
    expect(applyEdit("ls", { kind: "backspace" })).toBe("l");
    expect(applyEdit("ls", { kind: "reset" })).toBe("");
  });

  it("reports abandonment as null rather than an empty line", () => {
    expect(applyEdit("ls", { kind: "abandon" })).toBeNull();
  });
});

describe("suggestionFor", () => {
  it("keeps only the remainder of the first line", () => {
    expect(suggestionFor("git ch", "git checkout main\ngit push")).toBe(
      "eckout main",
    );
  });

  it("uses the answer as-is when the model did not echo", () => {
    expect(suggestionFor("git ch", "eckout main")).toBe("eckout main");
  });

  it("has nothing to offer for an empty answer", () => {
    expect(suggestionFor("ls", "   ")).toBe("");
  });
});

describe("continueSuggestion", () => {
  it("slices what the user has already typed of it", () => {
    expect(continueSuggestion("git ch", "eckout main", "git che")).toBe(
      "ckout main",
    );
  });

  it("gives up when the typing diverged", () => {
    expect(continueSuggestion("git ch", "eckout main", "git ci")).toBeNull();
  });

  it("gives up once the whole suggestion has been typed out", () => {
    expect(continueSuggestion("git ch", "eck", "git check")).toBeNull();
  });

  it("gives up on a backspace, which is not agreement", () => {
    expect(continueSuggestion("git ch", "eckout", "git c")).toBeNull();
  });
});
