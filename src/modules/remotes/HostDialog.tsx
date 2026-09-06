import { AccentPicker } from "@/components/AccentPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { TERMINAL_CURSOR_STYLES } from "@/modules/settings/store";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  pruneAppearance,
  useTerminalFont,
  type TerminalAppearance,
} from "@/modules/terminal";
import {
  deleteBgImage,
  importBgImageFromFile,
} from "@/modules/theme/bgImageStore";
import type { RemoteBackground } from "./lib/types";
import { parseJumpSpec } from "./lib/jumps";
import { agentIdentities, discoverKeys } from "./lib/ssh-bridge";
import { useRemotesStore } from "./lib/store";
import type {
  DiscoveredKey,
  RemoteAuthMethod,
  RemoteForward,
  RemoteGroup,
  RemoteProfile,
} from "./lib/types";

type Props = {
  profile: RemoteProfile;
  groups: RemoteGroup[];
  onClose: () => void;
};

/** The backend takes a `u16`; an out-of-range value would fail IPC
 *  deserialization with an opaque error long after the user typed it. */
export function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(65535, Math.max(1, Math.round(parsed)));
}

const AUTH_LABEL: Record<RemoteAuthMethod["kind"], string> = {
  agent: "SSH agent",
  keyFile: "Key file",
  password: "Password",
  keyboardInteractive: "Keyboard interactive",
};

