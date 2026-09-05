import { describe, expect, it } from "vitest";
import { formatJumpSpec, parseJumpSpec } from "./jumps";

describe("parseJumpSpec", () => {
  it("parses a bare host", () => {
    expect(parseJumpSpec("bastion.example")).toEqual({
      user: null,
      host: "bastion.example",
      port: null,
    });
  });

  it("parses user, host and port", () => {
    expect(parseJumpSpec("ops@bastion.example:2222")).toEqual({
      user: "ops",
      host: "bastion.example",
      port: 2222,
    });
  });

  it("parses a bracketed IPv6 host with a port", () => {
    expect(parseJumpSpec("me@[::1]:2222")).toEqual({
      user: "me",
      host: "::1",
      port: 2222,
    });
  });

  it("treats a bare IPv6 address as a host with no port", () => {
    // Splitting on the last colon would turn fe80::1 into fe80: and 1.
    expect(parseJumpSpec("fe80::1")).toEqual({
      user: null,
      host: "fe80::1",
      port: null,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseJumpSpec("  bastion  ")?.host).toBe("bastion");
  });

  it("rejects entries that cannot be connected to", () => {
    expect(parseJumpSpec("")).toBeNull();
    expect(parseJumpSpec("   ")).toBeNull();
    expect(parseJumpSpec("@host")).toBeNull();
    expect(parseJumpSpec("host:notaport")).toBeNull();
    expect(parseJumpSpec("host:0")).toBeNull();
    expect(parseJumpSpec("host:70000")).toBeNull();
    expect(parseJumpSpec("[::1")).toBeNull();
  });

  it("keeps an @ inside the user portion", () => {
    // Domain-style usernames are real; only the last @ separates.
    expect(parseJumpSpec("me@corp@bastion")).toEqual({
      user: "me@corp",
      host: "bastion",
      port: null,
    });
  });
});

describe("formatJumpSpec", () => {
  it("round-trips a plain spec", () => {
    const spec = parseJumpSpec("ops@bastion:2222");
    expect(spec && formatJumpSpec(spec)).toBe("ops@bastion:2222");
  });

  it("re-brackets an IPv6 host", () => {
    const spec = parseJumpSpec("me@[::1]:22");
    expect(spec && formatJumpSpec(spec)).toBe("me@[::1]:22");
  });

  it("omits an absent user and port", () => {
    const spec = parseJumpSpec("bastion");
    expect(spec && formatJumpSpec(spec)).toBe("bastion");
  });
});
