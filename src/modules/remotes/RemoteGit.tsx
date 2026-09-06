import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  GitBranchIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useRemoteBrowserStore } from "./lib/browser";
import { useRemoteGitStore } from "./lib/git";

export function RemoteGit() {
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
    return <Note text="Open a host to see its repositories" />;
  }

  const status = snapshot?.status;
  if (!status) {
    return (
      <Note
        text={
          loading ? "Looking for a repository" : "Not a git repository here"
        }
        error={error}
      />
    );
  }

  const files = status.changedFiles;
  const disabled = busy !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-1">
        <HugeiconsIcon
          icon={GitBranchIcon}
          size={12}
          strokeWidth={1.9}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate text-[11.5px] text-foreground" title={status.repoRoot}>
          {status.branch}
        </span>
        {status.behind > 0 ? <Counter icon={ArrowDown01Icon} n={status.behind} /> : null}
        {status.ahead > 0 ? <Counter icon={ArrowUp01Icon} n={status.ahead} /> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh"
          aria-label="Refresh"
          disabled={disabled}
          onClick={() => cwd && void store().refresh(cwd)}
          className="ml-auto size-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
        </Button>
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
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            disabled={disabled || files.length === 0 || !message.trim()}
            onClick={() => {
              void store()
                .commit(message.trim())
                .then(() => setMessage(""));
            }}
            className="h-7 flex-1 text-[11px]"
          >
            {busy === "Committing"
              ? "Committing"
              : `Commit ${files.length} change${files.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void store().pull()}
            className="h-7 px-2 text-[11px]"
          >
            {busy === "Pulling" ? "Pulling" : "Pull"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void store().push()}
            className="h-7 px-2 text-[11px]"
          >
            {busy === "Pushing" ? "Pushing" : "Push"}
          </Button>
        </div>
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

function Note({ text, error }: { text: string; error?: string | null }) {
  return (
    <div className="px-3 py-3">
      <p className="text-[11px] text-muted-foreground">{text}</p>
      {error ? (
        <p className="mt-1 text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
