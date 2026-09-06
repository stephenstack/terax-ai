import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CloudServerIcon,
  Copy01Icon,
  Delete02Icon,
  FolderAddIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HostDialog } from "./HostDialog";
import { ImportConfigDialog } from "./ImportConfigDialog";
import { emptyProfile, useRemotesStore } from "./lib/store";
import { buildRemoteTree, profileAddress, profileLabel, uniqueName } from "./lib/tree";
import { describeForward, findActiveForward, useTunnelStore } from "./lib/tunnels";
import { toast } from "sonner";
import type { ActiveForward, RemoteForward, RemoteProfile } from "./lib/types";

type Props = {
  /** Open a terminal tab connected to this host. */
  onConnect: (profile: RemoteProfile) => void;
  /** Point the explorer, editor and source control at this host. */
  onOpenWorkspace: (profile: RemoteProfile) => void;
  /** Profile id of the remote workspace currently open, if any. */
  activeWorkspaceId: string | null;
  /** Connection id backing that workspace, which forwards ride on. */
  activeWorkspaceConn: number | null;
};

export function RemotesPanel({
  onConnect,
  onOpenWorkspace,
  activeWorkspaceId,
  activeWorkspaceConn,
}: Props) {
  const activeForwards = useTunnelStore((s) => s.active);
  const refreshForwards = useTunnelStore((s) => s.refresh);

  useEffect(() => {
    void refreshForwards();
  }, [refreshForwards]);

  const toggleForward = useCallback(
    (profile: RemoteProfile, forward: RemoteForward) => {
      const conn = activeWorkspaceId === profile.id ? activeWorkspaceConn : null;
      const running = findActiveForward(
        useTunnelStore.getState().active,
        conn ?? -1,
        forward,
      );
      if (running) {
        void useTunnelStore.getState().stop(running.id);
        return;
      }
      if (conn === null) return;
      void useTunnelStore
        .getState()
        .start(conn, forward)
        .then((info) => {
          toast.success(
            `Forwarding ${info.bindAddress}:${info.localPort} to ${info.remoteHost}:${info.remotePort}`,
          );
        })
        .catch((e) => {
          toast.error("Could not start the forward", {
            description: String(e),
          });
        });
    },
    [activeWorkspaceId, activeWorkspaceConn],
  );
  const profiles = useRemotesStore((s) => s.profiles);
  const groups = useRemotesStore((s) => s.groups);
  const hydrated = useRemotesStore((s) => s.hydrated);
  const init = useRemotesStore((s) => s.init);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<RemoteProfile | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const tree = useMemo(
    () => buildRemoteTree(profiles, groups, query),
    [profiles, groups, query],
  );

  // Pointer-based rather than HTML5 drag: the window keeps Tauri's file-drop
  // handler on for the explorer and terminal, which takes the webview's drop
  // target on Windows and leaves in-page dragstart/drop dead. Window listeners
  // rather than setPointerCapture, because capture retargets the compatibility
  // mouse events and would break the row's own click and double-click.
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    id: string;
    active: boolean;
  } | null>(null);
  const dropRef = useRef<string | null | undefined>(undefined);
  const listeners = useRef<((e: PointerEvent) => void)[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null | undefined>(
    undefined,
  );

  const detach = useCallback(() => {
    const l = listeners.current;
    if (!l) return;
    window.removeEventListener("pointermove", l[0]);
    window.removeEventListener("pointerup", l[1]);
    window.removeEventListener("pointercancel", l[1]);
    listeners.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  const onDragPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    detach();
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      id,
      active: false,
    };

    const move = (ev: PointerEvent) => {
      const st = drag.current;
      if (!st || st.pointerId !== ev.pointerId) return;
      if (!st.active) {
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < 5)
          return;
        st.active = true;
        setDraggingId(st.id);
        document.body.style.userSelect = "none";
      }
      const hit = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest("[data-drop='group']");
      const raw = hit?.getAttribute("data-group-id");
      const next = raw == null ? undefined : raw === "" ? null : raw;
      dropRef.current = next;
      setDropGroupId(next);
    };

    const up = () => {
      const st = drag.current;
      const target = dropRef.current;
      if (st?.active && target !== undefined) {
        const store = useRemotesStore.getState();
        const moved = store.profiles.find((p) => p.id === st.id);
        if (moved && moved.groupId !== target) {
          void store.moveToGroup(st.id, target);
        }
      }
      drag.current = null;
      dropRef.current = undefined;
      setDraggingId(null);
      setDropGroupId(undefined);
      document.body.style.userSelect = "";
      detach();
    };

    listeners.current = [move, up];
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        onAddHost={() => setEditing(emptyProfile())}
        onAddGroup={() => void useRemotesStore.getState().createGroup("New group")}
        onImport={() => setImporting(true)}
      />

      <div className="px-2 pb-1.5">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={12}
            strokeWidth={1.9}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter hosts"
            spellCheck={false}
            className="h-7 rounded-md border-border/60 bg-foreground/[0.03] pl-7 text-[11.5px]"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!hydrated ? null : profiles.length === 0 ? (
          <EmptyState
            onAddHost={() => setEditing(emptyProfile())}
            onImport={() => setImporting(true)}
          />
        ) : tree.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            No hosts match "{query}".
          </p>
        ) : (
          tree.map(({ group, profiles: rows }) => (
            <GroupSection
              key={group?.id ?? "__ungrouped"}
              group={group}
              rows={rows}
              groups={groups}
              allNames={profiles.map((p) => p.name)}
              isDropTarget={
                draggingId !== null && dropGroupId === (group?.id ?? null)
              }
              draggingId={draggingId}
              onDragPointerDown={onDragPointerDown}
              onConnect={onConnect}
              onOpenWorkspace={onOpenWorkspace}
              activeWorkspaceId={activeWorkspaceId}
              onToggleForward={toggleForward}
              activeForwards={activeForwards}
              activeWorkspaceConn={activeWorkspaceConn}
              onEdit={setEditing}
            />
          ))
        )}
        {draggingId !== null && tree.every(({ group }) => group !== null) ? (
          // Every host is grouped, so the tree renders no ungrouped section and
          // a drag would have nowhere to drop a host back out to.
          <div
            data-drop="group"
            data-group-id=""
            className={cn(
              "mx-2 mt-1 rounded-md border border-dashed border-border px-2.5 py-2 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground/85 transition-colors",
              dropGroupId === null && "border-primary/40 bg-primary/10",
            )}
          >
            Ungrouped
          </div>
        ) : null}
      </div>

      {editing ? (
        <HostDialog
          profile={editing}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {importing ? (
        <ImportConfigDialog onClose={() => setImporting(false)} />
      ) : null}
    </div>
  );
}

