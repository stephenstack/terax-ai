import { PanelIconButton } from "./PanelIconButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { quoteShellArg } from "@/lib/shellQuote";
import type { DirEntry } from "@/modules/explorer/lib/useFileTree";
import type { RemoteIconSet } from "@/modules/settings/store";
import {
  ArrowUp01Icon,
  Copy01Icon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  Folder01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  browserEnv,
  joinRemote,
  parentRemote,
  useRemoteBrowserStore,
} from "./lib/browser";
import {
  iconSetsVersion,
  loadIconSet,
  remoteFileIconUrl,
  remoteFolderIconUrl,
  subscribeIconSets,
} from "./lib/icons";

export function RemoteFiles({
  onRunInTerminal,
  onOpenFile,
}: {
  /** Send a line to the active terminal, used for "cd here". */
  onRunInTerminal?: (line: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const conn = useRemoteBrowserStore((s) => s.conn);
  const cwd = useRemoteBrowserStore((s) => s.cwd);
  const entries = useRemoteBrowserStore((s) => s.entries);
  const loading = useRemoteBrowserStore((s) => s.loading);
  const connecting = useRemoteBrowserStore((s) => s.connecting);
  const error = useRemoteBrowserStore((s) => s.error);
  const showHidden = useRemoteBrowserStore((s) => s.showHidden);
  const iconSet = usePreferencesStore((s) => s.remoteIconSet);
  const followTerminal = usePreferencesStore((s) => s.remoteFollowTerminal);
  const store = useRemoteBrowserStore.getState;

  useEffect(() => loadIconSet(iconSet), [iconSet]);
  // The URLs change the moment a set finishes arriving, so the rows have to be
  // told; the set itself is module state rather than a store.
  useSyncExternalStore(subscribeIconSets, iconSetsVersion);

  const up = parentRemote(cwd);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await store().authorizeCwd();
      await fn();
      await store().refresh();
    } catch (e) {
      toast.error(label, { description: String(e) });
    }
  };

  const createEntry = (kind: "file" | "dir") => {
    const name = window.prompt(kind === "dir" ? "New folder" : "New file");
    if (!name?.trim()) return;
    const env = browserEnv();
    if (!env) return;
    const path = joinRemote(cwd, name.trim());
    void act(`Could not create ${name.trim()}`, () =>
      invoke(kind === "dir" ? "fs_create_dir" : "fs_create_file", {
        path,
        workspace: env,
      }),
    );
  };

  if (connecting) {
    return <Placeholder text="Connecting" />;
  }
  if (conn === null) {
    return <Placeholder text="Open a host to browse its files" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <PanelIconButton
          label="Up one level"
          icon={ArrowUp01Icon}
          disabled={!up}
          onClick={() => {
            if (!up) return;
            // Same rule as entering one: the terminal leads while following.
            if (followTerminal && onRunInTerminal) {
              onRunInTerminal(`cd ${quoteShellArg(up, false)}`);
            } else {
              void store().navigate(up);
            }
          }}
        />
        <PanelIconButton
          label="New file"
          icon={PlusSignIcon}
          onClick={() => createEntry("file")}
        />
        <PanelIconButton
          label="New folder"
          icon={Folder01Icon}
          onClick={() => createEntry("dir")}
        />
        <PanelIconButton
          label={showHidden ? "Hide hidden files" : "Show hidden files"}
          icon={showHidden ? ViewIcon : ViewOffSlashIcon}
          onClick={() => store().setShowHidden(!showHidden)}
        />
        <PanelIconButton
          label="Refresh"
          icon={RefreshIcon}
          onClick={() => void store().refresh()}
        />
      </div>

      <div
        className="truncate px-2.5 pb-1 text-[10.5px] text-muted-foreground/85"
        title={cwd}
      >
        {cwd}
      </div>

      {error ? (
        <p className="px-2.5 py-2 text-[11px] text-destructive">{error}</p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {loading && entries.length === 0 ? (
          <Placeholder text="Loading" />
        ) : entries.length === 0 ? (
          <Placeholder text="Empty" />
        ) : (
          entries.map((entry) => (
            <Row
              key={entry.name}
              entry={entry}
              cwd={cwd}
              iconSet={iconSet}
              followTerminal={followTerminal}
              onRunInTerminal={onRunInTerminal}
              onOpenFile={onOpenFile}
              onAct={act}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  entry,
  cwd,
  iconSet,
  followTerminal,
  onRunInTerminal,
  onOpenFile,
  onAct,
}: {
  entry: DirEntry;
  cwd: string;
  iconSet: RemoteIconSet;
  followTerminal: boolean;
  onRunInTerminal?: (line: string) => void;
  onOpenFile?: (path: string) => void;
  onAct: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const path = joinRemote(cwd, entry.name);
  const isDir = entry.kind === "dir";
  const iconUrl = isDir
    ? remoteFolderIconUrl(iconSet, entry.name)
    : remoteFileIconUrl(iconSet, entry.name);
  const store = useRemoteBrowserStore.getState;

  // While the tree follows the terminal, walking it on its own would be undone
  // by the next prompt. Moving the terminal is what moves both.
  const cd = () => onRunInTerminal?.(`cd ${quoteShellArg(path, false)}`);
  const enterDir = () => {
    if (followTerminal && onRunInTerminal) cd();
    else void store().navigate(path);
  };

  const rename = () => {
    const next = window.prompt("Rename to", entry.name);
    if (!next?.trim() || next.trim() === entry.name) return;
    const env = browserEnv();
    if (!env) return;
    void onAct(`Could not rename ${entry.name}`, () =>
      invoke("fs_rename", {
        from: path,
        to: joinRemote(cwd, next.trim()),
        workspace: env,
      }),
    );
  };

  const remove = () => {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    const env = browserEnv();
    if (!env) return;
    void onAct(`Could not delete ${entry.name}`, () =>
      invoke("fs_delete", { path, workspace: env }),
    );
  };

  const download = () => {
    const { conn } = store();
    if (conn === null) return;
    void (async () => {
      try {
        const saved = await invoke<string>("remote_download", { conn, path });
        toast.success(`Downloaded ${entry.name}`, { description: saved });
      } catch (e) {
        toast.error(`Could not download ${entry.name}`, {
          description: String(e),
        });
      }
    })();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onDoubleClick={() => (isDir ? enterDir() : onOpenFile?.(path))}
          className={cn(
            "flex w-full items-center gap-2 px-2.5 py-[3px] text-left transition-colors",
            "hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.06] focus-visible:outline-none",
          )}
        >
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              draggable={false}
              className="size-[14px] shrink-0"
            />
          ) : (
            <HugeiconsIcon
              icon={isDir ? Folder01Icon : File01Icon}
              size={13}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate text-[11.5px] leading-tight text-foreground">
            {entry.name}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {isDir ? (
          <>
            <ContextMenuItem onSelect={enterDir}>Open</ContextMenuItem>
            {onRunInTerminal ? (
              <ContextMenuItem onSelect={cd}>
                Change directory here
              </ContextMenuItem>
            ) : null}
          </>
        ) : (
          <>
            {onOpenFile ? (
              <ContextMenuItem onSelect={() => onOpenFile(path)}>
                Open in editor
              </ContextMenuItem>
            ) : null}
            {onRunInTerminal ? (
              <ContextMenuItem
                onSelect={() =>
                  onRunInTerminal(
                    `\${EDITOR:-vi} ${quoteShellArg(path, false)}`,
                  )
                }
              >
                Open in terminal editor
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={download}>
              <HugeiconsIcon icon={Download04Icon} size={13} />
              Download
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={rename}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={13} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void navigator.clipboard.writeText(path)}
        >
          <HugeiconsIcon icon={Copy01Icon} size={13} />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={remove}>
          <HugeiconsIcon icon={Delete02Icon} size={13} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <p className="px-3 py-3 text-[11px] text-muted-foreground">{text}</p>
  );
}
