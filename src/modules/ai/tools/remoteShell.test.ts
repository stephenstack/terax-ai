import { describe, expect, it } from "vitest";
import { splitCwd, wrapForCwd } from "./remoteShell";

describe("wrapForCwd", () => {
  it("keeps the command's exit status rather than the echo's", () => {
    const w = wrapForCwd("false");
    expect(w).toContain("__terax_rc=$?");
    expect(w.trimEnd().endsWith("exit $__terax_rc")).toBe(true);
  });

  it("groups a multi-line command so the whole thing is measured", () => {
    expect(wrapForCwd("cd foo\nls")).toContain("{ cd foo\nls\n}");
  });
});

describe("splitCwd", () => {
  it("takes the directory off the end and leaves the output", () => {
    const raw = "total 0\nterax-cwd:/srv/app";
    expect(splitCwd(raw)).toEqual({ stdout: "total 0\n", cwd: "/srv/app" });
  });

  it("returns the output untouched when nothing was appended", () => {
    // A command that killed the shell never reaches the echo.
    expect(splitCwd("boom")).toEqual({ stdout: "boom", cwd: null });
  });

  it("uses the last marker, so output containing one cannot spoof it", () => {
    const raw = "terax-cwd:/fake\nreal\nterax-cwd:/srv";
    expect(splitCwd(raw).cwd).toBe("/srv");
  });
});
