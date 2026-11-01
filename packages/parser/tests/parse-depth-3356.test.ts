// squirrelscan/repo#3356: parsePage was quadratic in nesting depth. Both link
// extractors asked every anchor for its sitewide-chrome flag (and
// extractors/links.ts for its position) by walking its ancestors to the root,
// so a page of 20,000 nested links took 34 s to parse. The walks are now
// memoized per document. These pin (1) that every anchor gets the answer the
// single walks gave, on seeded random pages of landmarks, roles, classes and
// ids, and (2) that the deeply nested shapes cost linear time (a growth ratio, not a wall-clock budget).

import { describe, expect, test } from "bun:test";

import { createSiteChromeTest, isInSiteChrome } from "../src/extractors/chrome";
import { createLinkPositionTest, extractLinks } from "../src/extractors/links";
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

/**
 * Growth of `run` from `small` to 4 times that depth, as a ratio of best-of-3 times. Linear work gives about 4;
 * the walk per link this guards against gives about 16. A ratio does not move with the load a busy runner is
 * under, where an absolute `under 1 s` did (#1483): the same machine slows both runs alike.
 */
function growth(run: (depth: number) => number, small = 5_000): number {
  // The least of three measurements: a stall makes a ratio too big, never too small, while the walk per link
  // is quadratic every time.
  let least = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && least >= MAX_GROWTH; attempt++) {
    least = Math.min(least, run(small * 4) / Math.max(run(small), 1));
  }
  return least;
}
/** Slack over linear: a 4x depth may cost up to this many times as much (linear is about 4, quadratic about 16). */
const MAX_GROWTH = 10;

describe("nesting costs a walk, not a walk per link (#3356)", () => {
  for (const [shape, open, close] of [
    ["role=text spans", '<span role="text"><a href="/x">x</a>', "</span>"],
    ["aria-hidden divs", '<div aria-hidden="true"><a href="/x">x</a>', "</div>"],
    ["blockquotes", '<blockquote><a href="/x">l</a>', "</blockquote>"],
  ] as const) {
    test(`20,000 nested ${shape} cost linear time (4x the depth, under ${MAX_GROWTH}x the time)`, { timeout: 60_000 }, () => {
      expect(growth((depth) => parseMs(nested(depth, open, close)))).toBeLessThan(MAX_GROWTH);
    });
  }

  test("extractLinks on nested links costs linear time and finds every link", { timeout: 60_000 }, () => {
    const extractMs = (depth: number): number => {
      const { document } = parseHTML(nested(depth, '<div class="x"><a href="/x">x</a>', "</div>"));
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const found = extractLinks(document as never, URL);
        best = Math.min(best, performance.now() - start);
        expect(found).toHaveLength(depth);
      }
      return best;
    };
    expect(growth(extractMs)).toBeLessThan(MAX_GROWTH);
  });
});

describe("the memo holds no page alive (#2343)", () => {
  /**
   * A page parsed, walked by every memo, and then let go: only a WeakRef is left.
   * The anchors are found by walking `children`, not `querySelectorAll`, whose
   * selector engine keeps the last document it searched alive on its own.
   */
  function walkAndDrop(memos: ReadonlyArray<(element: Element) => unknown>): WeakRef<object> {
    const { document } = parseHTML(
      `<html><body><nav><div><a href="/a">a</a></div></nav><main><p><a href="/b">b</a></p></main></body></html>`,
    );
    const stack: Element[] = [document.documentElement as unknown as Element];
    while (stack.length > 0) {
      const element = stack.pop()!;
      if (element.tagName === "A") for (const memo of memos) memo(element);
      stack.push(...Array.from(element.children));
    }
    return new WeakRef(document);
  }

  /** Deepens the stack with dead locals, so a stale slot a finished parse left behind is overwritten before a collection. */
  function scrubStack(depth: number): number {
    const filler = [depth, depth + 1, depth + 2, depth + 3];
    return depth === 0 ? filler[0]! : scrubStack(depth - 1) + filler[3]!;
  }

  /**
   * Collects until every page is gone or the bound is spent: whether the collector has run, and whether JSC's
   * conservative stack scan still sees a stale slot, depends on timing (#1483), so one forced collection is not
   * evidence. Bounded: 100 rounds of a scrubbed stack, a full collection and a short sleep (about a second at most).
   */
  async function settle(pages: ReadonlyArray<WeakRef<object>>): Promise<void> {
    for (let i = 0; i < 100 && pages.some((page) => page.deref()); i++) {
      scrubStack(400);
      Bun.gc(true);
      await Bun.sleep(i < 10 ? 0 : 10);
    }
  }

  test("a memo that outlives its page keeps none of the page's DOM", async () => {
    // A stale stack slot can keep a finished parse's memo reachable (JSC scans
    // the stack conservatively); it must not keep the page with it.
    const memos = [createSiteChromeTest(), createLinkPositionTest()];
    // Three pages through the same memos. Only the earlier two are asserted: a
    // stale slot from the latest call can pin its page for a while in any test
    // (the same scan this guards against), while a memo holding its keys
    // strongly keeps every page it has seen.
    const pages = [walkAndDrop(memos), walkAndDrop(memos), walkAndDrop(memos)];
    await settle([pages[0]!, pages[1]!]);
    expect(pages[0]!.deref()).toBeUndefined();
    expect(pages[1]!.deref()).toBeUndefined();
    // The memos are still alive here.
    expect(memos).toHaveLength(2);
  });

  test("control: a memo that holds its pages strongly keeps them, however long the poll runs", async () => {
    // The mutation the test above guards against. If this ever stopped holding, the poll would be proving nothing.
    const held: object[] = [];
    const leaking = (element: Element): unknown => {
      held.push(element.ownerDocument as unknown as object);
      return undefined;
    };
    const pages = [walkAndDrop([leaking]), walkAndDrop([leaking])];
    await settle(pages);
    expect(pages[0]!.deref()).toBeDefined();
    expect(pages[1]!.deref()).toBeDefined();
    expect(held.length).toBeGreaterThan(0);
  }, 15_000);
});
