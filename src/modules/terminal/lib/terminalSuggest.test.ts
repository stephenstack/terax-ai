import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      autocompleteEnabled: true,
      terminalAutocomplete: true,
      autocompleteProvider: "openai",
    }),
  },
}));
import { TerminalSuggest } from "./terminalSuggest";

function fakeTerm() {
  return {
    cols: 80,
    buffer: { active: { cursorX: 5 } },
    registerMarker: () => ({}),
    registerDecoration: () => ({ onRender: () => {}, dispose: () => {} }),
    input: vi.fn(),
  } as never;
}

const key = (over: Record<string, unknown>) =>
  ({ key: "", ctrlKey: false, altKey: false, metaKey: false, ...over }) as never;

describe("TerminalSuggest", () => {
  it("passes ordinary keys through to the shell", () => {
    const s = new TerminalSuggest(fakeTerm(), () => null, async () => "");
    expect(s.onKey(key({ key: "l" }))).toBe(false);
    expect(s.onKey(key({ key: "Enter" }))).toBe(false);
  });

  it("does not consume an arrow when there is nothing to accept", () => {
    // Otherwise cursor movement would silently stop working.
    const s = new TerminalSuggest(fakeTerm(), () => null, async () => "");
    expect(s.onKey(key({ key: "ArrowRight" }))).toBe(false);
  });

  it("accepts a suggestion by writing it, once", async () => {
    const term = fakeTerm();
    const s = new TerminalSuggest(term, () => null, async () => "eckout main");
    // Shorter than three characters is not worth asking about.
    for (const c of "git ch") s.onKey(key({ key: c }));
    await new Promise((r) => setTimeout(r, 400));

    expect(s.onKey(key({ key: "ArrowRight" }))).toBe(true);
    expect((term as unknown as { input: { mock: { calls: unknown[] } } }).input.mock.calls.length).toBe(1);
    // Gone after accepting: a second arrow is the user moving the cursor.
    expect(s.onKey(key({ key: "ArrowRight" }))).toBe(false);
  });
});
