import type { Tab } from "./useTabs";

/**
 * A colour set on the tab itself wins, so a deliberate right-click choice is
 * never undone by editing the host. A remote tab with no colour of its own
 * inherits its host's, which is what makes the host setting permanent.
 */
export function resolveTabAccent(
  tab: Tab,
  hostColor: (remoteId: string) => string | undefined,
): string | undefined {
  if (tab.kind !== "terminal") return undefined;
  if (tab.color) return tab.color;
  return tab.remoteId ? hostColor(tab.remoteId) : undefined;
}
