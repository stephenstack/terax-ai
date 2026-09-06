/**
 * Drop the shell's echo of a line Terax typed for the user.
 *
 * The remote pty echoes whatever we write, so installing the prompt hook puts
 * a long, ugly line on screen. Clearing is not an option: a host's banner and
 * login output arrive first and are the user's, not ours.
 *
 * So the echo is removed on the way in. Everything before it passes through
 * untouched, and if it never appears, or appears in a shape this cannot
 * follow, the bytes are handed over unchanged rather than lost.
 */

const CR = 13;
const LF = 10;
const ESC = 27;

/** Enough of the line to recognise it without matching ordinary output. */
const MARKER_LEN = 11;

/** Give up rather than watch forever on a shell that never echoes. */
const SEARCH_LIMIT = 64 * 1024;

/**
 * The line can surface twice: the pty echoes it as it arrives, and readline
 * redraws it beneath the prompt. Removing one would leave the other on screen.
 */
const MAX_OCCURRENCES = 2;

type Bytes = Uint8Array<ArrayBufferLike>;

export type EchoSuppressor = (chunk: Bytes) => Bytes;

export function createEchoSuppressor(text: string): EchoSuppressor {
  const target: Bytes = new TextEncoder().encode(text);
  const marker = target.subarray(0, Math.min(MARKER_LEN, target.length));

  let done = false;
  let consuming = false;
  let matched = 0;
  let trailing = false;
  let scanned = 0;
  let remaining = MAX_OCCURRENCES;
  /** Bytes withheld mid-match, emitted verbatim if the match derails. */
  let held: number[] = [];
  /** Tail kept so a marker split across two chunks is still found. */
  let pending: Bytes = new Uint8Array(0);

  return (chunk) => {
    if (done) return chunk;

    let buf = concat(pending, chunk);
    pending = new Uint8Array(0);
    const out: number[] = [];

    while (buf.length > 0) {
      if (!consuming) {
        const at = indexOf(buf, marker);
        if (at === -1) {
          scanned += buf.length;
          // Withhold only a tail that genuinely begins the marker, so ordinary
          // output is never held back waiting for bytes that will not come.
          const keep = scanned > SEARCH_LIMIT ? 0 : partialPrefix(buf, marker);
          push(out, buf.subarray(0, buf.length - keep));
          pending = keep > 0 ? buf.subarray(buf.length - keep) : pending;
          if (scanned > SEARCH_LIMIT) done = true;
          buf = new Uint8Array(0);
          break;
        }
        push(out, buf.subarray(0, at));
        buf = buf.subarray(at);
        consuming = true;
        matched = 0;
        trailing = false;
        held = [];
      }

      const rest = consume(buf);
      if (rest === null) {
        // Ran out mid-match; the remainder arrives in a later chunk.
        buf = new Uint8Array(0);
        break;
      }
      if (!consuming) {
        // The match derailed: hand back what was withheld.
        push(out, Uint8Array.from(held));
        held = [];
        done = true;
        push(out, rest);
        buf = new Uint8Array(0);
        break;
      }
      // A whole copy went by.
      consuming = false;
      held = [];
      remaining -= 1;
      if (remaining <= 0) {
        done = true;
        push(out, rest);
        buf = new Uint8Array(0);
        break;
      }
      buf = rest;
    }

    return Uint8Array.from(out);
  };

  /**
   * Returns the bytes after the echo, null if the chunk ran out mid-match, and
   * clears `consuming` when the bytes stop matching.
   */
  function consume(chunk: Bytes): Bytes | null {
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];

      if (trailing) {
        // One line ending belongs to the echo; anything after is the shell's.
        if (b === CR || b === LF) {
          continue;
        }
        return chunk.subarray(i);
      }

      // A redrawn echo carries cursor moves that are not part of what we typed.
      if (b === CR || b === LF || b === ESC) {
        held.push(b);
        continue;
      }

      if (b === target[matched]) {
        held.push(b);
        matched += 1;
        if (matched === target.length) {
          trailing = true;
          held = [];
        }
        continue;
      }

      consuming = false;
      return chunk.subarray(i);
    }
    return null;
  }
}

function push(out: number[], bytes: Bytes): void {
  for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i]);
}

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Length of the longest suffix of `buf` that is a proper prefix of `needle`.
 *
 * Short tails do not count: the line begins with a space, and withholding the
 * single space after a prompt would leave the cursor a column adrift until the
 * next byte arrived.
 */
const MIN_PARTIAL = 3;

function partialPrefix(buf: Bytes, needle: Bytes): number {
  const max = Math.min(needle.length - 1, buf.length);
  outer: for (let len = max; len >= MIN_PARTIAL; len -= 1) {
    for (let j = 0; j < len; j += 1) {
      if (buf[buf.length - len + j] !== needle[j]) continue outer;
    }
    return len;
  }
  return 0;
}

function indexOf(haystack: Bytes, needle: Bytes): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
