import { create } from "zustand";
import type { PtySession } from "@/modules/terminal";
import { registerRemoteOpener } from "@/modules/terminal";
import { cancelPrompt, openSsh, respondToPrompt } from "./ssh-bridge";
import { findProfile } from "./store";
import type { RemoteProfile, SshEvent, SshTarget } from "./types";

/** A question the connect task is blocked on, surfaced as a modal. */
export type PendingPrompt =
  | {
      kind: "hostKey";
      sessionId: number;
      promptId: number;
      host: string;
      port: number;
      fingerprint: string;
      algorithm: string;
      status: "unknown" | "changed";
      conflictLine: number | null;
      profileName: string;
    }
  | {
      kind: "auth";
      sessionId: number;
      promptId: number;
      authKind: "password" | "passphrase" | "keyboard-interactive";
      prompt: string;
      echo: boolean;
      instructions: string | null;
      profileName: string;
    };

/** Prompt ids restart at 1 for every session, so only the pair is unique. */
export function promptKey(prompt: {
  sessionId: number;
  promptId: number;
}): string {
  return `${prompt.sessionId}:${prompt.promptId}`;
}

type PromptState = {
  queue: PendingPrompt[];
  push: (prompt: PendingPrompt) => void;
  resolve: (key: string, value: string) => void;
  /** Abandon the prompt and the connect attempt behind it. */
  cancel: (key: string) => void;
};

export const usePromptStore = create<PromptState>((set, get) => ({
  queue: [],
  push: (prompt) => set((s) => ({ queue: [...s.queue, prompt] })),
  resolve: (key, value) => {
    const prompt = get().queue.find((p) => promptKey(p) === key);
    if (!prompt) return;
    set((s) => ({ queue: s.queue.filter((p) => promptKey(p) !== key) }));
    void respondToPrompt(prompt.sessionId, prompt.promptId, value).catch(() => {
      // The session can vanish between the prompt and the answer; the connect
      // task is already unblocked by its own cancellation in that case.
    });
  },
  cancel: (key) => {
    const prompt = get().queue.find((p) => promptKey(p) === key);
    if (!prompt) return;
    set((s) => ({ queue: s.queue.filter((p) => promptKey(p) !== key) }));
    void cancelPrompt(prompt.sessionId, prompt.promptId).catch(() => {
      // The session can vanish first; its own cancellation already unblocked
      // the connect task in that case.
    });
  },
}));

function profileToTarget(profile: RemoteProfile): SshTarget {
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    auth: profile.auth,
    term: profile.term,
    cwd: profile.cwd,
    command: profile.command,
    keepaliveSecs: profile.keepaliveSecs,
    connectTimeoutSecs: profile.connectTimeoutSecs,
    compression: profile.compression,
    env: profile.env,
  };
}

const PHASE_LABEL: Record<string, string> = {
  connecting: "Connecting",
  authenticating: "Authenticating",
  opening: "Starting shell",
};

const encoder = new TextEncoder();

/** Status text goes into the grid so it scrolls with the session, the same
 *  way ssh's own progress and banners do. */
function status(
  write: (bytes: Uint8Array) => void,
  text: string,
  colour = "2",
): void {
  write(encoder.encode(`\x1b[${colour}m${text}\x1b[0m\r\n`));
}

/**
 * Wire the remotes module into the terminal's spawn path. Called once at boot;
 * the terminal only ever sees a `PtySession`.
 */
export function installRemoteOpener(): void {
  registerRemoteOpener(async (remoteId, cols, rows, handlers) => {
    const profile = findProfile(remoteId);
    if (!profile) throw new Error("that remote host no longer exists");

    const label = profile.name.trim() || profile.host;
    status(handlers.onData, `Connecting to ${label}...`);

    let sessionId = 0;
    const onEvent = (event: SshEvent) => {
      const s = usePromptStore.getState();
      switch (event.type) {
        case "phase":
          // "connecting" was already announced before the call.
          if (event.phase !== "connecting") {
            status(handlers.onData, `${PHASE_LABEL[event.phase]}...`);
          }
          break;
        case "hostKey":
          if (event.status === "trusted") break;
          s.push({
            kind: "hostKey",
            sessionId,
            promptId: event.promptId,
            host: event.host,
            port: event.port,
            fingerprint: event.fingerprint,
            algorithm: event.algorithm,
            status: event.status,
            conflictLine: event.conflictLine,
            profileName: profile.name || profile.host,
          });
          break;
        case "authPrompt":
          s.push({
            kind: "auth",
            sessionId,
            promptId: event.promptId,
            authKind: event.kind,
            prompt: event.prompt,
            echo: event.echo,
            instructions: event.instructions,
            profileName: profile.name || profile.host,
          });
          break;
        case "banner":
          status(handlers.onData, event.text.replace(/\r?\n/g, "\r\n"));
          break;
        case "error":
          status(handlers.onData, `[terax] ${event.message}`, "31");
          break;
      }
    };

    try {
      const session: PtySession & { id: number } = await openSsh(
        cols,
        rows,
        profileToTarget(profile),
        {
          onData: handlers.onData,
          onEvent,
          onExit: handlers.onExit,
        },
        (reserved) => {
          sessionId = reserved;
        },
      );
      return session;
    } catch (e) {
      // A failed or cancelled connect leaves nothing to answer.
      usePromptStore.setState((prev) => ({
        queue: prev.queue.filter((p) => p.sessionId !== sessionId),
      }));
      throw e;
    }
  });
}
