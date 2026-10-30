// The framework payload analyzer reads pages an audited site controls. Its
// reads are capped (2000 scripts, 500 islands, 160 characters of a script's
// start, 200 per interactive kind, 200,000 nodes of text), and nothing runs a
// pattern over a script body. These tests feed hostile shapes and assert the
// caps hold, with a wall-clock ceiling far above the observed time.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { frameworkDataPayloadRule } from "../src/performance/framework-data-payload";
import {
  documentBody,
  findFrameworkPayloads,
  measureInteractivity,
  visibleTextLength,
} from "../src/shared/framework-payload";
import type { ParsedPage, RuleContext } from "../src/types";

type Doc = NonNullable<ParsedPage["document"]>;
const doc = (html: string) => parseHTML(html).document as unknown as Doc;
const MB = 1024 * 1024;
const CEILING_MS = 5000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

describe("framework payload analyzer on hostile pages", () => {
  test("one 5 MB script of brackets, quotes and escapes is sized, not scanned", () => {
    const body = "[\"\\\\".repeat(Math.floor((5 * MB) / 4));
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${body}</script></body></html>`;
    const { value, ms } = timed(() => findFrameworkPayloads(doc(html)));
    expect(value[0]?.kind).toBe("next-pages");
    expect(value[0]?.bytes).toBe(body.length);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("a marker repeated through a 5 MB inline script is only looked for in its first 160 characters", () => {
    const html = `<html><body><script>${"x".repeat(200)}${"__NUXT__".repeat(MB / 2)}</script></body></html>`;
    expect(findFrameworkPayloads(doc(html))).toEqual([]);
  });

  test("20,000 scripts are read to the cap of 2,000", () => {
    const scripts = Array.from({ length: 20_000 }, () => `<script>self.__next_f.push([1,"a"])</script>`).join("");
    const { value, ms } = timed(() => findFrameworkPayloads(doc(`<html><body>${scripts}</body></html>`)));
    expect(value[0]?.count).toBe(2000);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("5,000 astro islands are read to the cap of 500", () => {
    const islands = Array.from({ length: 5000 }, () => `<astro-island props="{&quot;a&quot;:1}"></astro-island>`).join("");
    const [astro] = findFrameworkPayloads(doc(`<html><body>${islands}</body></html>`));
    expect(astro?.count).toBe(500);
  });

  test("interactive element counts stop at the per-kind cap", () => {
    const html = `<html><body>${"<input type=text>".repeat(5000)}${"<button>b</button>".repeat(5000)}${"<canvas></canvas>".repeat(5000)}</body></html>`;
    const { value, ms } = timed(() => measureInteractivity(doc(html)));
    expect(value).toEqual({ fields: 200, buttons: 200, embedded: 200 });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("text length walks at most 200,000 nodes and survives deep nesting", () => {
    const wide = Array.from({ length: 300_000 }, () => "<i>ab</i>").join("");
    const wideResult = timed(() => visibleTextLength(doc(`<html><body>${wide}</body></html>`)));
    expect(wideResult.value).toBeLessThanOrEqual(2 * 100_000 + 1);
    expect(wideResult.ms).toBeLessThan(CEILING_MS);
    const depth = 3000;
    const deep = `<html><body>${"<div>".repeat(depth)}text${"</div>".repeat(depth)}</body></html>`;
    expect(visibleTextLength(doc(deep))).toBe(4);
  });

  test("the rule on a page with all of it at once stays bounded", () => {
    const scripts = Array.from({ length: 5000 }, () => `<script>self.__next_f.push([1,"${"a".repeat(500)}"])</script>`).join("");
    const html = `<html><body><p>${"word ".repeat(400)}</p>${scripts}</body></html>`;
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: doc(html) } as unknown as ParsedPage,
      options: {},
    } as RuleContext;
    const { value, ms } = timed(() => frameworkDataPayloadRule.run(ctx));
    expect(value instanceof Promise ? [] : value.checks[0]?.status).toBe("info");
    expect(ms).toBeLessThan(CEILING_MS);
  });

  test("documentBody is null for a document with no root", () => {
    expect(documentBody(doc(""))).toBeNull();
  });
});
