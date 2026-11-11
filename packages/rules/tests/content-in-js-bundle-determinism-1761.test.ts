// perf/content-in-js-bundle (#1761): the same site gives the same verdict and
// the same page count whatever order the crawl hands pages, scripts and loaders over.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { contentInJsBundleRule } from "../src/performance/content-in-js-bundle";
import type { RuleContext } from "../src/types";

const BASE = "https://example.com";
const url = (i: number) => `${BASE}/p${i}`;
const sentencesOf = (i: number) =>
  Array.from(
    { length: 5 },
    (_, j) => `Page ${i} paragraph ${j} explains how the quarterly alpha${i}x${j} pipeline retries failed deliveries with exponential backoff.`,
  );
const html = (i: number) =>
  `<html><body><main>${sentencesOf(i).map((s) => `<p>${s}</p>`).join("")}</main></body></html>`;
const chunkOf = (pageIds: number[]) => {
  const body = pageIds.flatMap(sentencesOf).map((s) => `r.jsx("p",{children:${JSON.stringify(s)}})`).join(",");
  const filler = "function f(e,t){return e.map(function(n){return n+t})}var q=window.__x;";
  return `var a=[${body}];` + filler.repeat(Math.ceil((60 * 1024) / filler.length));
};

interface Layout {
  /** Order the pages arrive in. */
  pageOrder: number[];
  scripts: Array<{ url: string; ids: number[]; loaders: number[] }>;
  engine: "resident" | "streaming";
  options?: Record<string, unknown>;
}

function ctxOf(l: Layout): RuleContext {
  const parsed = new Map(l.pageOrder.map((i) => [i, parsePage(html(i), url(i))]));
  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    options: l.options ?? {},
    site: {
      baseUrl: BASE,
      pages:
        l.engine === "resident"
          ? l.pageOrder.map((i) => ({ url: url(i), statusCode: 200, parsed: parsed.get(i), sizeBytes: 1000, rendered: false }))
          : [],
      robotsTxt: null,
      sitemaps: null,
      scripts: l.scripts.map((s) => {
        const content = chunkOf(s.ids);
        return { url: s.url, status: 200, error: null, contentType: "application/javascript", sizeBytes: content.length, content, sourcePages: s.loaders.map(url) };
      }),
    },
  } as unknown as RuleContext;
  if (l.engine === "resident") return base;
  return {
    ...base,
    collectedSignals: {
      pages: l.pageOrder.map((i) => buildCollectedPageSignal({ url: url(i), parsed: parsed.get(i)!, htmlBytes: 1000, rendered: false })),
    },
  };
}

const run = async (l: Layout) => (await contentInJsBundleRule.run(ctxOf(l))).checks;
const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
const reversed = <T,>(a: T[]) => [...a].reverse();
const shuffled = (a: number[]) => [...a].sort((x, y) => ((x * 7919) % 13) - ((y * 7919) % 13));

describe.each(["resident", "streaming"] as const)("content-in-js-bundle determinism (%s)", (engine) => {
  const scripts = (n: number) => [{ url: `${BASE}/a.js`, ids: ids(n), loaders: ids(n) }];

  test("pages in a different arrival order: same status, count and message", async () => {
    const n = 6;
    const a = await run({ engine, pageOrder: ids(n), scripts: scripts(n) });
    for (const order of [reversed(ids(n)), shuffled(ids(n))]) {
      const b = await run({ engine, pageOrder: order, scripts: [{ ...scripts(n)[0]!, loaders: order }] });
      expect(b).toEqual(a);
    }
    expect(a[0]!.name).toBe("content-in-js-bundle-sitewide");
    expect(a[0]!.status).toBe("warn");
    expect(a[0]!.message).toContain("content of 6 pages");
  });

  test("a sampled search says 'at least' and gives the same answer in every order", async () => {
    const n = 12;
    const options = { max_pages_checked: 5 };
    const a = await run({ engine, pageOrder: ids(n), scripts: scripts(n), options });
    for (const order of [reversed(ids(n)), shuffled(ids(n))]) {
      expect(await run({ engine, pageOrder: order, scripts: [{ ...scripts(n)[0]!, loaders: order }], options })).toEqual(a);
    }
    expect(a[0]!.status).toBe("warn");
    expect(a[0]!.message).toContain("at least 5 pages (12 checked)");
  });

  test("two chunks of the same size are reported in URL order whatever order they arrive in", async () => {
    const mk = (u: string) => ({ url: `${BASE}/${u}.js`, ids: ids(5), loaders: ids(5) });
    const a = await run({ engine, pageOrder: ids(5), scripts: [mk("b"), mk("a")] });
    const b = await run({ engine, pageOrder: ids(5), scripts: [mk("a"), mk("b")] });
    expect(b).toEqual(a);
    expect(a[0]!.message).toContain(`${BASE}/a.js`);
  });

  test("near the threshold the count is stated on both sides of it", async () => {
    const below = await run({ engine, pageOrder: ids(5), scripts: [{ url: `${BASE}/a.js`, ids: [0, 1], loaders: ids(5) }] });
    const at = await run({ engine, pageOrder: ids(5), scripts: [{ url: `${BASE}/a.js`, ids: [0, 1, 2], loaders: ids(5) }] });
    expect(below[0]!.status).toBe("info");
    expect(below[0]!.message).toContain("2 pages");
    expect(at[0]!.name).toBe("content-in-js-bundle-sitewide");
    expect(at[0]!.message).toContain("3 pages");
  });

  test("loader order does not change the sourcePages reported", async () => {
    const a = await run({ engine, pageOrder: ids(4), scripts: [{ url: `${BASE}/a.js`, ids: ids(4), loaders: ids(4) }] });
    const b = await run({ engine, pageOrder: ids(4), scripts: [{ url: `${BASE}/a.js`, ids: ids(4), loaders: reversed(ids(4)) }] });
    expect(b).toEqual(a);
  });
});
