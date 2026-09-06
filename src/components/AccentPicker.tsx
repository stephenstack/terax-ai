import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  normalizeAccent,
} from "@/lib/accentColors";
import { cn } from "@/lib/utils";

/**
 * Eight palette swatches plus a hex field, shared by the tab context menu and
 * the remote host editor so both offer the same vocabulary.
 */
export function AccentPicker({
  current,
  onPick,
  clearLabel,
}: {
  current: string | undefined;
  onPick: (value: string) => void;
  /** Label on the button that clears the accent. */
  clearLabel?: string;
}) {
  const [hex, setHex] = useState(current?.startsWith("#") ? current : "");
  const custom = normalizeAccent(hex);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-1.5">
        {ACCENT_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={ACCENT_NAMES[i]}
            aria-pressed={current === c}
            onClick={() => onPick(c)}
            className={cn(
              "flex h-6 items-center justify-center rounded-md ring-offset-1 ring-offset-popover transition",
              current === c && "ring-2 ring-ring",
            )}
            style={{ background: c }}
          >
            {current === c && (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={12}
                strokeWidth={2.5}
                className="text-white"
              />
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-5 shrink-0 rounded-md border border-border"
          style={custom ? { background: custom } : undefined}
        />
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (custom) onPick(custom);
          }}
          placeholder="#1a2b3c"
          aria-label="Custom colour as hex"
          aria-invalid={hex.trim() !== "" && !custom}
          spellCheck={false}
          className={cn(
            "h-6 w-full min-w-0 rounded-md border border-border bg-transparent px-1.5 font-mono text-[11px] outline-none focus:border-ring",
            hex.trim() !== "" && !custom && "border-destructive",
          )}
        />
      </div>
      <button
        type="button"
        onClick={() => onPick("")}
        disabled={!current}
        className="h-6 rounded-md text-[11.5px] text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {clearLabel ?? "Clear color"}
      </button>
    </div>
  );
}
