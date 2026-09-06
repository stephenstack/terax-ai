/**
 * A remote workspace has no local process to keep, so the agent's persistent
 * shell cannot exist there: a session holds a working directory across calls,
 * and that lives in a process on this machine.
 *
 * Each call therefore runs on its own over the connection, and the working
 * directory is carried by asking the far side where it ended up and handing it
 * back on the next call. That is what makes `cd foo` then `pwd` behave the way
 * the tool says it does.
 */

/** Unlikely in real output, and stripped before the agent ever sees it. */
const MARKER = "terax-cwd:";

/**
 * Wrap so the command's own exit status survives, rather than being replaced
 * by that of the echo which follows it.
 */
export function wrapForCwd(command: string): string {
  return `{ ${command}
}; __terax_rc=$?; printf '${MARKER}%s' "$PWD"; exit $__terax_rc`;
}

export type CwdSplit = { stdout: string; cwd: string | null };

export function splitCwd(stdout: string): CwdSplit {
  const at = stdout.lastIndexOf(MARKER);
  if (at === -1) return { stdout, cwd: null };
  const cwd = stdout.slice(at + MARKER.length).trim();
  return { stdout: stdout.slice(0, at), cwd: cwd || null };
}
