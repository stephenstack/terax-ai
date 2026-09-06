import { Button } from "@/components/ui/button";
import type { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** The compact toolbar button the panel's lower sections share. */
export function PanelIconButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof RefreshIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="size-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
    </Button>
  );
}
