import { ACCENT_COLORS } from "@/lib/accentColors";
import type { SpaceMeta } from "./store";

/** Indexed by SpaceMeta.color (opt-in). */
export const SPACE_COLORS = ACCENT_COLORS;

export function accentFor(space: Pick<SpaceMeta, "color">): string {
  const c = space.color;
  if (c != null && c >= 0 && c < SPACE_COLORS.length) return SPACE_COLORS[c];
  return "var(--primary)";
}

export function spaceInitial(name: string): string {
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : "?";
}
