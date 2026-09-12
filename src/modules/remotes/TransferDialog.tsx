import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { readSshConfig } from "./lib/ssh-bridge";
import { DEFAULT_SSH_CONFIG_PATH, useRemotesStore } from "./lib/store";
import { profileLabel } from "./lib/tree";
import {
  applyImport,
  configHostKey,
  expandHome,
  exportFileName,
  parseExport,
  profileFromConfigHost,
  profileKey,
  serializeExport,
  type ImportMode,
  type RemotesExport,
} from "./lib/transfer";
import type { RemoteProfile, SshConfigHost } from "./lib/types";

type Props = { onClose: () => void };

type Tab = "ssh-config" | "import" | "export";

const LIST_CLASS =
  "max-h-[40vh] min-h-24 overflow-y-auto rounded-md border border-border/60";

/** One selectable host row, shared by both import sources. */
function HostRow({
  id,
  checked,
  onToggle,
  title,
  detail,
  badge,
}: {
  id: string;
  checked: boolean;
  onToggle: () => void;
  title: string;
  detail: string;
  badge?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]">
      <Checkbox id={id} checked={checked} onCheckedChange={onToggle} />
      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer font-normal">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[11.5px] text-foreground">
            {title}
          </span>
          {badge ? (
            <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[10.5px] text-muted-foreground/80">
          {detail}
        </span>
      </Label>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
      {children}
    </p>
  );
}

function useSelection<T>(items: T[], keyOf: (item: T) => string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Everything offered starts checked: the common case is taking the lot.
  useEffect(() => {
    setSelected(new Set(items.map(keyOf)));
    // keyOf is a stable module-level accessor at every call site.
  }, [items, keyOf]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setAll = useCallback(
    (on: boolean) => setSelected(on ? new Set(items.map(keyOf)) : new Set()),
    [items, keyOf],
  );

  return { selected, toggle, setAll };
}

function SelectAllRow({
  count,
  total,
  onAll,
  onNone,
}: {
  count: number;
  total: number;
  onAll: () => void;
  onNone: () => void;
}) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
      <span>
        {count} of {total} selected
      </span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          className="rounded px-1 py-0.5 hover:text-foreground"
          onClick={onAll}
        >
          All
        </button>
        <button
          type="button"
          className="rounded px-1 py-0.5 hover:text-foreground"
          onClick={onNone}
        >
          None
        </button>
      </span>
    </div>
  );
}

const configKey = (host: SshConfigHost) => host.alias;

