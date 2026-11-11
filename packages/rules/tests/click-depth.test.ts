// links/click-depth: indexable pages more than N clicks from the homepage (#1688).

import { describe, expect, test } from "bun:test";

import { clickDepthRule, shortestDepths } from "../src/links/click-depth";
import { rules as linkRules } from "../src/links";
import type { CheckResult, ParsedPage, RuleContext, RuleResult } from "../src/types";
import type { LinkData } from "@squirrelscan/core-contracts";

const BASE = "https://example.com/";

function link(url: string, extra: Partial<LinkData> = {}): LinkData {
  return { url, text: "x", isInternal: true, ...extra };
}

interface Spec {
  url: string;
  links?: string[] | LinkData[];
  status?: number;
  robots?: string;
  headers?: Record<string, string>;
}

function ctx(
  pages: Spec[],
  options: Record<string, unknown> = {},
  site: Record<string, unknown> = {},
): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: pages.map((p) => ({
        url: p.url,
        finalUrl: p.url,
        statusCode: p.status ?? 200,
        headers: p.headers,
        parsed: {
          links: (p.links ?? []).map((l) => (typeof l === "string" ? link(l) : l)),
          meta: { robots: p.robots },
        } as unknown as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
      ...site,
    },
    options: { maxDepth: 3, ...options },
  } as unknown as RuleContext;
}

function run(c: RuleContext): CheckResult {
  return (clickDepthRule.run(c) as RuleResult).checks[0]!;
}

const P = (n: string) => `https://example.com/${n}`;

// home -> a -> b -> c -> d -> e : depths 1..5
const CHAIN: Spec[] = [
  { url: BASE, links: ["/a"] },
  { url: P("a"), links: ["/b"] },
  { url: P("b"), links: ["/c"] },
  { url: P("c"), links: ["/d"] },
  { url: P("d"), links: ["/e"] },
  { url: P("e") },
];

describe("links/click-depth", () => {
  test("lists pages deeper than 3 with depth, deepest first, total and deepest stated", () => {
    const c = run(ctx(CHAIN));
    expect(c.status).toBe("warn");
    expect((c.items ?? []).map((i) => i.id)).toEqual([P("e"), P("d")]);
    expect((c.items ?? []).map((i) => i.meta?.depth)).toEqual([5, 4]);
    expect(c.message).toContain("2 indexable page(s)");
    expect(c.message).toContain("deepest at 5");
    expect(c.details).toMatchObject({ total: 2, deepest: 5, threshold: 3 });
  });

  test("the threshold option changes the listing and is stated", () => {
    const c = run(ctx(CHAIN, { maxDepth: 4 }));
    expect((c.items ?? []).map((i) => i.id)).toEqual([P("e")]);
    expect(c.message).toContain("more than 4 clicks");
    expect(c.details?.threshold).toBe(4);
    expect(run(ctx(CHAIN, { maxDepth: 5 })).status).toBe("pass");
  });

  test("depth is the shortest path, whatever order pages are listed", () => {
    // /deep is linked from the homepage directly and, later, from a long chain.
    const pages: Spec[] = [
      { url: P("c"), links: ["/deep"] },
      { url: P("b"), links: ["/c"] },
      { url: P("deep") },
      { url: P("a"), links: ["/b"] },
      { url: BASE, links: ["/a", "/deep"] },
    ];
    const c = run(ctx(pages, { maxDepth: 1 }));
    expect((c.items ?? []).map((i) => [i.id, i.meta?.depth])).toEqual([
      [P("c"), 3],
      [P("b"), 2],
    ]);
  });

  test("a sitemap-only page with no link path gets no depth", () => {
    const c = run(ctx([...CHAIN, { url: P("sitemap-only") }], { maxDepth: 1 }));
    expect((c.items ?? []).map((i) => i.id)).not.toContain(P("sitemap-only"));
  });

  test("noindex (meta and header), redirect-like and error pages are not listed", () => {
    const pages: Spec[] = [
      { url: BASE, links: ["/a"] },
      { url: P("a"), links: ["/b"] },
      { url: P("b"), links: ["/meta", "/hdr", "/gone", "/ok"] },
      { url: P("meta"), robots: "noindex,follow" },
      { url: P("hdr"), headers: { "x-robots-tag": "noindex" } },
      { url: P("gone"), status: 404 },
      { url: P("ok") },
    ];
    const c = run(ctx(pages, { maxDepth: 2 }));
    expect((c.items ?? []).map((i) => i.id)).toEqual([P("ok")]);
  });

  test("a noindex page still carries links to the pages behind it", () => {
    const pages: Spec[] = [
      { url: BASE, links: ["/hub"] },
      { url: P("hub"), robots: "noindex", links: ["/x"] },
      { url: P("x") },
    ];
    expect(run(ctx(pages, { maxDepth: 1 })).items?.map((i) => i.id)).toEqual([P("x")]);
  });

  test("nofollow, external and unparsable links are not edges", () => {
    const pages: Spec[] = [
      {
        url: BASE,
        links: [
          link("/a", { isNofollow: true }),
          link("https://other.example.org/", { isInternal: false }),
          link("http://[bad"),
        ],
      },
      { url: P("a") },
    ];
    expect(run(ctx(pages, { maxDepth: 1 })).status).toBe("pass");
    expect(shortestDepths([BASE], new Map()).get(P("a"))).toBeUndefined();
  });

  test("a capped crawl says depths are a lower bound", () => {
    const c = run(ctx(CHAIN, {}, { crawlLimits: { pagesCrawled: 6, maxPages: 6 } }));
    expect(c.status).toBe("warn");
    expect(c.message).toContain("lower bound");
    expect(c.details?.lowerBound).toBe(true);
    expect(run(ctx(CHAIN)).details?.lowerBound).toBeUndefined();
  });

  test("a single-page audit is skipped with a reason", () => {
    const c = run(ctx([{ url: BASE }]));
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toBeTruthy();
  });

  test("skips when the homepage was not crawled", () => {
    const c = run(ctx([{ url: P("a") }, { url: P("b") }]));
    expect(c.status).toBe("skipped");
  });

  test("the page the crawl started on is a root", () => {
    const pages: Spec[] = [
      { url: P("en/"), links: ["/a"] },
      { url: P("a"), links: ["/b"] },
      { url: P("b") },
    ];
    const c = run(
      ctx(pages, { maxDepth: 1 }, { baseUrl: "https://example.com/", entryUrls: [P("en/")] }),
    );
    expect(c.items?.map((i) => i.id)).toEqual([P("b")]);
  });

  test("the same input gives the same result", () => {
    const shuffled = [...CHAIN].reverse();
    expect(run(ctx(shuffled))).toEqual(run(ctx(CHAIN)));
    expect(run(ctx(CHAIN))).toEqual(run(ctx(CHAIN)));
  });

  test("a cycle does not loop and a large chain stays fast", () => {
    const pages: Spec[] = [{ url: BASE, links: ["/p0"] }];
    for (let i = 0; i < 2000; i++) pages.push({ url: P(`p${i}`), links: [`/p${i + 1}`, "/"] });
    pages.push({ url: P("p2000") });
    const c = run(ctx(pages));
    expect(c.details?.deepest).toBe(2001);
  }, 20_000);

  test("is registered, site scope, advisory weight", () => {
    const r = linkRules.find((x) => x.meta.id === "links/click-depth");
    expect(r).toBe(clickDepthRule);
    expect(r?.meta.scope).toBe("site");
    expect(r?.meta.weight).toBe(1);
  });
});
