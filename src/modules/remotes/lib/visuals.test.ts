import { describe, expect, it } from "vitest";
import type { RemoteProfile } from "./types";
import { normalizeBackground, normalizeVisuals } from "./visuals";

function profile(over: Partial<RemoteProfile>): RemoteProfile {
  return {
    id: "p1",
    name: "host",
    groupId: null,
    host: "example.test",
    port: null,
    user: "me",
    auth: [],
    env: [],
    jumps: [],
    forwards: [],
    appearance: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("normalizeBackground", () => {
  it("drops a background with no image", () => {
    expect(normalizeBackground(undefined)).toBeUndefined();
    expect(
      normalizeBackground({ imageId: "", opacity: 1, blur: 0 }),
    ).toBeUndefined();
  });

  it("clamps opacity and blur into range", () => {
    expect(
      normalizeBackground({ imageId: "i", opacity: 4, blur: 900 }),
    ).toEqual({ imageId: "i", opacity: 1, blur: 64 });
    expect(
      normalizeBackground({ imageId: "i", opacity: -2, blur: -5 }),
    ).toEqual({ imageId: "i", opacity: 0, blur: 0 });
  });

  it("survives values that are not numbers at all", () => {
    const bad = {
      imageId: "i",
      opacity: Number.NaN,
      blur: Number.NaN,
    };
    expect(normalizeBackground(bad)).toEqual({
      imageId: "i",
      opacity: 0.5,
      blur: 0,
    });
  });
});

describe("normalizeVisuals", () => {
  it("keeps a colour it recognises", () => {
    expect(normalizeVisuals(profile({ color: "#AABBCC" })).color).toBe(
      "#aabbcc",
    );
  });

  it("drops a colour the editor could not have produced", () => {
    expect(
      normalizeVisuals(profile({ color: "red; position: fixed" })).color,
    ).toBeUndefined();
  });
});
