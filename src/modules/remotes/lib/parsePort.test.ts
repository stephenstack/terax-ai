import { describe, expect, it } from "vitest";
import { parsePort } from "../HostDialog";

describe("parsePort", () => {
  it("treats an empty field as unset, meaning the SSH default", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort("   ")).toBeNull();
  });

  it("keeps a valid port unchanged", () => {
    expect(parsePort("22")).toBe(22);
    expect(parsePort("2222")).toBe(2222);
  });

  it("clamps out of range rather than failing at connect time", () => {
    // The backend takes a u16; 70000 would fail IPC deserialization with an
    // opaque error long after the user typed it.
    expect(parsePort("70000")).toBe(65535);
    expect(parsePort("0")).toBe(1);
    expect(parsePort("-5")).toBe(1);
  });

  it("rounds a fractional entry", () => {
    expect(parsePort("22.6")).toBe(23);
  });

  it("rejects junk", () => {
    expect(parsePort("abc")).toBeNull();
  });
});
