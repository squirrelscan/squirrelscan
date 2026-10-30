// The chunk decoder, the needle search and the sentence extractor read input an
// audited site controls (a script of megabytes, a page of any shape). Each must
// do linear work whatever the input looks like. These tests feed shapes that
// make a naive implementation quadratic (a lookahead to a `;` or `}` that never
// comes, a search per needle, a hash bucket flooded with collisions) and assert
// bounded work from counters where the code exposes them, and from a wall-clock
// ceiling far above the observed time (tens of milliseconds) elsewhere.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { contentInJsBundleRule } from "../src/performance/content-in-js-bundle";
import {
  MAX_CHUNK_CHARS,
  MAX_VERIFICATIONS,
  buildNeedleIndex,
  extractContentSentences,
  findNeedles,
  normalizeScriptText,
} from "../src/shared/content-in-script";
import type { RuleContext } from "../src/types";

const MB = 1024 * 1024;
/** Far above what these take; a quadratic implementation takes minutes. */
const CEILING_MS = 4000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

describe("normalizeScriptText is linear on adversarial input", () => {
  const SHAPES: Array<[string, string]> = [
    ["an & with no closing semicolon, 5 million times", "&".repeat(5 * MB)],
    ["&# runs", "&#".repeat(2.5 * MB)],
    ["\\u{ with no closing brace", "\\u{".repeat(1.6 * MB)],
    ["\\u{ followed by hex that never closes", "\\u{abcdef".repeat(0.55 * MB)],
    ["backslashes", "\\".repeat(5 * MB)],
    ["escape runs", "\\n\\t".repeat(1.2 * MB)],
    ["alternating quotes and escapes", "\\\"\\'".repeat(1.2 * MB)],
    ["brackets", "[".repeat(5 * MB)],
    ["whitespace", " \n\t".repeat(1.6 * MB)],
    ["entities that decode to astral characters", "&#x1F600;".repeat(0.55 * MB)],
  ];

  test.each(SHAPES)("%s", (_name, text) => {
    const input = text.slice(0, MAX_CHUNK_CHARS);
    const { value, ms } = timed(() => normalizeScriptText(input));
    expect(value).not.toBeNull();
    // Never longer than twice the input (a decoded sequence is shorter than its source).
    expect(value!.length).toBeLessThanOrEqual(input.length * 2);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("doubling the input does not quadruple the time", () => {
    const run = (n: number) => {
      const text = "&".repeat(n);
      // Best of three, so one slow run does not decide it.
      return Math.min(...Array.from({ length: 3 }, () => timed(() => normalizeScriptText(text)).ms));
    };
    const small = Math.max(run(1 * MB), 1);
    const large = run(4 * MB);
    // Linear is 4x; quadratic is 16x. 10x leaves room for timer and GC noise.
    expect(large / small).toBeLessThan(10);
  });

  test("input past the cap is refused without being read", () => {
    const { value, ms } = timed(() => normalizeScriptText("a".repeat(MAX_CHUNK_CHARS + 1)));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(500);
  });
});

describe("findNeedles does one pass and bounded verification", () => {
  const needle = (i: number) => `Needle ${i} is a sentence long enough to be indexed by its first window of characters.`;

  test("thousands of needles cost one pass: positions never exceed the haystack", () => {
    const haystack = "function f(e){return e}".repeat(Math.ceil((4 * MB) / 23));
    const index = buildNeedleIndex(Array.from({ length: 25_000 }, (_, i) => needle(i)));
    const { value: search, ms } = timed(() => findNeedles(haystack, index));
    expect(search.positions).toBeLessThanOrEqual(haystack.length);
    expect(search.verifications).toBe(0);
    expect(search.found.size).toBe(0);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("a haystack that is one needle's prefix repeated is capped at the verification limit", () => {
    const prefix = "Needle 1 is a sentence long";
    const haystack = prefix.repeat(Math.ceil((3 * MB) / prefix.length));
    const index = buildNeedleIndex([needle(1)]);
    const search = findNeedles(haystack, index);
    expect(search.verifications).toBeLessThanOrEqual(MAX_VERIFICATIONS);
    expect(search.found.size).toBe(0);
  });

  test("a bucket flooded with needles sharing one prefix is capped too", () => {
    const shared = "Shared opening of twenty-four chars and more, then ";
    const needles = Array.from({ length: 20_000 }, (_, i) => `${shared}${i} and the rest of the sentence continues here.`);
    const haystack = shared.repeat(100_000);
    const search = findNeedles(haystack, buildNeedleIndex(needles));
    expect(search.verifications).toBeLessThanOrEqual(MAX_VERIFICATIONS);
    expect(search.truncated).toBe(true);
  });

  test("finds needles at the start, middle and end, and stops once all are found", () => {
    const needles = [needle(1), needle(2), needle(3)];
    const haystack = `${needles[0]} ${"x".repeat(5000)} ${needles[1]} ${"y".repeat(5000)} ${needles[2]}`;
    const search = findNeedles(haystack, buildNeedleIndex(needles));
    expect([...search.found].sort()).toEqual([...needles].sort());
    expect(search.positions).toBeLessThan(haystack.length);
  });

  test("a deadline in the past stops the pass at the first check", () => {
    const haystack = "z".repeat(2 * MB);
    const search = findNeedles(haystack, buildNeedleIndex([needle(1)]), performance.now() - 1);
    expect(search.truncated).toBe(true);
    expect(search.positions).toBeLessThan(70_000);
  });
});

describe("extractContentSentences is bounded on adversarial pages", () => {
  const doc = (html: string) => parsePage(html, "https://example.com/").document!;

  test("one 5 MB text node is read to a few kilobytes", () => {
    const sentence = "word ".repeat(1_000_000);
    const { value, ms } = timed(() => extractContentSentences(doc(`<main><p>${sentence}</p></main>`)));
    expect(value.length).toBeLessThanOrEqual(1);
    expect(value[0]?.length ?? 0).toBeLessThanOrEqual(200);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("200,000 sibling text nodes are visited at most to the node cap", () => {
    const items = Array.from({ length: 200_000 }, () => "<i>a</i>").join("");
    const { ms } = timed(() => extractContentSentences(doc(`<main>${items}</main>`)));
    expect(ms).toBeLessThan(CEILING_MS * 2);
  });

  test("deeply nested markup does not overflow the stack", () => {
    const depth = 3000;
    const html = `<main>${"<div>".repeat(depth)}<p>${"word ".repeat(20)}</p>${"</div>".repeat(depth)}</main>`;
    const { value, ms } = timed(() => extractContentSentences(doc(html)));
    expect(Array.isArray(value)).toBe(true);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("tens of thousands of long distinct paragraphs keep at most five sentences of 200 characters", () => {
    const paragraphs = Array.from({ length: 20_000 }, (_, i) => `<p>${`paragraph${i} `.repeat(15)}</p>`).join("");
    const { value } = timed(() => extractContentSentences(doc(`<main>${paragraphs}</main>`)));
    expect(value.length).toBeLessThanOrEqual(5);
    for (const sentence of value) expect(sentence.length).toBeLessThanOrEqual(200);
  });
});

describe("the rule does bounded work on a site of many large chunks", () => {
  const BASE = "https://example.com";
  const page = (i: number) =>
    `<html><body><main>${Array.from({ length: 5 }, (_, j) => `<p>Page ${i} paragraph ${j} explains how the quarterly alpha${i}x${j} pipeline retries failed deliveries with backoff.</p>`).join("")}</main></body></html>`;

  test("200 chunks of 100 KB: only the largest ten are searched, in bounded time", async () => {
    const pages = Array.from({ length: 50 }, (_, i) => page(i));
    const chunks = Array.from({ length: 200 }, (_, i) => ({
      url: `${BASE}/c${i}.js`,
      status: 200,
      error: null,
      contentType: "application/javascript",
      sizeBytes: 100 * 1024 + i,
      content: "var z=1;".repeat(12_800),
      sourcePages: pages.map((_, k) => `${BASE}/p${k}`),
    }));
    const ctx = {
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      options: {},
      parsed: parsePage(pages[0]!, `${BASE}/p0`),
      site: {
        baseUrl: BASE,
        pages: pages.map((html, i) => ({ url: `${BASE}/p${i}`, statusCode: 200, parsed: parsePage(html, `${BASE}/p${i}`), sizeBytes: 1000 })),
        robotsTxt: null,
        sitemaps: null,
        scripts: chunks,
      },
    } as unknown as RuleContext;
    const started = performance.now();
    const result = await contentInJsBundleRule.run(ctx);
    expect(performance.now() - started).toBeLessThan(CEILING_MS);
    expect(result.checks[0]!.status).toBe("pass");
  });
});
