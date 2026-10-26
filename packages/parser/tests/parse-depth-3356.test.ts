// squirrelscan/repo#3356: parsePage was quadratic in nesting depth. Both link
// extractors asked every anchor for its sitewide-chrome flag (and
// extractors/links.ts for its position) by walking its ancestors to the root,
// so a page of 20,000 nested links took 34 s to parse. The walks are now
// memoized per document. These pin (1) that every anchor gets the answer the
// single walks gave, on seeded random pages of landmarks, roles, classes and
// ids, and (2) a time budget on the deeply nested shapes.

import { describe, expect, test } from "bun:test";

import { isInSiteChrome } from "../src/extractors/chrome";
import { extractLinks } from "../src/extractors/links";
import { parseHTML } from "../src/dom";
import { parsePage } from "../src/html";
import { referenceDetectLinkPosition } from "./fixtures/reference-3356/link-position";

const URL = "https://example.com/";

/** mulberry32: a small seeded PRNG, so every failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;

const CONTAINERS = [
  "div",
  "div",
  "span",
  "section",
  "p",
  "nav",
  "header",
  "footer",
  "aside",
  "main",
  "article",
  'div role="navigation"',
  'div role="banner"',
  'div role="contentinfo"',
  'div role="complementary"',
  'div role="main"',
  'div class="site-header"',
  'div class="Footer colophon"',
  'div class="menu"',
  'div class="post-body"',
  'div id="sidebar-left"',
  'div id="main-content"',
  'div class="plain"',
  'svg class="nav-icon"',
];

let links = 0;
/** A random tree of containers with links at every level. */
function tree(r: () => number, depth: number): string {
  const link = `<a href="/p${links++}">l</a>`;
  if (depth === 0 || r() < 0.2) return link;
  const tag = pick(r, CONTAINERS);
  const name = tag.split(" ")[0]!;
  const kids = Array.from({ length: 1 + Math.floor(r() * 3) }, () => tree(r, depth - 1));
  return `${r() < 0.5 ? link : ""}<${tag}>${kids.join("")}</${name}>`;
}

function randomPage(seed: number): string {
  const r = rng(seed);
  return `<!doctype html><html><body>${tree(r, 7)}${tree(r, 4)}</body></html>`;
}

describe("every anchor gets the answer the single walks gave (#3356)", () => {
  test("chrome flag and position on 600 seeded random pages, both extractors", { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= 600; seed++) {
      const html = randomPage(seed);
      const { document } = parseHTML(html);
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const expected = anchors.map((a) => ({
        isChrome: isInSiteChrome(a as never),
        position: referenceDetectLinkPosition(a as never),
      }));

      const extracted = extractLinks(document as never, URL);
      expect(
        extracted.map(({ isChrome, position }) => ({ isChrome, position })),
        `seed ${seed}`,
      ).toEqual(expected);

      const parsed = parsePage(html, URL).links;
      expect(
        parsed.map((l) => l.isChrome),
        `seed ${seed}`,
      ).toEqual(expected.map((e) => e.isChrome));
    }
  });
});

/** parsePage's whole run on `html`, in ms: the best of 3, so a busy runner's stall is not the parser's. */
function parseMs(html: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    parsePage(html, URL);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const nested = (depth: number, open: string, close: string) =>
  `<!doctype html><html lang="en"><body><main>${open.repeat(depth)}${close.repeat(depth)}</main></body></html>`;

describe("nesting costs a walk, not a walk per link (#3356)", () => {
  for (const [shape, open, close] of [
    ["role=text spans", '<span role="text"><a href="/x">x</a>', "</span>"],
    ["aria-hidden divs", '<div aria-hidden="true"><a href="/x">x</a>', "</div>"],
    ["blockquotes", '<blockquote><a href="/x">l</a>', "</blockquote>"],
  ] as const) {
    test(`20,000 nested ${shape} parse in under 1 s`, { timeout: 60_000 }, () => {
      expect(parseMs(nested(20_000, open, close))).toBeLessThan(1_000);
    });
  }

  test("extractLinks takes 20,000 nested links in under 1 s", { timeout: 60_000 }, () => {
    const { document } = parseHTML(nested(20_000, '<div class="x"><a href="/x">x</a>', "</div>"));
    const start = performance.now();
    const found = extractLinks(document as never, URL);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(found).toHaveLength(20_000);
  });
});
