import { describe, expect, it } from "vitest";
import { installShellIntegration, SHELL_INTEGRATION } from "./shellIntegration";

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

  it("submits the line with a carriage return", () => {
    let sent = "";
    installShellIntegration((d) => {
      sent = d;
    });
    // CR, not LF: the same reason the terminal sends CR for Enter.
    expect(sent.endsWith("\r")).toBe(true);
  });
});