function SshConfigTab({ onClose }: Props) {
  const profiles = useRemotesStore((s) => s.profiles);
  const addProfiles = useRemotesStore((s) => s.addProfiles);
  const storedPath = useRemotesStore((s) => s.sshConfigPath);
  const setSshConfigPath = useRemotesStore((s) => s.setSshConfigPath);

  const [path, setPath] = useState(storedPath);
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((from: string) => {
    setHosts(null);
    setError(null);
    void readSshConfig(from)
      .then(setHosts)
      .catch((e) => {
        setHosts([]);
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    setPath(storedPath);
    load(storedPath);
  }, [storedPath, load]);

  // An alias already added is not offered again, so repeat imports do not pile
  // up duplicates.
  const existing = useMemo(
    () => new Set(profiles.map(profileKey)),
    [profiles],
  );
  const candidates = useMemo(
    () => (hosts ?? []).filter((h) => !existing.has(configHostKey(h))),
    [hosts, existing],
  );
  const { selected, toggle, setAll } = useSelection(candidates, configKey);

  const chosen = candidates.filter((h) => selected.has(h.alias));

  const submit = () => {
    const names = profiles.map((p) => p.name);
    const created: RemoteProfile[] = [];
    for (const host of chosen) {
      created.push(profileFromConfigHost(host, [...names, ...created.map((c) => c.name)]));
    }
    void addProfiles(created).then(() => {
      toast.success(`Imported ${created.length} host${created.length === 1 ? "" : "s"}`);
      onClose();
    });
  };

  // Persisting re-runs the effect above, which reloads from the new location,
  // so committing an unchanged path would otherwise read nothing back.
  const commitPath = () => {
    const next = path.trim() || DEFAULT_SSH_CONFIG_PATH;
    setPath(next);
    if (next !== storedPath) void setSshConfigPath(next);
    return next;
  };

  const reload = () => {
    const next = commitPath();
    if (next === storedPath) load(next);
  };

  return (
    <div className="space-y-2.5">
      <Note>
        Your OpenSSH config is only read, never modified. Wildcard blocks such
        as <code>Host *</code> are applied as defaults rather than imported as
        hosts.
      </Note>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            Config file
          </Label>
          <Input
            value={path}
            spellCheck={false}
            placeholder={DEFAULT_SSH_CONFIG_PATH}
            onChange={(e) => setPath(e.target.value)}
            onBlur={commitPath}
            onKeyDown={(e) => {
              if (e.key === "Enter") reload();
            }}
          />
        </div>
        <Button variant="outline" onClick={reload}>
          Reload
        </Button>
      </div>

      <SelectAllRow
        count={chosen.length}
        total={candidates.length}
        onAll={() => setAll(true)}
        onNone={() => setAll(false)}
      />

      <div className={LIST_CLASS}>
        {error ? (
          <p className="px-3 py-3 text-[11px] text-destructive">{error}</p>
        ) : hosts === null ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            Reading config...
          </p>
        ) : candidates.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            {hosts.length === 0
              ? "No hosts found in this config."
              : "Every host in this config has already been added."}
          </p>
        ) : (
          candidates.map((host) => (
            <HostRow
              key={host.alias}
              id={`cfg-${host.alias}`}
              checked={selected.has(host.alias)}
              onToggle={() => toggle(host.alias)}
              title={host.alias}
              detail={[
                `${host.user ? `${host.user}@` : ""}${host.hostname ?? host.alias}${
                  host.port && host.port !== 22 ? `:${host.port}` : ""
                }`,
                host.identity_files.length > 0
                  ? `${host.identity_files.length} key${host.identity_files.length > 1 ? "s" : ""}`
                  : "",
                host.proxy_jump ? `via ${host.proxy_jump}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={chosen.length === 0} onClick={submit}>
          Import {chosen.length > 0 ? chosen.length : ""}
        </Button>
      </div>
    </div>
  );
}

const MODE_LABELS: Record<ImportMode, string> = {
  skip: "Skip hosts already here",
  replace: "Replace hosts already here",
  copy: "Import everything as a copy",
};

const profileId = (profile: RemoteProfile) => profile.id;

function ImportFileTab({ onClose }: Props) {
  const profiles = useRemotesStore((s) => s.profiles);
  const groups = useRemotesStore((s) => s.groups);
  const importSnapshot = useRemotesStore((s) => s.importSnapshot);

  const inputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<RemotesExport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("skip");
  const [dragging, setDragging] = useState(false);

  const incoming = useMemo(() => data?.profiles ?? [], [data]);
  const { selected, toggle, setAll } = useSelection(incoming, profileId);

  const groupName = useMemo(() => {
    const map = new Map((data?.groups ?? []).map((g) => [g.id, g.name]));
    return (id: string | null) => (id ? map.get(id) : undefined);
  }, [data]);

  const here = useMemo(() => new Set(profiles.map(profileKey)), [profiles]);

  const accept = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    const result = parseExport(await file.text());
    if (!result.ok) {
      setData(null);
      setFileName(null);
      setError(result.error);
      return;
    }
    setFileName(file.name);
    setData(result.data);
  };

  const submit = () => {
    if (!data) return;
    const result = applyImport({ profiles, groups }, data, selected, mode);
    void importSnapshot(result.profiles, result.groups).then(() => {
      const parts = [
        result.added > 0 ? `${result.added} added` : "",
        result.replaced > 0 ? `${result.replaced} replaced` : "",
        result.skipped > 0 ? `${result.skipped} skipped` : "",
      ].filter(Boolean);
      toast.success("Remotes imported", {
        description: parts.join(", ") || "Nothing changed",
      });
      onClose();
    });
  };

  const chosenCount = incoming.filter((p) => selected.has(p.id)).length;

  return (
    <div className="space-y-2.5">
      <Note>
        Load a file written by Export on another Terax instance. Passwords and
        key passphrases are never part of an export, so you are prompted for
        them the first time you connect.
      </Note>

      <div
        role="presentation"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void accept(e.dataTransfer.files);
        }}
        className={cn(
          "flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2.5 transition-colors",
          dragging ? "border-primary/50 bg-primary/5" : "border-border/60",
        )}
      >
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
          {fileName ?? "Drop an export here, or choose a file"}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => inputRef.current?.click()}
        >
          {fileName ? "Choose another" : "Choose file"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            void accept(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {data ? (
        <>
          <SelectAllRow
            count={chosenCount}
            total={incoming.length}
            onAll={() => setAll(true)}
            onNone={() => setAll(false)}
          />

          <div className={LIST_CLASS}>
            {incoming.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-muted-foreground">
                This export holds groups only.
              </p>
            ) : (
              incoming.map((profile) => (
                <HostRow
                  key={profile.id}
                  id={`imp-${profile.id}`}
                  checked={selected.has(profile.id)}
                  onToggle={() => toggle(profile.id)}
                  title={profileLabel(profile)}
                  badge={here.has(profileKey(profile)) ? "here" : undefined}
                  detail={[
                    `${profile.user}@${profile.host}${
                      profile.port && profile.port !== 22 ? `:${profile.port}` : ""
                    }`,
                    groupName(profile.groupId) ?? "",
                    profile.jumps.length > 0 ? `via ${profile.jumps.join(", ")}` : "",
                    profile.command ? "runs a command" : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              When a host is already here
            </Label>
            <Select value={mode} onValueChange={(v) => setMode(v as ImportMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABELS) as ImportMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Note>
            Groups are matched by name, so a host lands in the group you already
            have rather than a second one beside it.
          </Note>
        </>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!data || chosenCount === 0} onClick={submit}>
          Import {chosenCount > 0 ? chosenCount : ""}
        </Button>
      </div>
    </div>
  );
}

function ExportTab({ onClose }: Props) {
  const profiles = useRemotesStore((s) => s.profiles);
  const groups = useRemotesStore((s) => s.groups);

  const [path, setPath] = useState("");
  const [home, setHome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void homeDir()
      .then((dir) => {
        const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
        setHome(base);
        setPath(`${base}/${exportFileName()}`);
      })
      .catch(() => setPath(exportFileName()));
  }, []);

  const save = () => {
    const target = expandHome(path, home);
    if (!target) {
      setError("Choose where to write the file.");
      return;
    }
    setSaving(true);
    setError(null);
    // Deliberately not the active workspace: the destination is built from the
    // local home directory, so with a remote workspace open the file would
    // land on the far machine at a path that only means something here.
    void invoke("fs_write_file", {
      path: target,
      content: serializeExport(profiles, groups),
      source: "remotes-export",
    })
      .then(() => {
        toast.success("Remotes exported", {
          description: target,
          // Revealing rather than opening: an editor tab would read the file
          // through the active workspace, which may point at another machine.
          action: {
            label: "Show in folder",
            onClick: () => {
              void revealItemInDir(target).catch((e) =>
                toast.error("Could not show the file", {
                  description: String(e),
                }),
              );
            },
          },
        });
        onClose();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  const copy = () => {
    void navigator.clipboard
      .writeText(serializeExport(profiles, groups))
      .then(() => toast.success("Export copied to the clipboard"))
      .catch(() => setError("Could not reach the clipboard."));
  };

  const hostCount = profiles.length;
  const groupCount = groups.length;

  return (
    <div className="space-y-2.5">
      <Note>
        Writes every host and group to one file you can carry to another
        machine. Secrets are never included, and a per-host background image
        stays behind because it lives in this instance's store.
      </Note>

      <div className="rounded-md border border-border/60 px-3 py-2.5 text-[11.5px] text-muted-foreground">
        {hostCount} host{hostCount === 1 ? "" : "s"} in {groupCount} group
        {groupCount === 1 ? "" : "s"}
      </div>

      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Write to</Label>
        <Input
          value={path}
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={hostCount === 0 && groupCount === 0}
          onClick={copy}
        >
          Copy
        </Button>
        <Button
          disabled={saving || (hostCount === 0 && groupCount === 0)}
          onClick={save}
        >
          Export
        </Button>
      </div>
    </div>
  );
}

/**
 * The one place hosts enter and leave this instance: an OpenSSH config at a
 * location the user chooses, a Terax export from another machine, and the
 * export that produces one.
 */
export function TransferDialog({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("ssh-config");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import and export hosts</DialogTitle>
          <DialogDescription>
            Move remote sessions and their groups between machines, or seed them
            from an OpenSSH config.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="w-full">
            <TabsTrigger value="ssh-config" className="flex-1">
              SSH config
            </TabsTrigger>
            <TabsTrigger value="import" className="flex-1">
              Import
            </TabsTrigger>
            <TabsTrigger value="export" className="flex-1">
              Export
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ssh-config" className="pt-3">
            <SshConfigTab onClose={onClose} />
          </TabsContent>
          <TabsContent value="import" className="pt-3">
            <ImportFileTab onClose={onClose} />
          </TabsContent>
          <TabsContent value="export" className="pt-3">
            <ExportTab onClose={onClose} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
