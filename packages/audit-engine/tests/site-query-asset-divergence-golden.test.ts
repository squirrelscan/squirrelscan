// social/asset-divergence dual-path golden (#1371).
//
// The chain under test: parsePage(html) -> extractPageFeatures -> the v21
// page_features site-chrome columns -> createSiteQuery -> the rule's streaming
// branch. The legacy branch re-derives the same assets from the SAME parsed
// pages, so a deep-equal here proves the stored scalars and the live extraction
// agree — the one invariant that could silently rot, since the two live in
// different packages.
//
// The streaming run is given an EMPTY `site.pages`, so passing also proves the
// streaming branch reads nothing off the resident page array.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { parsePage } from "@squirrelscan/parser";
import { extractSiteChromeSignal, loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery, extractPageFeatures } from "../src/index";
import { parseHtmlForRules } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";
const DEFAULT_OG = "https://cdn.example.com/share/default.png";

const assetDivergenceRule = loadAllRules().get("social/asset-divergence")!;

interface Spec {
  normalizedUrl: string;
  favicon: string;
  themeColor: string;
  ogImage: string;
  /** Adds Article JSON-LD, which is what makes `pageType` "article". */
  article?: boolean;
}

function specHtml(spec: Spec): string {
  const schema = spec.article
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "A post",
      })}</script>`
    : "";
  return (
    `<html><head>` +
    `<link rel="icon" href="${spec.favicon}">` +
    `<meta name="theme-color" content="${spec.themeColor}">` +
    `<meta property="og:image" content="${spec.ogImage}">` +
    `${schema}</head><body><p>hi</p></body></html>`
  );
}

function mkPage(spec: Spec): { page: PageRecord; parsed: ParsedPage } {
  const html = specHtml(spec);
  const page = {
    url: spec.normalizedUrl,
    normalizedUrl: spec.normalizedUrl,
    finalUrl: spec.normalizedUrl,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h:${spec.normalizedUrl}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
  } as unknown as PageRecord;

  return { page, parsed: parsePage(html, spec.normalizedUrl) as ParsedPage };
}

function uniform(i: number): Spec {
  return {
    normalizedUrl: `https://example.com/p${String(i).padStart(2, "0")}`,
    favicon: "/favicon.ico",
    themeColor: "#0a5c36",
    ogImage: DEFAULT_OG,
  };
}

// normalized_url ASC (== the getPageFeaturesPage cursor order). 14 pages so the
// 10-page floor is cleared: 10 run the current layout, 2 run a stale one (old
// favicon AND old fallback share image), and 2 are articles with their own share
// image — the case that must NOT be reported.
const FIXTURE: Spec[] = [
  ...Array.from({ length: 10 }, (_, i) => uniform(i + 1)),
  {
    normalizedUrl: "https://example.com/p11",
    favicon: "/old/favicon.ico",
    themeColor: "#0a5c36",
    ogImage: "https://cdn.example.com/share/old-brand.png",
  },
  {
    normalizedUrl: "https://example.com/p12",
    favicon: "/old/favicon.ico",
    themeColor: "#0a5c36",
    ogImage: "https://cdn.example.com/share/old-brand.png",
  },
  {
    normalizedUrl: "https://example.com/p13",
    favicon: "/favicon.ico",
    themeColor: "#0a5c36",
    ogImage: "https://cdn.example.com/share/post-13.png",
    article: true,
  },
  {
    normalizedUrl: "https://example.com/p14",
    favicon: "/favicon.ico",
    themeColor: "#0a5c36",
    ogImage: "https://cdn.example.com/share/post-14.png",
    article: true,
  },
];

async function seedAndRun(rule: Rule) {
  const store = await freshStore();
  const built = FIXTURE.map(mkPage);

  for (const { page, parsed } of built) {
    await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));
  }

  const sitePages = [...built]
    .sort((a, b) => (a.page.normalizedUrl < b.page.normalizedUrl ? -1 : 1))
    .map(({ page, parsed }) => ({
      url: page.normalizedUrl,
      statusCode: page.status,
      parsed,
    }));

  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options: {},
  };

  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: sitePages, robotsTxt: null, sitemaps: null },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    // EMPTY — the streaming path must read only page_features.
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;

  await run(store.close());
  return { legacy, streamed };
}

describe("dual-path golden — social/asset-divergence (extractor → v21 columns → siteQuery)", () => {
  test("streaming path is deep-equal to legacy, with the expected divergence verdict", async () => {
    const { legacy, streamed } = await seedAndRun(assetDivergenceRule);

    expect(streamed).toEqual(legacy);
    expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
    expect(legacy).toHaveLength(1);

    const check = legacy[0]!;
    // 2 of 14 pages run the stale layout → below the fail share, so a warning.
    expect(check.status).toBe("warn");
    expect(check.value).toBe(2);
    expect(check.details).toEqual({
      judgedPages: 14,
      flaggedPages: 2,
      norms: [
        {
          dimension: "favicon",
          norm: "https://example.com/favicon.ico",
          pages: 12,
          agreement: 12 / 14,
        },
        { dimension: "theme-color", norm: "#0a5c36", pages: 14, agreement: 1 },
        // Only the 12 non-article pages vote here; the two articles are exempt.
        { dimension: "og-image", norm: DEFAULT_OG, pages: 10, agreement: 10 / 12 },
      ],
    });

    // One item per diverging axis, both naming the same two pages.
    expect(check.items?.map((i) => [i.meta?.dimension, i.meta?.value, i.sourcePages])).toEqual([
      [
        "favicon",
        "https://example.com/old/favicon.ico",
        ["https://example.com/p11", "https://example.com/p12"],
      ],
      [
        "og-image",
        "https://cdn.example.com/share/old-brand.png",
        ["https://example.com/p11", "https://example.com/p12"],
      ],
    ]);
    // The articles' own share images are never reported.
    const reported = check.items?.flatMap((i) => i.sourcePages ?? []) ?? [];
    expect(reported).not.toContain("https://example.com/p13");
    expect(reported).not.toContain("https://example.com/p14");
  });
});

describe("parseHtmlForRules carries the site-chrome assets", () => {
  // There are TWO parsers producing a ParsedPage: `parsePage` (crawler) and
  // `parseHtmlForRules` (this package — what `parsePageRecord` and the #263
  // page-rule workers actually run). A field read from only one of them is
  // invisible in production while every direct-parser test still passes, so pin
  // that both agree.
  const HTML = specHtml({
    normalizedUrl: BASE,
    favicon: "/favicon.ico",
    themeColor: "#0A5C36",
    ogImage: DEFAULT_OG,
  });

  test("both parse paths yield the same chrome signal", () => {
    const viaAdapter = extractSiteChromeSignal(parseHtmlForRules(HTML, BASE), BASE);
    const viaParser = extractSiteChromeSignal(parsePage(HTML, BASE) as ParsedPage, BASE);

    expect(viaAdapter).toEqual({
      faviconHref: "https://example.com/favicon.ico",
      themeColor: "#0a5c36",
      ogImage: DEFAULT_OG,
    });
    expect(viaAdapter).toEqual(viaParser);
  });
});
