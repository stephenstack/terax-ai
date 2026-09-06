import {
  BUILD_CHANNEL,
  FORK_REPO_URL,
  IS_PREVIEW_BUILD,
  KEYRING_SERVICE,
  keyringServiceFor,
  PREVIEW_KEYRING_SERVICE,
  parseChannel,
  REPO_LABEL,
  REPO_URL,
  repoUrlFor,
  STABLE_KEYRING_SERVICE,
  UPDATER_ENABLED,
  UPSTREAM_REPO_URL,
  updaterEnabledFor,
} from "@/lib/channel";
import { describe, expect, it } from "vitest";

// The exported constants are fixed when this module is imported, so they
// describe whatever channel the test process itself is running as. CI runs this
// file twice, once with VITE_TERAX_CHANNEL unset and once with it set to
// `preview`, so both branches below are exercised on every release build.
const ACTIVE_RAW = import.meta.env.VITE_TERAX_CHANNEL;
const ACTIVE = parseChannel(ACTIVE_RAW);

describe("parseChannel", () => {
  it("resolves an unset or empty channel to stable", () => {
    for (const raw of [undefined, "", " ", "\n", "\t"]) {
      expect(parseChannel(raw)).toBe("stable");
    }
  });

  it("resolves an unknown channel to stable", () => {
    for (const raw of [
      "stable",
      "previews",
      "pre-view",
      "ssh-preview",
      "prevue",
      "beta",
      "1",
      "true",
    ]) {
      expect(parseChannel(raw)).toBe("stable");
    }
  });

  it("resolves preview in any supported casing or padding", () => {
    for (const raw of [
      "preview",
      "Preview",
      "PREVIEW",
      "  preview",
      "preview  ",
      "\tpreview\n",
    ]) {
      expect(parseChannel(raw)).toBe("preview");
    }
  });
});

describe("channel resolvers", () => {
  it("enables the updater on stable and disables it on preview", () => {
    expect(updaterEnabledFor("stable")).toBe(true);
    expect(updaterEnabledFor("preview")).toBe(false);
  });

  it("keeps a resolved channel's updater decision consistent end to end", () => {
    expect(updaterEnabledFor(parseChannel(undefined))).toBe(true);
    expect(updaterEnabledFor(parseChannel("nonsense"))).toBe(true);
    expect(updaterEnabledFor(parseChannel("PREVIEW"))).toBe(false);
  });

  it("gives each channel its own keychain service", () => {
    expect(STABLE_KEYRING_SERVICE).toBe("terax-ai");
    expect(PREVIEW_KEYRING_SERVICE).toBe("terax-ssh-preview");
    expect(keyringServiceFor("stable")).toBe(STABLE_KEYRING_SERVICE);
    expect(keyringServiceFor("preview")).toBe(PREVIEW_KEYRING_SERVICE);
    expect(keyringServiceFor("preview")).not.toBe(keyringServiceFor("stable"));
  });

  it("never lets a preview keychain name collide with the stable one", () => {
    expect(PREVIEW_KEYRING_SERVICE.startsWith(STABLE_KEYRING_SERVICE)).toBe(
      false,
    );
  });

  it("routes issues upstream on stable and to the fork on preview", () => {
    expect(repoUrlFor("stable")).toBe(UPSTREAM_REPO_URL);
    expect(repoUrlFor("preview")).toBe(FORK_REPO_URL);
  });
});

describe(`build constants (VITE_TERAX_CHANNEL=${ACTIVE_RAW ?? "unset"})`, () => {
  it("resolves BUILD_CHANNEL from the active environment", () => {
    expect(BUILD_CHANNEL).toBe(ACTIVE);
    expect(IS_PREVIEW_BUILD).toBe(ACTIVE === "preview");
  });

  it("exports the concrete values that channel calls for", () => {
    if (ACTIVE === "preview") {
      expect(BUILD_CHANNEL).toBe("preview");
      expect(IS_PREVIEW_BUILD).toBe(true);
      expect(UPDATER_ENABLED).toBe(false);
      expect(KEYRING_SERVICE).toBe("terax-ssh-preview");
      expect(REPO_URL).toBe(FORK_REPO_URL);
    } else {
      expect(BUILD_CHANNEL).toBe("stable");
      expect(IS_PREVIEW_BUILD).toBe(false);
      expect(UPDATER_ENABLED).toBe(true);
      expect(KEYRING_SERVICE).toBe("terax-ai");
      expect(REPO_URL).toBe(UPSTREAM_REPO_URL);
    }
  });

  it("derives every constant through its own resolver", () => {
    expect(UPDATER_ENABLED).toBe(updaterEnabledFor(BUILD_CHANNEL));
    expect(KEYRING_SERVICE).toBe(keyringServiceFor(BUILD_CHANNEL));
    expect(REPO_URL).toBe(repoUrlFor(BUILD_CHANNEL));
  });

  it("labels the repository without its host", () => {
    expect(REPO_LABEL).toBe(REPO_URL.replace("https://github.com/", ""));
    expect(REPO_LABEL).not.toContain("://");
  });
});
