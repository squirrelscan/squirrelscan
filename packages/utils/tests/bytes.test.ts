// byteLength (#1275) — publish/body size gates compare against BYTE budgets, so
// they must measure UTF-8 bytes, not UTF-16 `.length` code units.
import { describe, expect, test } from "bun:test";

import { byteLength, truncateToBytes } from "../src/bytes";

describe("byteLength (#1275)", () => {
  test("ASCII: bytes equal .length", () => {
    const s = "hello world";
    expect(byteLength(s)).toBe(s.length);
    expect(byteLength("")).toBe(0);
  });

  test("CJK: 3 bytes per char, so bytes exceed .length", () => {
    const s = "中文字"; // 3 chars, 3 code units, 9 UTF-8 bytes
    expect(s.length).toBe(3);
    expect(byteLength(s)).toBe(9);
  });

  test("emoji (astral): 2 code units but 4 UTF-8 bytes", () => {
    const s = "🐿"; // squirrel — 1 code point, 2 UTF-16 units, 4 UTF-8 bytes
    expect(s.length).toBe(2);
    expect(byteLength(s)).toBe(4);
  });

  test("2-byte accented char: bytes exceed .length", () => {
    const s = "café"; // é = 2 UTF-8 bytes
    expect(s.length).toBe(4);
    expect(byteLength(s)).toBe(5);
  });

  test("matches TextEncoder for mixed well-formed content (reference impl, no allocation)", () => {
    const s = `plain ASCII ${"中".repeat(50)} more ${"🐿".repeat(10)} tail`;
    expect(byteLength(s)).toBe(new TextEncoder().encode(s).length);
  });

  test("wire-exact for JSON bodies — the publish-gate contract — even with emoji/CJK/lone surrogates", () => {
    // A publish gate always measures JSON.stringify(...) output. JSON escapes any
    // unpaired surrogate to ASCII \uXXXX, so the result is well-formed and
    // byteLength equals the exact bytes fetch would send.
    const payload = {
      title: "café 日本語 🐿",
      note: "lone surrogate here: \uD83D and text",
      pages: Array.from({ length: 5 }, (_, i) => `https://x.test/路径/${i}/🐿`),
    };
    const body = JSON.stringify(payload);
    expect(byteLength(body)).toBe(new TextEncoder().encode(body).length);
  });
});

// truncateToBytes (#1293) — crawler content caps compared UTF-16 .length against
// *_MAX_BYTES then sliced by code units, both over-triggering keeps (a CJK body
// stays ~3x over the byte cap) and risking a mid-codepoint split. This truncates
// on a real byte budget at a code-point boundary.
describe("truncateToBytes (#1293)", () => {
  test("ASCII: under cap unchanged, over cap cut to exactly maxBytes", () => {
    expect(truncateToBytes("hello", 100)).toBe("hello");
    expect(truncateToBytes("hello world", 5)).toBe("hello");
    expect(byteLength(truncateToBytes("x".repeat(1000), 400))).toBe(400);
  });

  test("CJK: result stays within the BYTE budget and never splits a code point", () => {
    // "中" = 3 UTF-8 bytes. A 10-byte budget fits 3 chars (9 bytes), not 3.33.
    const out = truncateToBytes("中".repeat(10), 10);
    expect(out).toBe("中中中");
    expect(byteLength(out)).toBe(9);
    expect(byteLength(out)).toBeLessThanOrEqual(10);
    expect(out).not.toContain("�"); // no replacement char from a split
  });

  test("emoji (surrogate pair = 4 bytes): keeps whole pairs, no lone surrogate", () => {
    // "🐿" = 4 UTF-8 bytes, 2 UTF-16 units. 10-byte budget fits 2 (8 bytes).
    const out = truncateToBytes("🐿".repeat(5), 10);
    expect(out).toBe("🐿🐿");
    expect(byteLength(out)).toBe(8);
    expect(out).not.toContain("�");
    // No lone surrogate left dangling at the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  test("cut exactly on a code-point boundary keeps that char; one byte short drops it", () => {
    expect(truncateToBytes("中中", 6)).toBe("中中"); // exactly 6 bytes
    expect(truncateToBytes("中中", 5)).toBe("中"); // 5 < 6 → drop the 2nd whole
    expect(truncateToBytes("中", 2)).toBe(""); // can't fit a 3-byte char in 2
    expect(truncateToBytes("中", 0)).toBe("");
  });

  test("invariants over mixed content: prefix + within budget + no split char", () => {
    const s = `ASCII ${"中".repeat(30)} ${"🐿".repeat(15)} tail`;
    for (const cap of [0, 1, 3, 7, 12, 40, 99, 100000]) {
      const out = truncateToBytes(s, cap);
      expect(s.startsWith(out)).toBe(true); // always a prefix
      expect(byteLength(out)).toBeLessThanOrEqual(cap); // never over the byte budget
      expect(out).not.toContain("�"); // never a partial-sequence artifact
    }
  });

  test("mirrors the crawler bug: old .length slice over-keeps bytes; truncateToBytes is exact", () => {
    const body = "中".repeat(100); // 100 code units, 300 UTF-8 bytes
    // The OLD shape (raw.length > CAP ? raw.slice(0, CAP) : raw) with a 200-byte
    // cap: .length (100) is UNDER 200 → NO truncation → 300 bytes ride over cap.
    expect(body.length).toBeLessThan(200);
    expect(byteLength(body)).toBeGreaterThan(200);
    // The new helper truncates to the true byte budget.
    expect(byteLength(truncateToBytes(body, 200))).toBeLessThanOrEqual(200);
  });
});
