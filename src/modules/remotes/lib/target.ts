import type { RemoteProfile, SshTarget } from "./types";

/** Shape a stored profile into the connect request the backend takes. */
export function profileToTarget(profile: RemoteProfile): SshTarget {
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
