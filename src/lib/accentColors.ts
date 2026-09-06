/**
 * Decorative accent hues, distinct from the theme primary and tuned to read on
 * both light and dark surfaces. Shared by spaces, terminal tabs and remote
 * hosts so the three surfaces speak one colour vocabulary.
 */
export const ACCENT_COLORS = [
  "oklch(0.62 0.17 254)", // blue
  "oklch(0.60 0.18 296)", // violet
  "oklch(0.65 0.16 162)", // emerald
  "oklch(0.74 0.16 78)", // amber
  "oklch(0.64 0.20 18)", // rose
  "oklch(0.68 0.13 212)", // cyan
  "oklch(0.68 0.18 44)", // orange
  "oklch(0.66 0.19 350)", // pink
] as const;

/** Parallel to ACCENT_COLORS, so a swatch can name itself to a screen reader. */
export const ACCENT_NAMES = [
  "Blue",
  "Violet",
  "Emerald",
  "Amber",
  "Rose",
  "Cyan",
  "Orange",
  "Pink",
] as const;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A colour safe to drop straight into a style attribute, or null when the
 * input is not one we recognise. Anything user-typed reaches CSS through here,
 * so an arbitrary string cannot smuggle in extra declarations.
 */
export function normalizeAccent(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if ((ACCENT_COLORS as readonly string[]).includes(raw)) return raw;
  const m = HEX.exec(raw);
  if (!m) return null;
  const body = m[1].toLowerCase();
  return body.length === 3
    ? `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
    : `#${body}`;
}
