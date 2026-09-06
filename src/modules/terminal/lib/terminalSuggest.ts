import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Terminal } from "@xterm/xterm";
import {
  applyEdit,
  classifyKey,
  suggestionFor,
  type LineEdit,
} from "./commandLine";

/** Long enough that a typist is not billed for every keystroke. */
const DEBOUNCE_MS = 260;
/** Below this there is not enough of a command to guess at. */
const MIN_CHARS = 3;

let reported = false;

function reportOnce(e: unknown): void {
  if (reported) return;
  reported = true;
  void import("sonner").then(({ toast }) => {
    toast.error("Terminal suggestions are not available", {
      description: String(e),
    });
  });
}

type Ask = (line: string, cwd: string | null, signal: AbortSignal) => Promise<string>;

async function askModel(
  line: string,
  cwd: string | null,
  signal: AbortSignal,
): Promise<string> {
  // Imported here rather than at the top: the terminal is in the eager
  // bundle and the completion stack is not, and it stays that way until
  // someone actually turns this on.
  const [{ requestCompletion }, { resolveCompletionDeps }, { getAllKeys }] =
    await Promise.all([
      import("@/modules/editor/lib/autocomplete/provider"),
      import("@/modules/editor/lib/autocomplete/deps"),
      import("@/modules/ai/lib/keyring"),
    ]);
  const s = usePreferencesStore.getState();
  const keys = await getAllKeys().catch(() => null);
  const apiKey = keys ? (keys[s.autocompleteProvider] ?? null) : null;
  const deps = resolveCompletionDeps(s, apiKey);
  return requestCompletion(
    {
      prefix: cwd ? `# cwd: ${cwd}\n${line}` : line,
      suffix: "",
      language: "shell",
      filename: null,
      indentUnit: null,
    },
    deps,
    signal,
  );
}

/**
 * Suggests the rest of a command while it is being typed.
 *
 * The line is rebuilt from keystrokes rather than read back, so anything the
 * tracker cannot account for drops the suggestion instead of guessing. The
 * suggestion is drawn as a decoration over the grid and never written to the
 * shell, so nothing reaches the pty until it is accepted.
 */
export class TerminalSuggest {
  private line = "";
  private text = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private decoration: { dispose: () => void } | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly getCwd: () => string | null,
    private readonly ask: Ask = askModel,
  ) {}

  /** Returns true when the key was consumed and must not reach the shell. */
  onKey(e: KeyboardEvent): boolean {
    if (this.text && (e.key === "ArrowRight" || e.key === "End")) {
      const accepted = this.text;
      this.line += accepted;
      this.clear();
      this.term.input(accepted, true);
      return true;
    }

    const edit: LineEdit = classifyKey(e);
    const next = applyEdit(this.line, edit);
    this.clear();
    if (next === null) {
      this.line = "";
      return false;
    }
    this.line = next;
    if (edit.kind !== "reset") this.schedule();
    return false;
  }

  dispose(): void {
    this.clear();
    this.line = "";
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.line.trim().length < MIN_CHARS) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    const s = usePreferencesStore.getState();
    if (!s.autocompleteEnabled || !s.terminalAutocomplete) return;

    const asked = this.line;
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    try {
      const raw = await this.ask(asked, this.getCwd(), ctl.signal);
      // The line moved on while the model was thinking.
      if (ctl.signal.aborted || asked !== this.line) return;
      const text = suggestionFor(asked, raw);
      if (text) this.show(text);
    } catch (e) {
      // Once per session, and only for a real failure. Silence here is what
      // makes a missing model id or key look like a feature that does not
      // work, with nothing anywhere to say why.
      if (!ctl.signal.aborted) reportOnce(e);
    }
  }

  private show(text: string): void {
    this.clear();
    try {
      const marker = this.term.registerMarker(0);
      if (!marker) return;
      const x = this.term.buffer.active.cursorX;
      const width = Math.min(text.length, this.term.cols - x);
      if (width <= 0) return;
      const d = this.term.registerDecoration({ marker, x, width });
      if (!d) return;
      d.onRender((el: HTMLElement) => {
        el.textContent = text.slice(0, width);
        el.style.opacity = "0.45";
        el.style.pointerEvents = "none";
        el.style.whiteSpace = "pre";
      });
      this.text = text;
      this.decoration = { dispose: () => d.dispose() };
    } catch {
      this.text = "";
    }
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    try {
      this.decoration?.dispose();
    } catch {}
    this.decoration = null;
    this.text = "";
  }
}
