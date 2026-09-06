import { normalizeAccent } from "@/lib/accentColors";
import type { RemoteBackground, RemoteProfile } from "./types";

const MAX_BLUR = 64;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

export function normalizeBackground(
  background: RemoteBackground | undefined,
): RemoteBackground | undefined {
  if (!background?.imageId) return undefined;
  return {
    imageId: background.imageId,
    opacity: clamp01(background.opacity),
    blur: Number.isFinite(background.blur)
      ? Math.min(MAX_BLUR, Math.max(0, Math.round(background.blur)))
      : 0,
  };
}

/**
 * The store file is editable by hand and both values reach a style attribute,
 * so they are validated on the way in rather than trusted at render time.
 */
export function normalizeVisuals(
  profile: RemoteProfile,
): Pick<RemoteProfile, "color" | "background"> {
  return {
    color: profile.color ? (normalizeAccent(profile.color) ?? undefined) : undefined,
    background: normalizeBackground(profile.background),
  };
}
