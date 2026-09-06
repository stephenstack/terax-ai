import { describe, expect, it } from "vitest";
import { joinRemote, parentRemote } from "./browser";

describe("joinRemote", () => {
  it("does not double the separator at the root", () => {
    expect(joinRemote("/", "etc")).toBe("/etc");
  });

  it("joins under a nested directory", () => {
    expect(joinRemote("/home/me", "notes.txt")).toBe("/home/me/notes.txt");
  });
});

describe("parentRemote", () => {
  it("has no parent above the root", () => {
    expect(parentRemote("/")).toBeNull();
    expect(parentRemote("")).toBeNull();
  });

  it("returns the root rather than an empty string one level down", () => {
    expect(parentRemote("/etc")).toBe("/");
  });

  it("walks up a nested path", () => {
    expect(parentRemote("/home/me/src")).toBe("/home/me");
  });
});
