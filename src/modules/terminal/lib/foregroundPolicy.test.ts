import { describe, expect, it } from "vitest";
import {
  remoteLeafHasForegroundProcess,
  remoteLeafHoldsSlot,
} from "./foregroundPolicy";

describe("remoteLeafHoldsSlot", () => {
  it("never releases a remote leaf's renderer slot", () => {
    // Releasing means the pane is later rebuilt from a serialized snapshot.
    // There is no remote `tcgetpgrp`, so we cannot know the pane is idle, and
    // replaying a snapshot over a live TUI is what corrupts it.
    expect(remoteLeafHoldsSlot()).toBe(true);
  });
});

describe("remoteLeafHasForegroundProcess", () => {
  it("reports busy only while a command boundary is open", () => {
    expect(remoteLeafHasForegroundProcess(true)).toBe(true);
    expect(remoteLeafHasForegroundProcess(false)).toBe(false);
  });
});
