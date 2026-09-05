import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtySession } from "@/modules/terminal";
import type { DiscoveredKey, SshConfigHost, SshEvent, SshTarget } from "./types";

const textEncoder = new TextEncoder();

export type SshHandlers = {
  onData: (bytes: Uint8Array) => void;
  onEvent: (event: SshEvent) => void;
  onExit?: (code: number) => void;
};

/**
 * Opens an SSH session and returns it in the same shape as a local PTY, so the
 * terminal stack does not need to know which kind of session it is driving.
 *
 * The id is reserved before connecting: a host-key prompt fires during the
 * handshake, and its answer has to be addressable before `ssh_open` resolves.
 */
export async function openSsh(
  cols: number,
  rows: number,
  target: SshTarget,
  handlers: SshHandlers,
  /** Receives the reserved id before the handshake, so prompts raised during
   *  it can be answered against a session that does not exist yet. */
  onReserved?: (id: number) => void,
): Promise<PtySession & { id: number }> {
  const onData = new Channel<ArrayBuffer>();
  const onEvent = new Channel<SshEvent>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onEvent.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onEvent.onmessage = (event) => handlers.onEvent(event);
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("ssh_reserve");
  onReserved?.(id);

  try {
    await invoke<number>("ssh_open", {
      id,
      cols,
      rows,
      target,
      onData,
      onEvent,
      onExit,
    });
  } catch (e) {
    releaseHandlers();
    // The reservation may have registered a prompt bus mid-handshake; close so
    // a cancelled connect cannot strand it.
    void invoke("ssh_close", { id }).catch(() => {});
    throw e;
  }

  let closed = false;
  const headers = { "x-ssh-id": String(id) };

  return {
    id,
    write: (data) => invoke("ssh_write", textEncoder.encode(data), { headers }),
    resize: (c, r) => invoke("ssh_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("ssh_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}

export function respondToPrompt(
  id: number,
  promptId: number,
  value: string,
): Promise<void> {
  return invoke("ssh_prompt_respond", { id, promptId, value });
}

/** Abandon a prompt. Not the same as answering with an empty string, which
 *  the server would see as a real (failing) attempt. */
export function cancelPrompt(id: number, promptId: number): Promise<void> {
  return invoke("ssh_prompt_cancel", { id, promptId });
}

export function discoverKeys(): Promise<DiscoveredKey[]> {
  return invoke<DiscoveredKey[]>("ssh_discover_keys");
}

export function agentIdentities(): Promise<string[]> {
  return invoke<string[]>("ssh_agent_identities");
}

export function readSshConfig(): Promise<SshConfigHost[]> {
  return invoke<SshConfigHost[]>("ssh_read_config");
}
