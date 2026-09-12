import { describe, expect, it } from "vitest";
import {
  applyImport,
  configHostKey,
  expandHome,
  exportFileName,
  parseExport,
  profileFromConfigHost,
  profileKey,
  serializeExport,
  type RemotesExport,
} from "./transfer";
import type { RemoteGroup, RemoteProfile, SshConfigHost } from "./types";

function profile(over: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id: "p1",
    name: "Web",
    groupId: null,
    host: "web.example",
    port: null,
    user: "deploy",
    auth: [{ kind: "agent" }],
    env: [],
    jumps: [],
    forwards: [],
    appearance: {},
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function group(over: Partial<RemoteGroup> = {}): RemoteGroup {
  return { id: "g1", name: "Production", collapsed: false, order: 0, ...over };
}

function configHost(over: Partial<SshConfigHost> = {}): SshConfigHost {
  return {
    alias: "web",
    hostname: "web.example",
    user: "deploy",
    port: null,
    identity_files: [],
    proxy_jump: null,
    forward_agent: null,
    identities_only: null,
    connect_timeout: null,
    server_alive_interval: null,
    compression: null,
    ...over,
  };
}

function roundTrip(profiles: RemoteProfile[], groups: RemoteGroup[]): RemotesExport {
  const result = parseExport(serializeExport(profiles, groups));
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("serializeExport / parseExport", () => {
  it("round-trips hosts and groups", () => {
    const data = roundTrip(
      [profile({ groupId: "g1", port: 2222, jumps: ["bastion"] })],
      [group()],
    );
    expect(data.groups).toHaveLength(1);
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0]?.port).toBe(2222);
    expect(data.profiles[0]?.jumps).toEqual(["bastion"]);
  });

  it("drops the background, whose image only exists on the source machine", () => {
    const data = roundTrip(
      [profile({ background: { imageId: "img-1", opacity: 0.5, blur: 4 } })],
      [],
    );
    expect(data.profiles[0]?.background).toBeUndefined();
  });

  it("refuses a file that is not a Terax export", () => {
    expect(parseExport("{}")).toMatchObject({ ok: false });
    expect(parseExport("nonsense")).toMatchObject({ ok: false });
    expect(parseExport('{"kind":"terax-theme","version":1}')).toMatchObject({
      ok: false,
    });
  });

  it("refuses a format written by a newer Terax rather than guessing", () => {
    const result = parseExport(
      '{"kind":"terax-remotes","version":99,"profiles":[],"groups":[]}',
    );
    expect(result.ok).toBe(false);
  });

  it("never carries a secret into the profile store", () => {
    const result = parseExport(
      JSON.stringify({
        kind: "terax-remotes",
        version: 1,
        groups: [],
        profiles: [
          {
            host: "web.example",
            user: "deploy",
            auth: [
              { kind: "password", password: "hunter2" },
              { kind: "keyFile", path: "~/.ssh/id_ed25519", passphrase: "s3cret" },
            ],
          },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.data.profiles[0]?.auth).toEqual([
      { kind: "password" },
      { kind: "keyFile", path: "~/.ssh/id_ed25519" },
    ]);
  });

  it("rejects values that would reach a style attribute or a port", () => {
    const result = parseExport(
      JSON.stringify({
        kind: "terax-remotes",
        version: 1,
        groups: [],
        profiles: [
          {
            host: "web.example",
            user: "deploy",
            color: "red; background: url(evil)",
            port: 999_999,
            auth: [{ kind: "nope" }],
          },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.data.profiles[0]?.color).toBeUndefined();
    expect(result.data.profiles[0]?.port).toBeNull();
    expect(result.data.profiles[0]?.auth).toEqual([]);
  });

  it("drops an entry with no address instead of importing a dead row", () => {
    const result = parseExport(
      JSON.stringify({
        kind: "terax-remotes",
        version: 1,
        groups: [group()],
        profiles: [{ user: "deploy" }],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.data.profiles).toEqual([]);
  });
});

describe("applyImport", () => {
  const data: RemotesExport = {
    kind: "terax-remotes",
    version: 1,
    exportedAt: 0,
    groups: [group({ id: "in-g" })],
    profiles: [
      profile({ id: "in-1", groupId: "in-g" }),
      profile({ id: "in-2", name: "Db", host: "db.example" }),
    ],
  };
  const all = new Set(["in-1", "in-2"]);

  it("adds the chosen hosts and their groups", () => {
    const out = applyImport({ profiles: [], groups: [] }, data, all, "skip");
    expect(out.added).toBe(2);
    expect(out.groupsAdded).toBe(1);
    expect(out.groups[0]?.id).not.toBe("in-g");
    expect(out.profiles[0]?.groupId).toBe(out.groups[0]?.id);
  });

  it("only imports what is selected", () => {
    const out = applyImport(
      { profiles: [], groups: [] },
      data,
      new Set(["in-2"]),
      "skip",
    );
    expect(out.added).toBe(1);
    expect(out.groupsAdded).toBe(0);
    expect(out.profiles[0]?.host).toBe("db.example");
  });

  it("reuses a group of the same name rather than duplicating it", () => {
    const existing = { profiles: [], groups: [group({ id: "local-g" })] };
    const out = applyImport(existing, data, all, "skip");
    expect(out.groups).toHaveLength(1);
    expect(out.groupsAdded).toBe(0);
    expect(out.profiles[0]?.groupId).toBe("local-g");
  });

  it("skips a host already here", () => {
    const existing = { profiles: [profile({ id: "local-1" })], groups: [] };
    const out = applyImport(existing, data, all, "skip");
    expect(out.skipped).toBe(1);
    expect(out.added).toBe(1);
    expect(out.profiles).toHaveLength(2);
  });

  it("replaces in place, keeping the local id so open tabs keep resolving", () => {
    const existing = {
      profiles: [profile({ id: "local-1", name: "Old", createdAt: 7 })],
      groups: [],
    };
    const out = applyImport(existing, data, all, "replace");
    expect(out.replaced).toBe(1);
    const web = out.profiles.find((p) => p.host === "web.example");
    expect(web?.id).toBe("local-1");
    expect(web?.createdAt).toBe(7);
    expect(web?.name).toBe("Web");
  });

  it("imports duplicates as copies with a name that does not collide", () => {
    const existing = { profiles: [profile({ id: "local-1" })], groups: [] };
    const out = applyImport(existing, data, all, "copy");
    expect(out.added).toBe(2);
    expect(out.skipped).toBe(0);
    expect(out.profiles.map((p) => p.name)).toEqual(["Web", "Web 2", "Db"]);
  });

  it("carries over a group that held no hosts at all", () => {
    const empty: RemotesExport = {
      ...data,
      groups: [group({ id: "in-g" }), group({ id: "in-empty", name: "Staging" })],
    };
    const out = applyImport({ profiles: [], groups: [] }, empty, all, "skip");
    expect(out.groups.map((g) => g.name)).toEqual(["Production", "Staging"]);
  });

  it("orphans a host whose group was not carried over", () => {
    const out = applyImport(
      { profiles: [], groups: [] },
      data,
      new Set(["in-2"]),
      "skip",
    );
    expect(out.profiles[0]?.groupId).toBeNull();
  });

  it("leaves the store untouched when nothing is selected", () => {
    const existing = { profiles: [profile()], groups: [group()] };
    const out = applyImport(existing, data, new Set(), "skip");
    expect(out).toMatchObject({ added: 0, replaced: 0, skipped: 0, groupsAdded: 0 });
    expect(out.profiles).toEqual(existing.profiles);
  });
});

describe("profileFromConfigHost", () => {
  it("keeps the alias as the name and orders auth key-file first", () => {
    const p = profileFromConfigHost(
      configHost({ identity_files: ["~/.ssh/work"], proxy_jump: "a, b" }),
      [],
    );
    expect(p.name).toBe("web");
    expect(p.auth).toEqual([
      { kind: "keyFile", path: "~/.ssh/work" },
      { kind: "agent" },
      { kind: "password" },
    ]);
    expect(p.jumps).toEqual(["a", "b"]);
  });

  it("drops the agent when IdentitiesOnly is set", () => {
    const p = profileFromConfigHost(
      configHost({ identity_files: ["k"], identities_only: true }),
      [],
    );
    expect(p.auth.some((a) => a.kind === "agent")).toBe(false);
  });

  it("does not collide with a name already taken", () => {
    expect(profileFromConfigHost(configHost(), ["web"]).name).toBe("web 2");
  });

  it("keys a config entry the same way a stored profile keys itself", () => {
    const host = configHost({ port: 2222 });
    expect(configHostKey(host)).toBe(profileKey(profileFromConfigHost(host, [])));
  });
});

describe("expandHome", () => {
  it("expands a leading tilde and leaves anything else alone", () => {
    expect(expandHome("~/exports/a.json", "/home/me")).toBe(
      "/home/me/exports/a.json",
    );
    expect(expandHome("~", "/home/me/")).toBe("/home/me");
    expect(expandHome("/tmp/a.json", "/home/me")).toBe("/tmp/a.json");
    expect(expandHome("~notme/a", "/home/me")).toBe("~notme/a");
  });
});

describe("exportFileName", () => {
  it("dates the file so successive exports do not overwrite", () => {
    expect(exportFileName(new Date(2026, 2, 7))).toBe(
      "terax-remotes-2026-03-07.json",
    );
  });
});
