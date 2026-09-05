import type { TerminalCursorStyle } from "@/modules/settings/store";

/**
 * Terminal appearance a single session may override.
 *
 * Lives in the terminal module because the renderer pool is what consumes it;
 * remote profiles re-export this as their appearance shape so there is exactly
 * one definition and no dependency from the terminal back onto remotes.
 */
export type TerminalAppearanceOverride = {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  letterSpacing?: number;
  cursorStyle?: TerminalCursorStyle;
  cursorBlink?: boolean;
  scrollback?: number;
};

/** The global preference values an override is resolved against. */
export type TerminalAppearance = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  letterSpacing: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
};

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 72;
const MAX_SCROLLBACK = 100_000;

function normalizeSize(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

function normalizeScrollback(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_SCROLLBACK, Math.max(0, Math.round(value)));
}

/**
 * True when an override actually changes something.
 *
 * The renderer pool shares one configuration across its slots, so a session
 * with overrides may only push them while it is the focused pane. A session
 * with none pushes the global values unconditionally, exactly as every local
 * terminal already does.
 */
export function hasAppearanceOverrides(
  appearance: TerminalAppearanceOverride | undefined,
): boolean {
  if (!appearance) return false;
  return Object.values(appearance).some((v) => v !== undefined);
}

export function resolveAppearance(
  base: TerminalAppearance,
  appearance: TerminalAppearanceOverride | undefined,
): TerminalAppearance {
  if (!appearance) return base;
  return {
    fontFamily: appearance.fontFamily?.trim() || base.fontFamily,
    fontSize: normalizeSize(appearance.fontSize) ?? base.fontSize,
    fontWeight: appearance.fontWeight?.trim() || base.fontWeight,
    letterSpacing: appearance.letterSpacing ?? base.letterSpacing,
    cursorStyle: appearance.cursorStyle ?? base.cursorStyle,
    cursorBlink: appearance.cursorBlink ?? base.cursorBlink,
    scrollback: normalizeScrollback(appearance.scrollback) ?? base.scrollback,
  };
}

/**
 * Drop fields that match the base so a profile never pins a value it did not
 * deliberately change. Without this, editing a host would freeze whatever the
 * global font happened to be at the time.
 */
export function pruneAppearance(
  base: TerminalAppearance,
  appearance: TerminalAppearanceOverride,
): TerminalAppearanceOverride {
  const out: TerminalAppearanceOverride = {};
  const size = normalizeSize(appearance.fontSize);
  const scrollback = normalizeScrollback(appearance.scrollback);
  const family = appearance.fontFamily?.trim();
  const weight = appearance.fontWeight?.trim();

  if (family && family !== base.fontFamily) out.fontFamily = family;
  if (size !== undefined && size !== base.fontSize) out.fontSize = size;
  if (weight && weight !== base.fontWeight) out.fontWeight = weight;
  if (
    appearance.letterSpacing !== undefined &&
    appearance.letterSpacing !== base.letterSpacing
  ) {
    out.letterSpacing = appearance.letterSpacing;
  }
  if (appearance.cursorStyle && appearance.cursorStyle !== base.cursorStyle) {
    out.cursorStyle = appearance.cursorStyle;
  }
  if (
    appearance.cursorBlink !== undefined &&
    appearance.cursorBlink !== base.cursorBlink
  ) {
    out.cursorBlink = appearance.cursorBlink;
  }
  if (scrollback !== undefined && scrollback !== base.scrollback) {
    out.scrollback = scrollback;
  }
  return out;
}
