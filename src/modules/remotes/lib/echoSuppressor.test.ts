import { describe, expect, it } from "vitest";
import { createEchoSuppressor } from "./echoSuppressor";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const LINE = " __terax_h=x; echo hi";

function run(chunks: string[]): string {
  const filter = createEchoSuppressor(LINE);
  return chunks.map((c) => dec(filter(enc(c)))).join("");
}

describe("createEchoSuppressor", () => {
  it("removes the echoed line and its ending", () => {
    expect(run([`${LINE}\r\n$ `])).toBe("$ ");
  });

  it("passes a banner through and only then eats the echo", () => {
    const banner = "Welcome to prod\r\nLast login: Tue\r\n";
    expect(run([`${banner}${LINE}\r\n$ `])).toBe(`${banner}$ `);
  });

  it("handles the echo split across chunks", () => {
    const a = LINE.slice(0, 5);
    const b = LINE.slice(5);
    expect(run([a, `${b}\r\n$ `])).toBe("$ ");
  });

  it("removes both copies: the pty echo and readline's redraw", () => {
    // Seen on a real host: once as it arrives, once under the prompt.
    const prompt = "host:~$ ";
    expect(run([`${LINE}\r\n${prompt}${LINE}\r\n${prompt}`])).toBe(
      `${prompt}${prompt}`,
    );
  });

  it("keeps everything when the echo never comes", () => {
    const out = "total 0\r\ndrwxr-xr-x 2 me me\r\n";
    expect(run([out])).toBe(out);
  });

  it("hands back what it withheld when the match derails", () => {
    // Starts like the line, then diverges: the user typed something similar.
    const typed = " __terax_h=SOMETHING ELSE\r\n";
    expect(run([typed])).toBe(typed);
  });

  it("stops filtering after the copies it expects", () => {
    const filter = createEchoSuppressor(LINE);
    dec(filter(enc(`${LINE}\r\n`)));
    dec(filter(enc(`${LINE}\r\n`)));
    // A third is the user typing it, and is theirs to see.
    expect(dec(filter(enc(`${LINE}\r\n`)))).toBe(`${LINE}\r\n`);
  });

  it("does not swallow a prompt that follows immediately", () => {
    expect(run([`${LINE}\r\nuser@host:~$ `])).toBe("user@host:~$ ");
  });
});
