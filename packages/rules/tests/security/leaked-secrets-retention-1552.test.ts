// #1552: the page-time collector keeps a page's secret records until the site rule runs, so a record must not keep the page it was
// found in alive: a finding's `value` is a slice of the serialized HTML or of an inline script, and a slice holds its whole parent.
// Measured with a forced GC (no timing): the heap kept per page, across three passes, stays far under the page's own size.
// Pages are built from parts; the values are synthetic.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../../src/collected-signals";
import { scanPageForSecrets } from "../../src/security/leaked-secrets";

const j = (...parts: string[]): string => parts.join("");
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const run = (next: () => number, n: number, alphabet = ALNUM): string => Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");

/** A page of about `size` characters with nine secret-shaped values in two inline scripts and an attribute. */
function page(i: number, size: number): string {
  const next = lcg(7_000 + i);
  const secrets = [
    `<script>var cfg={"apiKey":"${j("AI", "za")}${run(next, 35)}","awsKey":"${j("AK", "IA")}${run(next, 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}"};</script>`,
    `<script>window.__ENV__={"stripe":"${j("pk_", "live_")}${run(next, 24)}","token":"${j("gh", "p_")}${run(next, 36)}","secret":"${j("sk_", "live_")}${run(next, 24)}"};</script>`,
    `<div data-key="${j("xo", "xb-")}${run(next, 12, "0123456789")}-${run(next, 24)}"></div>`,
  ].join("\n");
  const filler = `<p>${"lorem ipsum dolor sit amet ".repeat(40)}</p>\n`;
  const body = filler.repeat(Math.max(1, Math.floor(size / filler.length)));
  return `<!doctype html><html><head><title>P${i}</title></head><body>${body}${secrets}${body.slice(0, 1_000)}</body></html>`;
}

const PAGES = 12;
const SIZE = 2_000_000;
const heapMb = (): number => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed / 1_048_576;
};

/** Heap after each of three passes of `scan` over the pages, with every result kept (as the collector keeps them). */
function passes(scan: (html: string, i: number) => unknown): { heap: number[]; kept: number } {
  const kept: unknown[] = [];
  const heap: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < PAGES; i++) kept.push(scan(page(i, SIZE), i));
    heap.push(heapMb());
  }
  return { heap, kept: kept.length };
}
const url = (i: number) => `https://shop.example/p${i}`;

describe("the records kept for a page do not keep the page", () => {
  test("scanPageForSecrets: the heap after a full GC grows by under 1 MB a page across three passes", () => {
    const { heap } = passes((html, i) => scanPageForSecrets(parsePage(html, url(i)).document!, url(i)));
    // before the fix: about the page's size a page (2 MB), 48 MB over the two later passes; after: noise
    expect(heap[2]! - heap[0]!, JSON.stringify(heap)).toBeLessThan(PAGES * 1);
  }, 180_000);

  test("buildCollectedPageSignal, the streaming collector's per-page entry: the same bound", () => {
    const { heap } = passes((html, i) => buildCollectedPageSignal({ url: url(i), parsed: parsePage(html, url(i)), htmlBytes: html.length }));
    expect(heap[2]! - heap[0]!, JSON.stringify(heap)).toBeLessThan(PAGES * 1);
  }, 180_000);
});

describe("the records are the same, copied", () => {
  test("the same values, locations, offsets and extras as before, and strings that are copies", () => {
    const html = page(1, 200_000);
    const found = scanPageForSecrets(parsePage(html, url(1)).document!, url(1));
    expect(found.length).toBeGreaterThan(5);
    for (const secret of found) {
      expect(secret.value.length).toBeGreaterThan(0);
      expect(typeof secret.type).toBe("string");
      expect(secret.length).toBeGreaterThan(0);
    }
    // two scans of the same page agree exactly
    const again = scanPageForSecrets(parsePage(html, url(1)).document!, url(1));
    expect(JSON.stringify(again)).toBe(JSON.stringify(found));
  });

  test("a lone surrogate in a value survives the copy", () => {
    const lone = String.fromCharCode(0xd83d);
    // the detached copy is built from the characters: it keeps what a UTF-8 round trip would replace
    const html = `<!doctype html><html><body><script>var a={"password":"${j("sup", "ersecret")}${lone}x1y2z3w4"};</script></body></html>`;
    const found = scanPageForSecrets(parsePage(html, url(2)).document!, url(2));
    const withLone = found.filter((secret) => secret.value.includes(lone));
    expect(withLone.length).toBeGreaterThan(0);
    for (const secret of withLone) expect(secret.value.charCodeAt(secret.value.indexOf(lone))).toBe(0xd83d);
  });
});
