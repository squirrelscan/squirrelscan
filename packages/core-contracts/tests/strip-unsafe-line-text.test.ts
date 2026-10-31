import { describe, expect, test } from "bun:test";

import { escapeJsonUnsafe, stripUnsafeLineText } from "../src/control-chars";

describe("stripUnsafeLineText", () => {
  const ESC = String.fromCharCode(27);

  test("removes C0, DEL, C1, bidi overrides and line separators; keeps ordinary text", () => {
    const hostile = `a${ESC}[2Jb\u009b31mc\u202ed\u2066e\u2069f\u2028g\u2029h\u007fi\u061cj\u200ek`;
    expect(stripUnsafeLineText(hostile, "")).toBe("a[2Jb31mcdefghijk");
    expect(stripUnsafeLineText("plain text, with punctuation and \u00e9\u4e2d\u6587")).toBe(
      "plain text, with punctuation and \u00e9\u4e2d\u6587",
    );
  });

  test("a newline, CR or tab becomes a space, so words stay apart and the value is one line", () => {
    expect(stripUnsafeLineText("one\ntwo\r\nthree\tfour")).toBe("one two  three four");
  });

  test("OSC 8 hyperlink and clear-screen sequences lose their ESC, so they are inert text", () => {
    const out = stripUnsafeLineText(
      `${ESC}]8;;https://evil.example${ESC}\\label${ESC}]8;;${ESC}\\${ESC}[2J${ESC}[1;1H`,
      "",
    );
    expect(out).not.toContain(ESC);
    expect(out).toBe("]8;;https://evil.example\\label]8;;\\[2J[1;1H");
  });

  test("removes invisible characters without splitting the word, and keeps joiners that scripts need", () => {
    const tag = String.fromCodePoint(0xe0041, 0xe0042);
    expect(stripUnsafeLineText(`a\u200bb\u2060c\ufeffd\u00ade${tag}f\u180eg`)).toBe("abcdefg");
    expect(stripUnsafeLineText("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    );
  });
});

// An adversarial pass over the whole code point space, with the classification written out here, not
// derived from the implementation: no character that acts on a terminal, reorders text or hides it may
// survive, however the input is split or nested.
describe("stripUnsafeLineText leaves nothing that acts on a terminal or hides text", () => {
  const inRanges = (c: number, ranges: Array<[number, number]>) =>
    ranges.some(([lo, hi]) => c >= lo && c <= hi);
  /** Must never survive: C0, DEL, C1, line separators, bidi controls, and the invisible characters. */
  const BANNED: Array<[number, number]> = [
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0xad, 0xad],
    [0x34f, 0x34f],
    [0x61c, 0x61c],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200b],
    [0x200e, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x206f],
    [0x3164, 0x3164],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff9, 0xfffb],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe007f],
    [0xe0100, 0xe01ef],
  ];
  /** Left alone on purpose: the joiners scripts need and the basic variation selectors emoji need. */
  const KEPT = [0x200c, 0x200d, 0xfe00, 0xfe0f];

  test("every code point: banned ones are gone, kept ones and ordinary text survive", () => {
    const survivors: string[] = [];
    const lost: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const out = stripUnsafeLineText(`a${ch}b`, "");
      const banned = inRanges(cp, BANNED);
      if (banned && out !== "ab") survivors.push(cp.toString(16));
      if (!banned && out !== `a${ch}b`) lost.push(cp.toString(16));
    }
    expect(survivors).toEqual([]);
    expect(lost).toEqual([]);
    for (const cp of KEPT)
      expect(stripUnsafeLineText(`a${String.fromCodePoint(cp)}b`)).toContain(
        String.fromCodePoint(cp),
      );
  });

  test("the replacement form leaves no banned character either", () => {
    for (let cp = 0; cp <= 0x9f; cp++)
      expect(stripUnsafeLineText(String.fromCodePoint(cp), "?")).toMatch(
        /^[?]?$|^[\u0020-\u007e]$/,
      );
  });

  test("nested, split and interleaved escapes cannot leave an ESC or a C1 control", () => {
    const ESC = String.fromCharCode(27);
    const inputs = [
      `${ESC}${ESC}[2J`,
      `${ESC}\u200b[2J`,
      `${ESC}\ufeff]8;;x${String.fromCharCode(7)}`,
      `${ESC}${String.fromCodePoint(0xe005b)}[1;1H`,
      `\u009b\u009b2J`,
      `${ESC}\u202e[31m\u2066`,
      `${ESC}[${ESC}[2J${ESC}\\`,
      `${ESC}P1$r${ESC}\\`,
      "\u0090q\u009c\u009d0;title\u009c\u009e\u009f",
    ];
    for (const input of inputs) {
      const once = stripUnsafeLineText(input, "");
      expect([...once].some((ch) => inRanges(ch.codePointAt(0)!, BANNED))).toBe(false);
      // Idempotent: a second pass finds nothing the first one made.
      expect(stripUnsafeLineText(once, "")).toBe(once);
      expect(stripUnsafeLineText(input)).not.toContain(ESC);
    }
  });
});

describe("escapeJsonUnsafe", () => {
  test("every banned character, and the joiners, come out as ASCII escapes and parse back to the same value", () => {
    const ranges: Array<[number, number]> = [
      [0x7f, 0x9f],
      [0xad, 0xad],
      [0x34f, 0x34f],
      [0x61c, 0x61c],
      [0x115f, 0x1160],
      [0x17b4, 0x17b5],
      [0x180b, 0x180f],
      [0x200b, 0x200f],
      [0x2028, 0x202e],
      [0x2060, 0x2064],
      [0x2066, 0x206f],
      [0x3164, 0x3164],
      [0xfeff, 0xfeff],
      [0xffa0, 0xffa0],
      [0xfff9, 0xfffb],
      [0x1d173, 0x1d17a],
      [0xe0000, 0xe007f],
      [0xe0100, 0xe01ef],
    ];
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        const value = `x${String.fromCodePoint(cp)}y`;
        const out = escapeJsonUnsafe(JSON.stringify({ v: value }));
        expect(out).toMatch(/^[\u0020-\u007e]*$/);
        expect((JSON.parse(out) as { v: string }).v).toBe(value);
      }
    }
  });

  test("ordinary text, emoji and CJK are left as they are", () => {
    const text = JSON.stringify({ v: "caf\u00e9 \u4e2d\u6587 \u{1f600} \u2764\ufe0f ok" });
    expect(escapeJsonUnsafe(text)).toContain("\u00e9");
    expect(escapeJsonUnsafe(text)).toContain("\u{1f600}");
    expect(escapeJsonUnsafe(text)).toContain("\ufe0f");
  });
});
