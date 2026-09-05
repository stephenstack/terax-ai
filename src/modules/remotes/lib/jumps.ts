/** A parsed `ProxyJump` hop. */
export type JumpSpec = {
  user: string | null;
  host: string;
  port: number | null;
};

/**
 * Parse `[user@]host[:port]`, the form OpenSSH's `ProxyJump` takes.
 *
 * Returns null for anything unusable so a malformed entry is skipped rather
 * than turned into a connection attempt against a nonsense address.
 */
export function parseJumpSpec(raw: string): JumpSpec | null {
  const spec = raw.trim();
  if (!spec) return null;

  const at = spec.lastIndexOf("@");
  const user = at >= 0 ? spec.slice(0, at) : null;
  const rest = at >= 0 ? spec.slice(at + 1) : spec;
  if (at >= 0 && !user) return null;
  if (!rest) return null;

  // A bracketed IPv6 literal is the only unambiguous way to also give a port.
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) return null;
    const host = rest.slice(1, end);
    const after = rest.slice(end + 1);
    if (!host) return null;
    if (!after) return { user, host, port: null };
    if (!after.startsWith(":")) return null;
    const port = toPort(after.slice(1));
    return port === null ? null : { user, host, port };
  }

  const colon = rest.lastIndexOf(":");
  // More than one colon and no brackets is a bare IPv6 address, not host:port.
  if (colon > 0 && rest.indexOf(":") === colon) {
    const host = rest.slice(0, colon);
    const port = toPort(rest.slice(colon + 1));
    if (!host) return null;
    return port === null ? null : { user, host, port };
  }
  return { user, host: rest, port: null };
}

function toPort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Render a hop back to its canonical spec, for display. */
export function formatJumpSpec(spec: JumpSpec): string {
  const host = spec.host.includes(":") ? `[${spec.host}]` : spec.host;
  const withUser = spec.user ? `${spec.user}@${host}` : host;
  return spec.port ? `${withUser}:${spec.port}` : withUser;
}
