// Terminal control characters from audited pages must not reach a terminal, a
// report file, or an agent's context.

import { describe, expect, test } from "bun:test";

import {
  stripControlChars,
  stripControlCharsPreservingSgr,
  stripControlCharsUnknown,
} from "../src/control-chars";

const ESC = "\x1b";
/** Clear screen + home cursor: enough to blank findings and repaint forged text. */
const HIJACK = `${ESC}[2J${ESC}[1;1H`;

describe("stripControlChars", () => {
  test("removes the screen-clearing payload", () => {
    const out = stripControlChars(`real finding${HIJACK}FORGED CLEAN RESULT`);
    expect(out).not.toContain(ESC);
    expect(out).toBe("real finding[2J[1;1HFORGED CLEAN RESULT");
  });

  test("removes ESC even when it would otherwise set colour", () => {
    // File and pipe output has no business carrying escapes at all.
    expect(stripControlChars(`${ESC}[31mred${ESC}[0m`)).toBe("[31mred[0m");
  });

  test("keeps tab and newline", () => {
    // Report output is legitimately laid out with these.
    expect(stripControlChars("a\tb\nc")).toBe("a\tb\nc");
  });

  test("removes carriage return, which overwrites an already-printed line", () => {
    expect(stripControlChars("real\rforged")).toBe("realforged");
    // A CRLF pair degrades to LF, so ordinary text is unaffected.
    expect(stripControlChars("a\r\nb")).toBe("a\nb");
  });

  test("removes NUL, BEL, backspace and DEL", () => {
    expect(stripControlChars("a\x00b\x07c\x08d\x7fe")).toBe("abcde");
  });

  test("leaves ordinary and non-ASCII text alone", () => {
    const text = "Un café à Paris — “élan”, 25° © 2026 🐿";
    expect(stripControlChars(text)).toBe(text);
  });

  test("is a no-op on clean input", () => {
    expect(stripControlChars("nothing to strip")).toBe("nothing to strip");
  });
});

describe("stripControlCharsUnknown", () => {
  test("passes non-strings through untouched", () => {
    expect(stripControlCharsUnknown(42)).toBe(42);
    expect(stripControlCharsUnknown(null)).toBeNull();
    expect(stripControlCharsUnknown(undefined)).toBeUndefined();
  });

  test("strips strings", () => {
    expect(stripControlCharsUnknown(`a${ESC}[2Jb`)).toBe("a[2Jb");
  });
});

describe("stripControlCharsPreservingSgr", () => {
  test("keeps our colour codes", () => {
    const colored = `${ESC}[31mFAIL${ESC}[0m`;
    expect(stripControlCharsPreservingSgr(colored)).toBe(colored);
  });

  test("strips the hijack while keeping colour around it", () => {
    const out = stripControlCharsPreservingSgr(`${ESC}[31mFAIL${ESC}[0m ${HIJACK}forged`);
    expect(out).toBe(`${ESC}[31mFAIL${ESC}[0m [2J[1;1Hforged`);
  });

  test("cursor and screen escapes never survive", () => {
    // The whole security property: colour may pass, movement may not.
    for (const seq of [`${ESC}[2J`, `${ESC}[1;1H`, `${ESC}[A`, `${ESC}]0;title\x07`, `${ESC}]52;c;x\x07`]) {
      const out = stripControlCharsPreservingSgr(`before${seq}after`);
      expect(out).not.toContain(ESC);
    }
  });

  test("SGR carried by page content is allowed but is only colour", () => {
    // Page content recolouring its own text is harmless; that is the trade.
    const out = stripControlCharsPreservingSgr(`page said ${ESC}[32mgreen${ESC}[0m`);
    expect(out).toContain(`${ESC}[32m`);
  });

  test("an ESC not followed by a valid SGR is stripped", () => {
    expect(stripControlCharsPreservingSgr(`a${ESC}b`)).toBe("ab");
    expect(stripControlCharsPreservingSgr(`a${ESC}[999`)).toBe("a[999");
  });

  test("handles adjacent sequences and text after the last one", () => {
    const out = stripControlCharsPreservingSgr(`${ESC}[1m${ESC}[31mx${ESC}[0mtail\x07`);
    expect(out).toBe(`${ESC}[1m${ESC}[31mx${ESC}[0mtail`);
  });

  test("is a no-op on clean input", () => {
    expect(stripControlCharsPreservingSgr("plain text")).toBe("plain text");
  });
});
