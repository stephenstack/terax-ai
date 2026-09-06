/**
 * What the user has typed at the prompt, tracked from keystrokes.
 *
 * A classic terminal has no editable buffer to read: input goes straight to
 * the shell and only its echo comes back. So the line is reconstructed from
 * the keys on their way past, which is enough to ask the model what might
 * come next, and cheap enough to do on every keystroke.
 *
 * It is deliberately conservative. Anything it cannot account for, a control
 * key, a paste, an arrow, abandons the line rather than guessing, because a
 * wrong line produces a confidently wrong suggestion.
 */

export type LineEdit =
  | { kind: "insert"; text: string }
  | { kind: "backspace" }
  | { kind: "reset" }
  | { kind: "abandon" };

export function classifyKey(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): LineEdit {
  if (e.altKey || e.metaKey) return { kind: "abandon" };

  if (e.ctrlKey) {
    // The line is gone either way; c and u clear it, anything else may not.
    return e.key === "c" || e.key === "u" ? { kind: "reset" } : { kind: "abandon" };
  }

  if (e.key === "Enter") return { kind: "reset" };
  if (e.key === "Backspace") return { kind: "backspace" };
  if (e.key === "Escape") return { kind: "abandon" };
  // Arrows, Home, End, Tab: the shell may rewrite the line and we would not
  // see it. History recall is the worst of them, so stop tracking.
  if (e.key.length !== 1) return { kind: "abandon" };

  return { kind: "insert", text: e.key };
}

export function applyEdit(line: string, edit: LineEdit): string | null {
  switch (edit.kind) {
    case "insert":
      return line + edit.text;
    case "backspace":
      return line.slice(0, -1);
    case "reset":
      return "";
    case "abandon":
      return null;
  }
}

/**
 * The model is asked to continue the line, but happily repeats it instead, or
 * answers with several. Only the remainder of the current line is usable.
 */
export function suggestionFor(line: string, raw: string): string {
  const first = raw.split("\n")[0] ?? "";
  if (!first.trim()) return "";
  const trimmedLine = line.trimStart();
  // A model that echoed the line is offering the rest of it after the echo.
  if (trimmedLine && first.startsWith(trimmedLine)) {
    return first.slice(trimmedLine.length);
  }
  return first;
}
