/**
 * A remote shell is the host's own, so nothing reports its directory: the
 * OSC 7 emitters that ship with Linux desktops are gated on running under a
 * VTE terminal, which an SSH session is not. Terax therefore installs a
 * prompt hook of its own on connect.
 *
 * It appends rather than replaces, so a prompt the user already had survives,
 * and it lives only for this session: nothing is written to the host.
 */

/**
 * The emitter as a single-quoted shell literal, so its variables expand at
 * each prompt rather than once, when it is installed.
 */
const EMIT = `'printf "\\033]7;file://%s%s\\033\\\\" "$__terax_h" "$PWD"'`;

export const SHELL_INTEGRATION = [
  // A leading space keeps it out of history where the shell honours that.
  ` __terax_h="\${HOSTNAME:-\${HOST:-}}";`,
  ` if [ -n "\${BASH_VERSION:-}" ]; then`,
  ` PROMPT_COMMAND=\${PROMPT_COMMAND:+$PROMPT_COMMAND; }${EMIT};`,
  ` elif [ -n "\${ZSH_VERSION:-}" ]; then`,
  ` __terax_precmd() { eval ${EMIT}; };`,
  ` precmd_functions+=(__terax_precmd);`,
  ` fi`,
].join("");

/** Wait for the session to stop talking before typing into it. */
const SETTLE_MS = 400;

/**
 * Send the hook once the session has gone quiet.
 *
 * Typing it the instant bytes appear puts it into whatever is still running:
 * a login banner's pager, a shell that has not finished setting up its tty, a
 * prompt that has not been drawn. Waiting for a pause means it lands at a
 * prompt, which is the only place it makes sense.
 *
 * Returns a function to call on every chunk, and one to cancel.
 */
export function armShellIntegration(write: (data: string) => void): {
  onData: () => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sent = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    onData: () => {
      if (sent) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        sent = true;
        write(`${SHELL_INTEGRATION}\r`);
      }, SETTLE_MS);
    },
    cancel: () => {
      sent = true;
      clear();
    },
  };
}
