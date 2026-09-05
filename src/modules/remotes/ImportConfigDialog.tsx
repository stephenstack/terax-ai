import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useMemo, useState } from "react";
import { readSshConfig } from "./lib/ssh-bridge";
import { emptyProfile, useRemotesStore } from "./lib/store";
import { uniqueName } from "./lib/tree";
import type { RemoteAuthMethod, RemoteProfile, SshConfigHost } from "./lib/types";

type Props = { onClose: () => void };

/** Turn a parsed config entry into a profile, keeping the alias as the name. */
function toProfile(
  host: SshConfigHost,
  existingNames: string[],
  fallbackUser: string,
): RemoteProfile {
  const auth: RemoteAuthMethod[] = [];
  for (const path of host.identity_files) {
    auth.push({ kind: "keyFile", path });
  }
  // IdentitiesOnly means "do not fall back to the agent's other keys".
  if (!host.identities_only) auth.push({ kind: "agent" });
  auth.push({ kind: "password" });

  return {
    ...emptyProfile(),
    name: uniqueName(existingNames, host.alias),
    host: host.hostname ?? host.alias,
    port: host.port,
    user: host.user ?? fallbackUser,
    auth,
    connectTimeoutSecs: host.connect_timeout ?? undefined,
    keepaliveSecs: host.server_alive_interval ?? undefined,
    compression: host.compression ?? undefined,
    // ProxyJump takes a comma-separated chain, nearest bastion first.
    jumps: (host.proxy_jump ?? "")
      .split(",")
      .map((j) => j.trim())
      .filter(Boolean),
  };
}

export function ImportConfigDialog({ onClose }: Props) {
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const profiles = useRemotesStore((s) => s.profiles);
  const addProfiles = useRemotesStore((s) => s.addProfiles);

  useEffect(() => {
    void readSshConfig()
      .then((list) => {
        setHosts(list);
        setSelected(new Set(list.map((h) => h.alias)));
      })
      .catch((e) => setError(String(e)));
  }, []);

  // An alias already imported is not offered again, so repeat imports do not
  // pile up duplicates.
  const existingHosts = useMemo(
    () => new Set(profiles.map((p) => `${p.user}@${p.host}:${p.port ?? 22}`)),
    [profiles],
  );

  const candidates = useMemo(
    () =>
      (hosts ?? []).filter(
        (h) =>
          !existingHosts.has(
            `${h.user ?? ""}@${h.hostname ?? h.alias}:${h.port ?? 22}`,
          ),
      ),
    [hosts, existingHosts],
  );

  const toggle = (alias: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });

  const submit = () => {
    const names = profiles.map((p) => p.name);
    const chosen = candidates.filter((h) => selected.has(h.alias));
    const created: RemoteProfile[] = [];
    for (const host of chosen) {
      const profile = toProfile(host, [...names, ...created.map((c) => c.name)], "");
      created.push(profile);
    }
    void addProfiles(created);
    onClose();
  };

  const importable = candidates.filter((h) => selected.has(h.alias)).length;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from ~/.ssh/config</DialogTitle>
          <DialogDescription>
            Your OpenSSH config is only read, never modified. Wildcard blocks
            such as <code>Host *</code> are applied as defaults rather than
            imported as hosts.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[46vh] min-h-24 overflow-y-auto rounded-md border border-border/60">
          {error ? (
            <p className="px-3 py-3 text-[11px] text-destructive">{error}</p>
          ) : hosts === null ? (
            <p className="px-3 py-3 text-[11px] text-muted-foreground">
              Reading config...
            </p>
          ) : candidates.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-muted-foreground">
              {hosts.length === 0
                ? "No hosts found in ~/.ssh/config."
                : "Every host in your config has already been added."}
            </p>
          ) : (
            candidates.map((host) => (
              <div
                key={host.alias}
                className="flex items-center gap-2.5 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
              >
                <Checkbox
                  id={`import-${host.alias}`}
                  checked={selected.has(host.alias)}
                  onCheckedChange={() => toggle(host.alias)}
                />
                <Label
                  htmlFor={`import-${host.alias}`}
                  className="min-w-0 flex-1 cursor-pointer font-normal"
                >
                  <span className="block truncate text-[11.5px] text-foreground">
                    {host.alias}
                  </span>
                  <span className="block truncate text-[10.5px] text-muted-foreground/80">
                    {host.user ? `${host.user}@` : ""}
                    {host.hostname ?? host.alias}
                    {host.port && host.port !== 22 ? `:${host.port}` : ""}
                    {host.identity_files.length > 0
                      ? ` · ${host.identity_files.length} key${host.identity_files.length > 1 ? "s" : ""}`
                      : ""}
                    {host.proxy_jump ? ` · via ${host.proxy_jump}` : ""}
                  </span>
                </Label>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={importable === 0} onClick={submit}>
            Import {importable > 0 ? importable : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