function Header({
  onAddHost,
  onAddGroup,
  onImport,
}: {
  onAddHost: () => void;
  onAddGroup: () => void;
  onImport: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-1 px-2.5 pb-1.5 pt-2.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        Remotes
      </span>
      <div className="flex items-center gap-0.5">
        <IconAction icon={PlusSignIcon} label="New host" onClick={onAddHost} />
        <IconAction
          icon={FolderAddIcon}
          label="New group"
          onClick={onAddGroup}
        />
        <IconAction
          icon={CloudServerIcon}
          label="Import from ~/.ssh/config"
          onClick={onImport}
        />
      </div>
    </div>
  );
}

function IconAction({
  icon,
  label,
  onClick,
}: {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="size-6 rounded-md text-muted-foreground hover:text-foreground"
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.9} />
    </Button>
  );
}

type HostDragProps = {
  draggingId: string | null;
  onDragPointerDown: (e: React.PointerEvent, id: string) => void;
};

function GroupSection({
  group,
  rows,
  groups,
  allNames,
  isDropTarget,
  draggingId,
  onDragPointerDown,
  onConnect,
  onOpenWorkspace,
  activeWorkspaceId,
  onToggleForward,
  activeForwards,
  activeWorkspaceConn,
  onEdit,
}: {
  group: { id: string; name: string; collapsed: boolean } | null;
  rows: RemoteProfile[];
  groups: Array<{ id: string; name: string }>;
  allNames: string[];
  isDropTarget: boolean;
  onConnect: (profile: RemoteProfile) => void;
  onOpenWorkspace: (profile: RemoteProfile) => void;
  activeWorkspaceId: string | null;
  onToggleForward: (profile: RemoteProfile, forward: RemoteForward) => void;
  activeForwards: ActiveForward[];
  activeWorkspaceConn: number | null;
  onEdit: (profile: RemoteProfile) => void;
} & HostDragProps) {
  const store = useRemotesStore.getState();
  const collapsed = group?.collapsed ?? false;

  return (
    <div
      data-drop="group"
      data-group-id={group?.id ?? ""}
      className={cn(
        "mb-0.5 rounded-md transition-colors",
        isDropTarget && "bg-primary/10 outline outline-1 outline-primary/40",
      )}
    >
      {group ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => void store.toggleGroup(group.id)}
              className="flex w-full cursor-pointer items-center gap-1 px-2.5 py-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85 transition-colors hover:text-foreground"
            >
              <HugeiconsIcon
                icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
                size={12}
                strokeWidth={2}
                className="shrink-0"
              />
              <span className="truncate">{group.name}</span>
              <span className="ml-auto tabular-nums text-muted-foreground/60">
                {rows.length}
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem
              onSelect={() => {
                const name = window.prompt("Group name", group.name);
                if (name) void store.renameGroup(group.id, name);
              }}
            >
              <HugeiconsIcon icon={PencilEdit02Icon} size={13} />
              Rename group
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => void store.deleteGroup(group.id)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={13} />
              Delete group
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : rows.length > 0 && groups.length > 0 ? (
        <div className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
          Ungrouped
        </div>
      ) : null}

      {collapsed
        ? null
        : rows.map((profile) => (
            <HostRow
              key={profile.id}
              profile={profile}
              indented={group !== null}
              groups={groups}
              allNames={allNames}
              isDragging={draggingId === profile.id}
              onDragPointerDown={onDragPointerDown}
              onConnect={onConnect}
              onOpenWorkspace={onOpenWorkspace}
              activeWorkspaceId={activeWorkspaceId}
              onToggleForward={onToggleForward}
              activeForwards={activeForwards}
              activeWorkspaceConn={activeWorkspaceConn}
              onEdit={onEdit}
            />
          ))}
    </div>
  );
}

