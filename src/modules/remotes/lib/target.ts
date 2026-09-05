import { parseJumpSpec } from "./jumps";
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
    // A bastion inherits the profile's auth methods and user unless its own
    // spec says otherwise, which is what someone means by a jump host.
    jumps: (profile.jumps ?? []).flatMap((spec) => {
      const hop = parseJumpSpec(spec);
      if (!hop) return [];
      return [
        {
          host: hop.host,
          port: hop.port,
          user: hop.user ?? profile.user,
          auth: profile.auth,
          env: [],
          jumps: [],
          connectTimeoutSecs: profile.connectTimeoutSecs,
        } satisfies SshTarget,
      ];
    }),
  };
}
