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

/**
 * Safe to send the moment the channel is open: the remote pty buffers input,
 * so the line waits and runs at the first prompt, after the rc files that
 * would otherwise overwrite what it sets.
 */
export function installShellIntegration(write: (data: string) => void): void {
  write(`${SHELL_INTEGRATION}\r`);
}