export function HostDialog({ profile, groups, onClose }: Props) {
  const [draft, setDraft] = useState<RemoteProfile>(profile);
  const [keys, setKeys] = useState<DiscoveredKey[]>([]);
  // null while probing, [] when no agent is reachable.
  const [agentKeys, setAgentKeys] = useState<string[] | null>(null);
  const save = useRemotesStore((s) => s.saveProfile);

  const base = useAppearanceBase();

  useEffect(() => {
    void discoverKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
    void agentIdentities()
      .then(setAgentKeys)
      .catch(() => setAgentKeys([]));
  }, []);

  const patch = (next: Partial<RemoteProfile>) =>
    setDraft((d) => ({ ...d, ...next }));

  const invalidJumps = useMemo(
    () => (draft.jumps ?? []).filter((j) => parseJumpSpec(j) === null),
    [draft.jumps],
  );

  const valid =
    draft.host.trim().length > 0 &&
    draft.user.trim().length > 0 &&
    invalidJumps.length === 0;

  const submit = () => {
    if (!valid) return;
    void save({
      ...draft,
      name: draft.name.trim(),
      host: draft.host.trim(),
      user: draft.user.trim(),
      // Never pin a value the user did not deliberately change.
      appearance: pruneAppearance(base, draft.appearance),
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {profile.host ? "Edit host" : "New remote host"}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="connection">
          <TabsList className="w-full">
            <TabsTrigger value="connection" className="flex-1">
              Connection
            </TabsTrigger>
            <TabsTrigger value="auth" className="flex-1">
              Authentication
            </TabsTrigger>
            <TabsTrigger value="session" className="flex-1">
              Session
            </TabsTrigger>
            <TabsTrigger value="tunnels" className="flex-1">
              Tunnels
            </TabsTrigger>
            <TabsTrigger value="appearance" className="flex-1">
              Appearance
            </TabsTrigger>
          </TabsList>

          <div className="max-h-[52vh] overflow-y-auto pr-1">
            <TabsContent value="connection" className="space-y-3 pt-3">
              <Field label="Name" hint="Shown in the panel and on the tab.">
                <Input
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder={draft.host || "Production web"}
                  spellCheck={false}
                />
              </Field>
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <Field label="Host">
                  <Input
                    value={draft.host}
                    onChange={(e) => patch({ host: e.target.value })}
                    placeholder="web.example.com"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Port">
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.port ?? ""}
                    onChange={(e) => patch({ port: parsePort(e.target.value) })}
                    placeholder="22"
                  />
                </Field>
              </div>
              <Field label="User">
                <Input
                  value={draft.user}
                  onChange={(e) => patch({ user: e.target.value })}
                  placeholder="deploy"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Jump hosts"
                hint="Bastions to tunnel through, nearest first, one per line as [user@]host[:port]. Equivalent to ProxyJump."
              >
                <Textarea
                  value={(draft.jumps ?? []).join("\n")}
                  onChange={(e) =>
                    patch({
                      jumps: e.target.value
                        .split("\n")
                        .map((l) => l.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="ops@bastion.example:22"
                  spellCheck={false}
                  rows={2}
                  className="text-[11.5px]"
                />
                {invalidJumps.length > 0 ? (
                  <p className="text-[10.5px] leading-snug text-destructive">
                    Cannot parse: {invalidJumps.join(", ")}
                  </p>
                ) : null}
              </Field>
              <Field label="Group">
                <Select
                  value={draft.groupId ?? "__none"}
                  onValueChange={(v) =>
                    patch({ groupId: v === "__none" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Ungrouped</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </TabsContent>

            <TabsContent value="auth" className="space-y-3 pt-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Methods are tried in order, like{" "}
                <code>PreferredAuthentications</code>. Passwords and key
                passphrases are never stored here: you are prompted when the
                connection needs one.
              </p>
              <AuthList
                methods={draft.auth}
                keys={keys}
                agentKeys={agentKeys}
                onChange={(auth) => patch({ auth })}
              />
            </TabsContent>

            <TabsContent value="session" className="space-y-3 pt-3">
              <Field
                label="Working directory"
                hint="Entered once the remote shell starts."
              >
                <Input
                  value={draft.cwd ?? ""}
                  onChange={(e) =>
                    patch({ cwd: e.target.value || undefined })
                  }
                  placeholder="/srv/app"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Command"
                hint="Runs instead of the login shell. Leave empty for a shell."
              >
                <Input
                  value={draft.command ?? ""}
                  onChange={(e) =>
                    patch({ command: e.target.value || undefined })
                  }
                  placeholder="tmux attach"
                  spellCheck={false}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="TERM">
                  <Input
                    value={draft.term ?? ""}
                    onChange={(e) =>
                      patch({ term: e.target.value || undefined })
                    }
                    placeholder="xterm-256color"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Keepalive (seconds)">
                  <Input
                    type="number"
                    value={draft.keepaliveSecs ?? ""}
                    onChange={(e) =>
                      patch({
                        keepaliveSecs: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="Off"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Connect timeout (seconds)">
                  <Input
                    type="number"
                    value={draft.connectTimeoutSecs ?? ""}
                    onChange={(e) =>
                      patch({
                        connectTimeoutSecs: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="20"
                  />
                </Field>
                <div className="flex items-end gap-2 pb-2">
                  <Checkbox
                    id="remote-compression"
                    checked={draft.compression ?? false}
                    onCheckedChange={(v) => patch({ compression: v === true })}
                  />
                  <Label
                    htmlFor="remote-compression"
                    className="cursor-pointer text-[11.5px]"
                  >
                    Request compression
                  </Label>
                </div>
              </div>
              <EnvEditor
                env={draft.env}
                onChange={(env) => patch({ env })}
              />
            </TabsContent>

            <TabsContent value="tunnels" className="space-y-3 pt-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Local forwards, like <code>ssh -L</code>. The remote host is
                resolved on the server, so <code>localhost</code> means the
                server's own loopback. Nothing starts automatically: you start
                a forward from the Remotes panel.
              </p>
              <ForwardEditor
                forwards={draft.forwards ?? []}
                onChange={(forwards) => patch({ forwards })}
              />
            </TabsContent>

            <TabsContent value="appearance" className="space-y-3 pt-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Leave a field empty to follow the global terminal settings.
                Overrides apply while a pane for this host is focused.
              </p>
              <AppearanceEditor
                base={base}
                appearance={draft.appearance}
                onChange={(appearance) => patch({ appearance })}
                color={draft.color}
                onColorChange={(color) => patch({ color })}
                background={draft.background}
                onBackgroundChange={(background) => patch({ background })}
              />
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Must match what `useTerminalSession` resolves against, not the raw
 * preferences: the active theme can override the terminal font, and comparing
 * a picked value to the wrong base would store a no-op as a real override.
 */
function useAppearanceBase(): TerminalAppearance {
  const { fontFamily, fontSize, fontWeight } = useTerminalFont();
  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  const cursorStyle = usePreferencesStore((p) => p.terminalCursorStyle);
  const cursorBlink = usePreferencesStore((p) => p.terminalCursorBlink);
  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  return useMemo(
    () => ({
      fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
      cursorStyle,
      cursorBlink,
      scrollback,
    }),
    [
      fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
      cursorStyle,
      cursorBlink,
      scrollback,
    ],
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11.5px]">{label}</Label>
      {children}
      {hint ? (
        <p className="text-[10.5px] leading-snug text-muted-foreground/80">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function AuthList({
  methods,
  keys,
  agentKeys,
  onChange,
}: {
  methods: RemoteAuthMethod[];
  keys: DiscoveredKey[];
  agentKeys: string[] | null;
  onChange: (methods: RemoteAuthMethod[]) => void;
}) {
  const add = (kind: RemoteAuthMethod["kind"]) => {
    const method: RemoteAuthMethod =
      kind === "keyFile"
        ? { kind: "keyFile", path: keys[0]?.path ?? "" }
        : { kind };
    onChange([...methods, method]);
  };
  const remove = (index: number) =>
    onChange(methods.filter((_, i) => i !== index));
  const move = (index: number, delta: number) => {
    const next = [...methods];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const unused = (
    ["agent", "keyFile", "password", "keyboardInteractive"] as const
  ).filter((k) => k === "keyFile" || !methods.some((m) => m.kind === k));

  return (
    <div className="space-y-2">
      {methods.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-[11px] text-muted-foreground">
          No methods configured. SSH defaults will be used: agent, then
          password, then keyboard interactive.
        </p>
      ) : null}

      {methods.map((method, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: position is an auth method's identity; the same kind can appear twice (two key files) and reordering must re-render.
          key={`${method.kind}-${index}`}
          className="flex items-center gap-2 rounded-md border border-border/60 bg-foreground/[0.03] px-2 py-1.5"
        >
          <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/70">
            {index + 1}
          </span>
          <span className="w-32 shrink-0 text-[11.5px]">
            {AUTH_LABEL[method.kind]}
          </span>
          {method.kind === "agent" ? (
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/80">
              {agentKeys === null
                ? "Checking for an agent..."
                : agentKeys.length === 0
                  ? "No agent running"
                  : `${agentKeys.length} identit${agentKeys.length === 1 ? "y" : "ies"}: ${agentKeys.join(", ")}`}
            </span>
          ) : method.kind === "keyFile" ? (
            <KeyPicker
              value={method.path}
              keys={keys}
              onChange={(path) => {
                const next = [...methods];
                next[index] = { kind: "keyFile", path };
                onChange(next);
              }}
            />
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            <MiniButton label="Move up" onClick={() => move(index, -1)}>
              ↑
            </MiniButton>
            <MiniButton label="Move down" onClick={() => move(index, 1)}>
              ↓
            </MiniButton>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove method"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={() => remove(index)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={12} />
            </Button>
          </div>
        </div>
      ))}

      {unused.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {unused.map((kind) => (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => add(kind)}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} />
              {AUTH_LABEL[kind]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MiniButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="size-6 text-[11px] text-muted-foreground hover:text-foreground"
    >
      {children}
    </Button>
  );
}

function KeyPicker({
  value,
  keys,
  onChange,
}: {
  value: string;
  keys: DiscoveredKey[];
  onChange: (path: string) => void;
}) {
  const known = keys.some((k) => k.path === value);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {keys.length > 0 ? (
        <Select
          value={known ? value : "__custom"}
          onValueChange={(v) => v !== "__custom" && onChange(v)}
        >
          <SelectTrigger className="h-7 min-w-0 flex-1 text-[11px]">
            <SelectValue placeholder="Select a key" />
          </SelectTrigger>
          <SelectContent>
            {keys.map((k) => (
              <SelectItem key={k.path} value={k.path}>
                {k.name}
                {k.encrypted ? " (encrypted)" : ""}
              </SelectItem>
            ))}
            {!known ? (
              <SelectItem value="__custom">Custom path</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      ) : null}
      {!known ? (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~/.ssh/id_ed25519"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 text-[11px]"
        />
      ) : null}
    </div>
  );
}

function EnvEditor({
  env,
  onChange,
}: {
  env: Array<[string, string]>;
  onChange: (env: Array<[string, string]>) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11.5px]">Environment</Label>
      {env.map(([name, value], index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: an env row has no identity beyond its position; its name is user-edited and empty while being typed.
          key={index}
          className="flex items-center gap-1.5"
        >
          <Input
            value={name}
            onChange={(e) => {
              const next = [...env];
              next[index] = [e.target.value, value];
              onChange(next);
            }}
            placeholder="LANG"
            spellCheck={false}
            className="h-7 w-40 text-[11px]"
          />
          <Input
            value={value}
            onChange={(e) => {
              const next = [...env];
              next[index] = [name, e.target.value];
              onChange(next);
            }}
            placeholder="en_US.UTF-8"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 text-[11px]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove variable"
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(env.filter((_, i) => i !== index))}
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-[11px]"
        onClick={() => onChange([...env, ["", ""]])}
      >
        <HugeiconsIcon icon={PlusSignIcon} size={11} />
        Add variable
      </Button>
      <p className="text-[10.5px] leading-snug text-muted-foreground/80">
        Most servers only accept variables listed in their{" "}
        <code>AcceptEnv</code>; others are ignored.
      </p>
    </div>
  );
}

const DEFAULT_HOST_BG: Omit<RemoteBackground, "imageId"> = {
  opacity: 0.5,
  blur: 0,
};

function HostBackgroundEditor({
  background,
  onChange,
}: {
  background: RemoteBackground | undefined;
  onChange: (background: RemoteBackground | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (files: FileList | null) => {
    setError(null);
    if (!files || files.length === 0) return;
    try {
      const previous = background?.imageId;
      const { id } = await importBgImageFromFile(files[0]);
      onChange({ ...DEFAULT_HOST_BG, ...background, imageId: id });
      // The old blob is unreachable once the profile stops naming it.
      if (previous && previous !== id) {
        await deleteBgImage(previous).catch(() => undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to import image");
    }
  };

  const remove = async () => {
    setError(null);
    const previous = background?.imageId;
    onChange(undefined);
    if (previous) await deleteBgImage(previous).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-[11px] text-muted-foreground">Background</Label>
        <div className="flex items-center gap-2">
          {background ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => void remove()}
            >
              Remove
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => inputRef.current?.click()}
          >
            {background ? "Replace image" : "Choose image"}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void pick(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      ) : null}

      {background ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">Opacity</span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(background.opacity * 100)}%
            </span>
          </div>
          <Slider
            value={[background.opacity]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={(v) =>
              onChange({ ...background, opacity: v[0] ?? 0 })
            }
          />
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-[11.5px] text-muted-foreground">Blur</span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {background.blur}px
            </span>
          </div>
          <Slider
            value={[background.blur]}
            min={0}
            max={64}
            step={1}
            onValueChange={(v) => onChange({ ...background, blur: v[0] ?? 0 })}
          />
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Shown instead of the app background while a pane for this host is
          focused.
        </p>
      )}
    </div>
  );
}

function AppearanceEditor({
  base,
  appearance,
  onChange,
  color,
  onColorChange,
  background,
  onBackgroundChange,
}: {
  base: TerminalAppearance;
  appearance: RemoteProfile["appearance"];
  onChange: (appearance: RemoteProfile["appearance"]) => void;
  color: string | undefined;
  onColorChange: (color: string | undefined) => void;
  background: RemoteBackground | undefined;
  onBackgroundChange: (background: RemoteBackground | undefined) => void;
}) {
  const patch = (next: Partial<RemoteProfile["appearance"]>) =>
    onChange({ ...appearance, ...next });

  return (
    <div className="space-y-3">
      <Field label="Tab color">
        <AccentPicker
          current={color}
          clearLabel="Use the default"
          onPick={(value) => onColorChange(value || undefined)}
        />
      </Field>

      <HostBackgroundEditor
        background={background}
        onChange={onBackgroundChange}
      />

      <div className="grid grid-cols-2 gap-2">
        <Field label="Font family">
          <Input
            value={appearance.fontFamily ?? ""}
            onChange={(e) =>
              patch({ fontFamily: e.target.value || undefined })
            }
            placeholder={base.fontFamily}
            spellCheck={false}
          />
        </Field>
        <Field label="Font size">
          <Input
            type="number"
            value={appearance.fontSize ?? ""}
            onChange={(e) =>
              patch({
                fontSize: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            placeholder={String(base.fontSize)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Font weight">
          <Input
            value={appearance.fontWeight ?? ""}
            onChange={(e) =>
              patch({ fontWeight: e.target.value || undefined })
            }
            placeholder={base.fontWeight}
            spellCheck={false}
          />
        </Field>
        <Field label="Letter spacing">
          <Input
            type="number"
            step="0.1"
            value={appearance.letterSpacing ?? ""}
            onChange={(e) =>
              patch({
                letterSpacing: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
            placeholder={String(base.letterSpacing)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cursor style">
          <Select
            value={appearance.cursorStyle ?? "__inherit"}
            onValueChange={(v) =>
              patch({
                cursorStyle:
                  v === "__inherit"
                    ? undefined
                    : (v as RemoteProfile["appearance"]["cursorStyle"]),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit">
                Follow settings ({base.cursorStyle})
              </SelectItem>
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {style}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Scrollback">
          <Input
            type="number"
            value={appearance.scrollback ?? ""}
            onChange={(e) =>
              patch({
                scrollback: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
            placeholder={String(base.scrollback)}
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="remote-cursor-blink"
          checked={appearance.cursorBlink ?? base.cursorBlink}
          onCheckedChange={(v) => patch({ cursorBlink: v === true })}
        />
        <Label
          htmlFor="remote-cursor-blink"
          className="cursor-pointer text-[11.5px]"
        >
          Blink the cursor
        </Label>
      </div>
    </div>
  );
}


function ForwardEditor({
  forwards,
  onChange,
}: {
  forwards: RemoteForward[];
  onChange: (forwards: RemoteForward[]) => void;
}) {
  const update = (index: number, next: Partial<RemoteForward>) =>
    onChange(forwards.map((f, i) => (i === index ? { ...f, ...next } : f)));

  return (
    <div className="space-y-2">
      {forwards.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-[11px] text-muted-foreground">
          No forwards configured.
        </p>
      ) : null}

      {forwards.map((forward, index) => (
        <div
          key={forward.id}
          className="space-y-2 rounded-md border border-border/60 bg-foreground/[0.03] p-2"
        >
          <div className="flex items-center gap-1.5">
            <Input
              value={forward.label ?? ""}
              onChange={(e) =>
                update(index, { label: e.target.value || undefined })
              }
              placeholder="Label (optional)"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 text-[11px]"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove forward"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={() => onChange(forwards.filter((_, i) => i !== index))}
            >
              <HugeiconsIcon icon={Delete02Icon} size={12} />
            </Button>
          </div>
          <div className="grid grid-cols-[6rem_1fr_5rem] items-center gap-1.5">
            <Input
              type="number"
              min={0}
              max={65535}
              value={forward.localPort === 0 ? "" : forward.localPort}
              onChange={(e) =>
                update(index, { localPort: parsePort(e.target.value) ?? 0 })
              }
              placeholder="auto"
              title="Local port; leave empty to let the OS choose"
              className="h-7 text-[11px]"
            />
            <Input
              value={forward.remoteHost}
              onChange={(e) => update(index, { remoteHost: e.target.value })}
              placeholder="localhost"
              spellCheck={false}
              title="Resolved on the remote"
              className="h-7 min-w-0 text-[11px]"
            />
            <Input
              type="number"
              min={1}
              max={65535}
              value={forward.remotePort || ""}
              onChange={(e) =>
                update(index, { remotePort: parsePort(e.target.value) ?? 0 })
              }
              placeholder="port"
              className="h-7 text-[11px]"
            />
          </div>
          <Input
            value={forward.bindAddress ?? ""}
            onChange={(e) =>
              update(index, { bindAddress: e.target.value || undefined })
            }
            placeholder="127.0.0.1"
            spellCheck={false}
            title="Local bind address"
            className="h-7 text-[11px]"
          />
        </div>
      ))}

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-[11px]"
        onClick={() =>
          onChange([
            ...forwards,
            {
              id: crypto.randomUUID(),
              localPort: 0,
              remoteHost: "localhost",
              remotePort: 0,
            },
          ])
        }
      >
        <HugeiconsIcon icon={PlusSignIcon} size={11} />
        Add forward
      </Button>
      <p className="text-[10.5px] leading-snug text-muted-foreground/80">
        The bind address defaults to 127.0.0.1. Any other value exposes the
        remote service to your whole network.
      </p>
    </div>
  );
}
