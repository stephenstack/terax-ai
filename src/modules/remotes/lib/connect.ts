import { Channel, invoke } from "@tauri-apps/api/core";
import { usePromptStore } from "./opener";
import { profileToTarget } from "./target";
import type { RemoteProfile, SshEvent } from "./types";

export type RemoteOpened = {
  conn: number;
  home: string;
  host: string;
  user: string;
};

/**
 * Open a connection in the remote pool, answering the host key and auth
 * prompts a handshake raises. Shared by the workspace and the file browser so
 * the prompt wiring and the failure cleanup exist once.
 *
 * Prompts are scoped "workspace" because that names the pool, not the feature:
 * both answer on `remote_prompt_respond`, which terminal sessions do not.
 */
export async function openRemoteConnection(
  profile: RemoteProfile,
): Promise<RemoteOpened> {
  const onEvent = new Channel<SshEvent>();
  let conn = 0;
  onEvent.onmessage = (event) => {
    const s = usePromptStore.getState();
    const name = profile.name || profile.host;
    if (event.type === "hostKey" && event.status !== "trusted") {
      s.push({
        kind: "hostKey",
        sessionId: conn,
        promptId: event.promptId,
        host: event.host,
        port: event.port,
        fingerprint: event.fingerprint,
        algorithm: event.algorithm,
        status: event.status,
        conflictLine: event.conflictLine,
        profileName: name,
        scope: "workspace",
      });
    } else if (event.type === "authPrompt") {
      s.push({
        kind: "auth",
        sessionId: conn,
        promptId: event.promptId,
        authKind: event.kind,
        prompt: event.prompt,
        echo: event.echo,
        instructions: event.instructions,
        profileName: name,
        scope: "workspace",
      });
    }
  };

  try {
    conn = await invoke<number>("remote_reserve");
    return await invoke<RemoteOpened>("remote_open", {
      id: conn,
      target: profileToTarget(profile),
      onEvent,
    });
  } catch (e) {
    // Drop any prompt still queued against this attempt, or it outlives the
    // connect it was blocking and can never be answered.
    usePromptStore.setState((prev) => ({
      queue: prev.queue.filter(
        (p) => p.scope !== "workspace" || p.sessionId !== conn,
      ),
    }));
    void invoke("remote_close", { id: conn }).catch(() => {});
    throw e;
  }
}
