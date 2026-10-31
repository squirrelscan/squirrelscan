import { describe, expect, test } from "bun:test";

import { stripUnsafeLineText } from "../src/control-chars";

describe("stripUnsafeLineText", () => {
  const ESC = String.fromCharCode(27);

  test("removes C0, DEL, C1, bidi overrides and line separators; keeps ordinary text", () => {
    const hostile = `a${ESC}[2Jb\u009b31mc\u202ed\u2066e\u2069f\u2028g\u2029h\u007fi\u061cj\u200ek`;
    expect(stripUnsafeLineText(hostile, "")).toBe("a[2Jb31mcdefghijk");
    expect(stripUnsafeLineText("plain text, with punctuation and \u00e9\u4e2d\u6587")).toBe("plain text, with punctuation and \u00e9\u4e2d\u6587");
  });

  test("a newline, CR or tab becomes a space, so words stay apart and the value is one line", () => {
    expect(stripUnsafeLineText("one\ntwo\r\nthree\tfour")).toBe("one two  three four");
  });

  test("OSC 8 hyperlink and clear-screen sequences lose their ESC, so they are inert text", () => {
    const out = stripUnsafeLineText(`${ESC}]8;;https://evil.example${ESC}\\label${ESC}]8;;${ESC}\\${ESC}[2J${ESC}[1;1H`, "");
    expect(out).not.toContain(ESC);
    expect(out).toBe("]8;;https://evil.example\\label]8;;\\[2J[1;1H");
  });
});
