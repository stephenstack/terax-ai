import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  CloudDownloadIcon,
  Download04Icon,
  GitBranchIcon,
  RefreshIcon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { PanelIconButton } from "./PanelIconButton";
import { useRemoteBrowserStore } from "./lib/browser";
import { useRemoteGitStore } from "./lib/git";

export function RemoteGit() {
  // Always the browsed directory. Whether that tracks the terminal is the
  // file panel's business, so there is one directory in play rather than two
  // that can disagree.
  const cwd = useRemoteBrowserStore((s) => s.cwd);
  const conn = useRemoteBrowserStore((s) => s.conn);
  const snapshot = useRemoteGitStore((s) => s.snapshot);
  const loading = useRemoteGitStore((s) => s.loading);
  const busy = useRemoteGitStore((s) => s.busy);
  const error = useRemoteGitStore((s) => s.error);
  const [message, setMessage] = useState("");

  const store = useRemoteGitStore.getState;

  useEffect(() => {
    if (conn !== null && cwd) void useRemoteGitStore.getState().refresh(cwd);
  }, [conn, cwd]);

  if (conn === null) {
    return <Note text="Open a host to see its repositories." />;
  }

  const status = snapshot?.status;
  if (!status) {
    return (
      <Note
        text={
          loading
            ? "Looking for a repository."
            : "No Git repository at this path."
        }
        path={cwd}
        error={error}
      />
    );
  }

  const files = status.changedFiles;
  const disabled = busy !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <PanelIconButton
          label="Refresh"
          icon={RefreshIcon}
          disabled={disabled}
          onClick={() => cwd && void store().refresh(cwd)}
        />
        <PanelIconButton
          label="Fetch"
          icon={CloudDownloadIcon}
          disabled={disabled}
          onClick={() => void store().fetch()}
        />
        <PanelIconButton
          label={
            status.behind > 0 ? `Pull ${status.behind} behind` : "Pull"
          }
          icon={Download04Icon}
          disabled={disabled}
          onClick={() => void store().pull()}
        />
        <PanelIconButton
          label={status.ahead > 0 ? `Push ${status.ahead} ahead` : "Push"}
          icon={Upload04Icon}
          disabled={disabled}
          onClick={() => void store().push()}
        />
        {busy ? (
          <span className="ml-1 truncate text-[10.5px] text-muted-foreground">
            {busy}
          </span>
        ) : null}
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5 px-2.5 pb-1"
        title={`${status.branch} in ${status.repoRoot}`}
      >
        <HugeiconsIcon
          icon={GitBranchIcon}
          size={12}
          strokeWidth={1.9}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate text-[11.5px] text-foreground">
          {status.branch}
        </span>
        {status.behind > 0 ? (
          <Counter icon={ArrowDown01Icon} n={status.behind} />
        ) : null}
        {status.ahead > 0 ? (
          <Counter icon={ArrowUp01Icon} n={status.ahead} />
        ) : null}
      </div>

      {error ? (
        <p className="px-2.5 pb-1 text-[11px] text-destructive">{error}</p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <Note text={busy ?? "Nothing to commit"} />
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              className="flex items-center gap-2 px-2.5 py-[3px]"
              title={f.path}
            >
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[10px]",
                  f.untracked ? "text-emerald-500" : "text-amber-500",
                )}
              >
                {f.statusLabel.slice(0, 1) || "?"}
              </span>
              <span className="truncate text-[11px] leading-tight text-foreground">
                {f.path}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border/40 p-2">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          spellCheck={false}
          rows={2}
          className="mb-1.5 min-h-0 resize-none rounded-md border-border/60 bg-foreground/[0.03] text-[11.5px]"
        />
        <Button
          size="sm"
          disabled={disabled || files.length === 0 || !message.trim()}
          onClick={() => {
            void store()
              .commit(message.trim())
              .then(() => setMessage(""));
          }}
          className="h-7 w-full text-[11px]"
        >
          {busy === "Committing"
            ? "Committing"
            : `Commit ${files.length} change${files.length === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

function Counter({ icon, n }: { icon: typeof ArrowUp01Icon; n: number }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] text-muted-foreground">
      <HugeiconsIcon icon={icon} size={11} strokeWidth={2} />
      {n}
    </span>
  );
}

function Note({
  text,
  path,
  error,
}: {
  text: string;
  path?: string | null;
  error?: string | null;
}) {
  return (
    <div className="px-3 py-3">
      <p className="text-[11px] text-muted-foreground">{text}</p>
      {path ? (
        <p
          className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/70"
          title={path}
        >
          {path}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
