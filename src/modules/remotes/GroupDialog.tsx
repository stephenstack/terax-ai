import { AccentPicker } from "@/components/AccentPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { useRemotesStore } from "./lib/store";
import type { RemoteGroup } from "./lib/types";

type Props = {
  group: RemoteGroup;
  onClose: () => void;
};

/**
 * Renaming a group and giving it a colour are the same act, so they share one
 * dialog rather than a prompt for the name and a menu for the colour.
 */
export function GroupDialog({ group, onClose }: Props) {
  const updateGroup = useRemotesStore((s) => s.updateGroup);
  const [name, setName] = useState(group.name);
  const [color, setColor] = useState(group.color);

  const save = () => {
    void updateGroup(group.id, { name, color });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit group</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] text-muted-foreground">Name</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] text-muted-foreground">
              Group color
            </Label>
            <AccentPicker
              current={color}
              clearLabel="Use the default"
              onPick={(value) => setColor(value || undefined)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
