import { describe, expect, it } from "vitest";
import { armShellIntegration, SHELL_INTEGRATION } from "./shellIntegration";

describe("SHELL_INTEGRATION", () => {
  it("keeps the emitter unexpanded so it runs at each prompt", () => {
    // Verified against a real bash over SSH: double quotes here would end the
    // assignment early and install nothing.
    expect(SHELL_INTEGRATION).toContain(
      `'printf "\\033]7;file://%s%s\\033\\\\" "$__terax_h" "$PWD"'`,
    );
  });

  it("appends to a prompt hook the user already had", () => {
    expect(SHELL_INTEGRATION).toContain(":+$PROMPT_COMMAND; }");
  });

  it("handles zsh separately and leaves anything else alone", () => {
    expect(SHELL_INTEGRATION).toContain("precmd_functions+=(__terax_precmd)");
    expect(SHELL_INTEGRATION.trimEnd().endsWith("fi")).toBe(true);
  });

  it("starts with a space so it stays out of history", () => {
    expect(SHELL_INTEGRATION.startsWith(" ")).toBe(true);
  });

  it("waits for a pause before typing, and only types once", async () => {
    let sent = "";
    let calls = 0;
    const armed = armShellIntegration((d: string) => {
      sent = d;
      calls += 1;
    });

    // Still talking: a banner's pager would swallow the line.
    armed.onData();
    armed.onData();
    expect(calls).toBe(0);

    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toBe(1);
    // CR, not LF: the same reason the terminal sends CR for Enter.
    expect(sent.endsWith("\r")).toBe(true);

    armed.onData();
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toBe(1);
  });

  it("can be cancelled before it types anything", async () => {
    let calls = 0;
    const armed = armShellIntegration(() => {
      calls += 1;
    });
    armed.onData();
    armed.cancel();
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toBe(0);
  });
});
