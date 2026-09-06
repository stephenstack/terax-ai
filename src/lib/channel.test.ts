import {
  BUILD_CHANNEL,
  FORK_REPO_URL,
  IS_PREVIEW_BUILD,
  KEYRING_SERVICE,
  PREVIEW_KEYRING_SERVICE,
  parseChannel,
  REPO_LABEL,
  REPO_URL,
  STABLE_KEYRING_SERVICE,
  UPDATER_ENABLED,
  UPSTREAM_REPO_URL,
} from "@/lib/channel";
import { describe, expect, it } from "vitest";

describe("parseChannel", () => {
  it("selects preview for an exact match, whatever the case or padding", () => {
    for (const raw of [
      "preview",
      "  preview",
      "preview\n",
      "Preview",
      "PREVIEW",
    ]) {
      expect(parseChannel(raw)).toBe("preview");
    }
  });

  it("falls back to stable for anything else", () => {
    for (const raw of [
      undefined,
      "",
      " ",
      "stable",
      "previews",
      "pre-view",
      "ssh-preview",
      "1",
    ]) {
      expect(parseChannel(raw)).toBe("stable");
    }
  });
});

describe("build constants", () => {
  it("ties the updater to the channel", () => {
    expect(UPDATER_ENABLED).toBe(!IS_PREVIEW_BUILD);
    expect(IS_PREVIEW_BUILD).toBe(BUILD_CHANNEL === "preview");
  });

  it("keeps the updater on for a build with no channel set", () => {
    expect(BUILD_CHANNEL).toBe("stable");
    expect(UPDATER_ENABLED).toBe(true);
  });
});

describe("issue routing", () => {
  it("points a preview build at the fork and a stable build upstream", () => {
    expect(REPO_URL).toBe(IS_PREVIEW_BUILD ? FORK_REPO_URL : UPSTREAM_REPO_URL);
  });

  it("labels the repository without its host", () => {
    expect(REPO_LABEL).toBe(REPO_URL.replace("https://github.com/", ""));
    expect(REPO_LABEL).not.toContain("://");
  });
});

describe("credential isolation", () => {
  it("keeps the stable and preview keychain services distinct", () => {
    expect(STABLE_KEYRING_SERVICE).toBe("terax-ai");
    expect(PREVIEW_KEYRING_SERVICE).toBe("terax-ssh-preview");
    expect(PREVIEW_KEYRING_SERVICE).not.toBe(STABLE_KEYRING_SERVICE);
  });

  it("selects the service from the channel", () => {
    expect(KEYRING_SERVICE).toBe(
      IS_PREVIEW_BUILD ? PREVIEW_KEYRING_SERVICE : STABLE_KEYRING_SERVICE,
    );
  });

  it("never lets a preview name collide with the stable one", () => {
    expect(PREVIEW_KEYRING_SERVICE.startsWith(STABLE_KEYRING_SERVICE)).toBe(
      false,
    );
  });
});
