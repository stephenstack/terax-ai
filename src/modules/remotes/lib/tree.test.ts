import { describe, expect, it } from "vitest";
import {
  buildRemoteTree,
  nextGroupOrder,
  profileAddress,
  profileLabel,
  uniqueName,
  visibleProfiles,
} from "./tree";
import type { RemoteGroup, RemoteProfile } from "./types";

function profile(over: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id: "p1",
    name: "",
    groupId: null,
    host: "example.com",
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

function group(over: Partial<RemoteGroup> = {}): RemoteGroup {
  return {
    id: "g1",
    name: "Group",
    collapsed: false,
    order: 0,
    ...over,
  };
}

describe("profileAddress", () => {
  it("omits the port when it is the SSH default", () => {
    expect(profileAddress(profile())).toBe("me@example.com");
    expect(profileAddress(profile({ port: 22 }))).toBe("me@example.com");
  });

  it("includes a non-default port", () => {
    expect(profileAddress(profile({ port: 2222 }))).toBe("me@example.com:2222");
  });
});

describe("profileLabel", () => {
  it("prefers the name", () => {
    expect(profileLabel(profile({ name: "Prod web" }))).toBe("Prod web");
  });

  it("falls back to the address when the name is blank", () => {
    expect(profileLabel(profile({ name: "   " }))).toBe("me@example.com");
  });
});

describe("buildRemoteTree", () => {
  it("puts ungrouped hosts last", () => {
    const tree = buildRemoteTree(
      [
        profile({ id: "a", name: "Loose" }),
        profile({ id: "b", name: "Inside", groupId: "g1" }),
      ],
      [group()],
    );
    expect(tree.map((t) => t.group?.id ?? null)).toEqual(["g1", null]);
  });

  it("orders groups by their explicit order", () => {
    const tree = buildRemoteTree(
      [],
      [
        group({ id: "b", name: "Beta", order: 1 }),
        group({ id: "a", name: "Alpha", order: 0 }),
      ],
    );
    expect(tree.map((t) => t.group?.id)).toEqual(["a", "b"]);
  });

  it("sorts hosts by label within a group", () => {
    const tree = buildRemoteTree(
      [
        profile({ id: "1", name: "zeta", groupId: "g1" }),
        profile({ id: "2", name: "alpha", groupId: "g1" }),
      ],
      [group()],
    );
    expect(tree[0].profiles.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  it("keeps an empty group visible when not filtering", () => {
    const tree = buildRemoteTree([], [group()]);
    expect(tree).toHaveLength(1);
    expect(tree[0].profiles).toEqual([]);
  });

  it("drops groups with no matches while filtering", () => {
    const tree = buildRemoteTree(
      [profile({ id: "1", name: "web", groupId: "g1" })],
      [group(), group({ id: "g2", name: "Other", order: 1 })],
      "web",
    );
    expect(tree.map((t) => t.group?.id)).toEqual(["g1"]);
  });

  it("matches on name, host, and user", () => {
    const profiles = [
      profile({ id: "1", name: "Alpha", host: "a.example", user: "root" }),
      profile({ id: "2", name: "Beta", host: "b.example", user: "deploy" }),
    ];
    expect(buildRemoteTree(profiles, [], "alpha")[0].profiles).toHaveLength(1);
    expect(buildRemoteTree(profiles, [], "b.exam")[0].profiles).toHaveLength(1);
    expect(buildRemoteTree(profiles, [], "deploy")[0].profiles).toHaveLength(1);
  });

  it("filters case-insensitively and ignores surrounding space", () => {
    const tree = buildRemoteTree([profile({ name: "Production" })], [], "  PROD  ");
    expect(tree[0].profiles).toHaveLength(1);
  });

  it("surfaces a host whose group was deleted rather than hiding it", () => {
    const tree = buildRemoteTree(
      [profile({ id: "1", name: "Orphan", groupId: "gone" })],
      [],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].group).toBeNull();
    expect(tree[0].profiles[0].name).toBe("Orphan");
  });

  it("returns nothing when the query matches nothing", () => {
    expect(buildRemoteTree([profile({ name: "web" })], [], "zzz")).toEqual([]);
  });
});

describe("visibleProfiles", () => {
  it("skips the contents of a collapsed group", () => {
    const tree = buildRemoteTree(
      [
        profile({ id: "1", name: "Hidden", groupId: "g1" }),
        profile({ id: "2", name: "Shown" }),
      ],
      [group({ collapsed: true })],
    );
    expect(visibleProfiles(tree).map((p) => p.name)).toEqual(["Shown"]);
  });
});

describe("nextGroupOrder", () => {
  it("starts at zero and then follows the highest order", () => {
    expect(nextGroupOrder([])).toBe(0);
    expect(nextGroupOrder([group({ order: 0 }), group({ order: 4 })])).toBe(5);
  });
});

describe("uniqueName", () => {
  it("keeps a free name unchanged", () => {
    expect(uniqueName(["a"], "b")).toBe("b");
  });

  it("suffixes a collision", () => {
    expect(uniqueName(["Web"], "Web")).toBe("Web 2");
    expect(uniqueName(["Web", "Web 2"], "Web")).toBe("Web 3");
  });

  it("compares case-insensitively", () => {
    expect(uniqueName(["web"], "Web")).toBe("Web 2");
  });

  it("falls back to a default for an empty desired name", () => {
    expect(uniqueName([], "  ")).toBe("Host");
  });
});
