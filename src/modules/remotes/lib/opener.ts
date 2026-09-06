import { create } from "zustand";
import type { PtySession } from "@/modules/terminal";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { registerRemoteOpener } from "@/modules/terminal";
import { cancelPrompt, openSsh, respondToPrompt } from "./ssh-bridge";
import { createEchoSuppressor } from "./echoSuppressor";
import {
  installShellIntegration,
  SHELL_INTEGRATION,
} from "./shellIntegration";
import { profileToTarget } from "./target";
import { findProfile } from "./store";
import type { SshEvent } from "./types";

/** Terminal sessions and remote workspaces are separate pools with separate
 *  respond commands, so a prompt has to say which one it came from. */
type PromptScope = "terminal" | "workspace";

/** A question the connect task is blocked on, surfaced as a modal. */
export type PendingPrompt =
  | {
      kind: "hostKey";
      /** Which connection pool owns this prompt; they have separate commands. */
      scope?: PromptScope;
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
      scope?: PromptScope;
      sessionId: number;
      promptId: number;
      authKind: "password" | "passphrase" | "keyboard-interactive";
      prompt: string;
      echo: boolean;
      instructions: string | null;
      profileName: string;
    };

/**
 * Prompt ids restart at 1 for every session, and terminal sessions and remote
 * workspaces are numbered by independent counters that both start at 1. The
 * pool therefore has to be part of the key, or a terminal prompt and a
 * workspace prompt raised at the same time collide and answering one silently
 * discards the other.
 */
export function promptKey(prompt: {
  scope?: PromptScope;
  sessionId: number;
  promptId: number;
}): string {
  return `${prompt.scope ?? "terminal"}:${prompt.sessionId}:${prompt.promptId}`;
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
    void respondToPrompt(
      prompt.sessionId,
      prompt.promptId,
      value,
      prompt.scope ?? "terminal",
    ).catch(() => {
      // The session can vanish between the prompt and the answer; the connect
      // task is already unblocked by its own cancellation in that case.
    });
  },
  cancel: (key) => {
    const prompt = get().queue.find((p) => promptKey(p) === key);
    if (!prompt) return;
    set((s) => ({ queue: s.queue.filter((p) => promptKey(p) !== key) }));
    void cancelPrompt(
      prompt.sessionId,
      prompt.promptId,
      prompt.scope ?? "terminal",
    ).catch(() => {
      // The session can vanish first; its own cancellation already unblocked
      // the connect task in that case.
    });
  },
}));

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

    // The host's own shell reports nothing about where it is, so the tree and
    // the git section have nothing to follow until the hook is installed. Its
    // echo is stripped from the stream rather than cleared from the screen,
    // which would take the host's banner and login output with it.
    const integrate = usePreferencesStore.getState().remoteFollowTerminal;
    const suppress = integrate
      ? createEchoSuppressor(SHELL_INTEGRATION)
      : null;
    let sendIntegration: (() => void) | null = null;
    let filter = suppress;
    const onData = (bytes: Uint8Array) => {
      // Nothing about following the terminal is worth a dead session, and a
      // throw in here is swallowed by the channel, which would look like a
      // host that connected and then said nothing.
      let out = bytes;
      if (filter) {
        try {
          out = filter(bytes);
        } catch {
          filter = null;
          out = bytes;
        }
      }
      handlers.onData(out);

      // Sent once the shell has spoken, so readline draws it under the prompt
      // rather than the pty echoing it raw beforehand as well.
      const send = sendIntegration;
      sendIntegration = null;
      try {
        send?.();
      } catch {}
    };

    try {
      const session: PtySession & { id: number } = await openSsh(
        cols,
        rows,
        profileToTarget(profile),
        {
          onData,
          onEvent,
          onExit: handlers.onExit,
        },
        (reserved) => {
          sessionId = reserved;
        },
      );
      if (integrate) {
        sendIntegration = () =>
          installShellIntegration((data) => void session.write(data));
      }
      return session;
    } catch (e) {
      // A failed or cancelled connect leaves nothing to answer.
      usePromptStore.setState((prev) => ({
        queue: prev.queue.filter(
          (p) => (p.scope ?? "terminal") !== "terminal" || p.sessionId !== sessionId,
        ),
      }));
      throw e;
    }
  });
}