function HostRow({
  profile,
  indented,
  groups,
  allNames,
  isDragging,
  onDragPointerDown,
  onConnect,
  onOpenWorkspace,
  activeWorkspaceId,
  onToggleForward,
  activeForwards,
  activeWorkspaceConn,
  onEdit,
}: {
  profile: RemoteProfile;
  /** Hosts sit under their group heading, ungrouped ones stay flush. */
  indented: boolean;
  groups: Array<{ id: string; name: string }>;
  allNames: string[];
  isDragging: boolean;
  onConnect: (profile: RemoteProfile) => void;
  onOpenWorkspace: (profile: RemoteProfile) => void;
  activeWorkspaceId: string | null;
  onToggleForward: (profile: RemoteProfile, forward: RemoteForward) => void;
  activeForwards: ActiveForward[];
  activeWorkspaceConn: number | null;
  onEdit: (profile: RemoteProfile) => void;
} & Omit<HostDragProps, "draggingId">) {
  const store = useRemotesStore.getState();
  const isWorkspace = activeWorkspaceId === profile.id;
  // Forwards ride on this profile's own connection, which only exists while
  // it is the open workspace.
  const connForProfile = isWorkspace ? activeWorkspaceConn : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onPointerDown={(e) => onDragPointerDown(e, profile.id)}
          className={cn(
            "group flex w-full items-center gap-2 py-[5px] pe-2.5 transition-colors",
            indented ? "ps-5" : "ps-2.5",
            "hover:bg-foreground/[0.045] focus-within:bg-foreground/[0.06]",
            isDragging && "opacity-50",
          )}
        >
          <span
            aria-hidden
            title={isWorkspace ? "Open as workspace" : undefined}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              isWorkspace && "ring-2 ring-primary/50",
            )}
            style={{ background: profile.color ?? "var(--muted-foreground)" }}
          />
          {/* The row itself connects; a nested button would be invalid markup,
              so the visible Connect affordance is a sibling. */}
          <button
            type="button"
            onDoubleClick={() => onConnect(profile)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConnect(profile);
            }}
            title={profileAddress(profile)}
            className="min-w-0 flex-1 cursor-pointer text-left outline-none"
          >
            <span className="block truncate text-[11.5px] leading-tight text-foreground">
              {profileLabel(profile)}
            </span>
            <span className="block truncate text-[10.5px] leading-tight text-muted-foreground/80">
              {profileAddress(profile)}
            </span>
          </button>
          <button
            type="button"
            data-no-drag
            aria-label={`Connect to ${profileLabel(profile)}`}
            onClick={() => onConnect(profile)}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            Connect
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onConnect(profile)}>
          Open terminal
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenWorkspace(profile)}>
          {isWorkspace ? "Reopen as workspace" : "Open as workspace"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onEdit(profile)}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={13} />
          Edit
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            const now = Date.now();
            void store.saveProfile({
              ...profile,
              id: crypto.randomUUID(),
              name: uniqueName(allNames, profileLabel(profile)),
              createdAt: now,
              updatedAt: now,
            });
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} size={13} />
          Duplicate
        </ContextMenuItem>
        {(profile.forwards ?? []).length > 0 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Port forwards</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-64">
              {(profile.forwards ?? []).map((forward) => {
                const running = findActiveForward(
                  activeForwards,
                  connForProfile ?? -1,
                  forward,
                );
                return (
                  <ContextMenuItem
                    key={forward.id}
                    disabled={connForProfile === null && !running}
                    onSelect={() => onToggleForward(profile, forward)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {forward.label?.trim() || describeForward(forward)}
                    </span>
                    <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                      {running ? `stop :${running.localPort}` : "start"}
                    </span>
                  </ContextMenuItem>
                );
              })}
              {connForProfile === null ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled>
                    Open as workspace first
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        {groups.length > 0 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Move to group</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-40">
              <ContextMenuItem
                onSelect={() => void store.moveToGroup(profile.id, null)}
              >
                Ungrouped
              </ContextMenuItem>
              <ContextMenuSeparator />
              {groups.map((g) => (
                <ContextMenuItem
                  key={g.id}
                  onSelect={() => void store.moveToGroup(profile.id, g.id)}
                >
                  {g.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => void store.deleteProfile(profile.id)}
        >
          <HugeiconsIcon icon={Delete02Icon} size={13} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EmptyState({
  onAddHost,
  onImport,
}: {
  onAddHost: () => void;
  onImport: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <HugeiconsIcon
        icon={CloudServerIcon}
        size={22}
        strokeWidth={1.5}
        className="text-muted-foreground/50"
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        No remote hosts yet. Add one, or import the hosts already in your
        <code className="mx-1">~/.ssh/config</code>.
      </p>
      <div className="mt-1 flex gap-2">
        <Button size="sm" variant="outline" onClick={onAddHost}>
          Add host
        </Button>
        <Button size="sm" variant="ghost" onClick={onImport}>
          Import
        </Button>
      </div>
    </div>
  );
}
