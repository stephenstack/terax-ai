import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert01Icon, ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { promptKey, usePromptStore, type PendingPrompt } from "./lib/opener";

/**
 * Renders the one prompt the connect task is currently blocked on. Mounted
 * once at the app root; multiple concurrent connects queue behind each other
 * so the user is never asked two questions at once.
 */
export function RemotePrompts() {
  const prompt = usePromptStore((s) => s.queue[0]);
  if (!prompt) return null;
  return prompt.kind === "hostKey" ? (
    <HostKeyDialog key={promptKey(prompt)} prompt={prompt} />
  ) : (
    <AuthDialog key={promptKey(prompt)} prompt={prompt} />
  );
}

type HostKeyPrompt = Extract<PendingPrompt, { kind: "hostKey" }>;
type AuthPrompt = Extract<PendingPrompt, { kind: "auth" }>;

function HostKeyDialog({ prompt }: { prompt: HostKeyPrompt }) {
  const resolve = usePromptStore((s) => s.resolve);
  const changed = prompt.status === "changed";
  const key = promptKey(prompt);
  const target =
    prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing the dialog is a refusal, never an implicit accept.
        if (!open) resolve(key, "reject");
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={changed ? Alert01Icon : ShieldKeyIcon}
              size={16}
              strokeWidth={1.9}
              className={changed ? "text-destructive" : "text-muted-foreground"}
            />
            {changed ? "Host key has changed" : "Unknown host key"}
          </DialogTitle>
          <DialogDescription>
            {changed ? (
              <>
                The key offered by <span className="font-medium">{target}</span>{" "}
                does not match the one recorded in <code>known_hosts</code>
                {prompt.conflictLine ? ` (line ${prompt.conflictLine})` : null}.
                This happens after a legitimate server rebuild, and it is also
                exactly what a machine-in-the-middle looks like. Do not continue
                unless you know why it changed.
              </>
            ) : (
              <>
                <span className="font-medium">{target}</span> has not been seen
                before. Check the fingerprint against a source you trust before
                accepting it.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-md border border-border/60 bg-foreground/[0.03] p-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
            {prompt.algorithm}
          </div>
          <code className="block break-all text-[11.5px] leading-relaxed text-foreground">
            {prompt.fingerprint}
          </code>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => resolve(key, "reject")}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => resolve(key, "accept")}>
              Accept once
            </Button>
            <Button
              variant={changed ? "destructive" : "default"}
              onClick={() => resolve(key, "accept-and-remember")}
            >
              {changed ? "Replace and continue" : "Accept and remember"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AUTH_TITLE: Record<AuthPrompt["authKind"], string> = {
  password: "Password required",
  passphrase: "Key passphrase required",
  "keyboard-interactive": "Authentication required",
};

function AuthDialog({ prompt }: { prompt: AuthPrompt }) {
  const resolve = usePromptStore((s) => s.resolve);
  const cancel = usePromptStore((s) => s.cancel);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const key = promptKey(prompt);

  useEffect(() => {
    // Autofocus so the flow stays keyboard-only.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel(key);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            resolve(key, value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{AUTH_TITLE[prompt.authKind]}</DialogTitle>
            <DialogDescription>
              {prompt.instructions?.trim() || prompt.profileName}
            </DialogDescription>
          </DialogHeader>

          <div className="my-4 space-y-2">
            <Label htmlFor="remote-auth-value" className="text-[11.5px]">
              {prompt.prompt}
            </Label>
            <Input
              id="remote-auth-value"
              ref={inputRef}
              type={prompt.echo ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => cancel(key)}>
              Cancel
            </Button>
            <Button type="submit">Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
