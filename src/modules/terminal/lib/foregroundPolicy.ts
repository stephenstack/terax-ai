/**
 * Whether a leaf counts as busy, for leaves the local PTY commands cannot
 * answer for.
 *
 * A remote session's id belongs to `SshState`, not `PtyState`, and the two
 * counters are independent: passing an SSH id to `pty_has_foreground_*` would
 * either miss entirely or, worse, answer about an unrelated local shell that
 * happens to share the number. So remote leaves never reach those commands and
 * are judged from the signals we do have.
 */

/**
 * Renderer-slot release. A released slot is later restored by replaying a
 * serialized snapshot, which corrupts a pane that was mid-command (the reason
 * TUIs used to be wiped). There is no remote equivalent of `tcgetpgrp`, so a
 * remote leaf stays parked: the grid stays live with rendering paused, which
 * is cheap and cannot corrupt anything.
 */
export function remoteLeafHoldsSlot(): boolean {
  return true;
}

/**
 * Close confirmation. Prompting on every remote tab regardless of state would
 * be noise, so use the command-boundary signal instead: accurate when the
 * remote shell emits OSC 133, and quiet when it does not, which is exactly how
 * a local shell without integration already behaves.
 */
export function remoteLeafHasForegroundProcess(commandRunning: boolean): boolean {
  return commandRunning;
}
