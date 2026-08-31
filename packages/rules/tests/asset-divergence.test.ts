// social/asset-divergence — site-chrome assets vs the site's own norm (#1371).
//
// The rule's whole value is what it does NOT say, so most of this file defends the
// silence cases: a small crawl, too few pages declaring an asset, a site that
// legitimately varies one, and — the case the issue calls out by name — articles
// and products shipping their own OG image over a uniform default. The positive
// cases pin the three axes it is for.
//
// Both paths run over every fixture: the legacy path re-derives the assets from a
// real parsed DOM, the streaming path reads the stored page_features scalars, and
// the two must be byte-identical.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import {
  assetDivergenceRule,
  extractSiteChromeSignal,
  ASSET_NORM_FAIL_SHARE,
  ASSET_NORM_MIN_AGREEMENT,
  ASSET_NORM_MIN_PAGES,
  ASSET_NORM_MIN_SAMPLE,
} from "../src/social/asset-divergence";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  path: string;
  favicon?: string | null;
  themeColor?: string | null;
  ogImage?: string | null;
  pageType?: string | null;
  status?: number;
  /** Raw head markup, when a fixture needs more than the three simple fields. */
  head?: string;
}

function url(path: string): string {
  return `https://example.com${path}`;
}

function pad(i: number): string {
  return String(i).padStart(3, "0");
}

/** The head a spec describes, unless it brought its own markup. */
function headHtml(spec: PageSpec): string {
  if (spec.head !== undefined) return spec.head;
  const parts: string[] = [];
  if (spec.favicon != null) parts.push(`<link rel="icon" href="${spec.favicon}">`);
  if (spec.themeColor != null) parts.push(`<meta name="theme-color" content="${spec.themeColor}">`);
  return parts.join("");
}

/** A parsed page with a LIVE document, the way the legacy site pass sees one. */
function parsedFor(spec: PageSpec): ParsedPage {
  const { document } = parseHTML(`<html><head>${headHtml(spec)}</head><body></body></html>`);
  return {
    document,
    og: { image: spec.ogImage ?? null },
    pageType: spec.pageType ?? "unknown",
  } as unknown as ParsedPage;
}

const baseCtx = {
  page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as ParsedPage,
  options: {},
};

/** Legacy path: specs become `ctx.site.pages` in crawl order. */
function legacyCtx(specs: PageSpec[]): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: "https://example.com/",
      pages: specs.map((spec) => ({
        url: url(spec.path),
        statusCode: spec.status ?? 200,
        parsed: parsedFor(spec),
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

/**
 * Streaming path: the stored row, populated by the SAME extractor
 * `extractPageFeatures` calls — so a divergence between the two paths can only
 * come from the rule, never from the fixture doing its own extraction.
 */
function featureRow(spec: PageSpec): PageFeatureRow {
  const chrome = extractSiteChromeSignal(parsedFor(spec), url(spec.path));
  return {
    normalizedUrl: url(spec.path),
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: spec.pageType ?? "unknown",
    schemaTypes: [],
    robotsNoindex: false,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: [],
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
    faviconHref: chrome.faviconHref,
    themeColor: chrome.themeColor,
    ogImage: chrome.ogImage,
  };
}

/**
 * The rule only ever calls `pagesMatching` + `pageCount`, so the rest of the
 * SiteQuery surface throws — a stub that silently returned empties could hide the
 * rule reading something it must not.
 */
function siteQueryCtx(specs: PageSpec[]): RuleContext {
  const rows = specs.map(featureRow);
  const unused = (): never => {
    throw new Error("asset-divergence must not use this SiteQuery method");
  };
  const siteQuery: SiteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (row: PageFeatureRow) => boolean) {
      for (const row of rows) if (pred(row)) yield row;
    },
  };
  return {
    ...baseCtx,
    // EMPTY pages — the streaming path must not read them.
    site: { baseUrl: "https://example.com/", pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
}

async function checks(ctx: RuleContext): Promise<CheckResult[]> {
  return (await Promise.resolve(assetDivergenceRule.run(ctx))).checks;
}

/** Run BOTH paths over one fixture, assert byte-identical output, return it. */
async function bothPaths(specs: PageSpec[]): Promise<CheckResult> {
  const legacy = await checks(legacyCtx(specs));
  const streamed = await checks(siteQueryCtx(specs));
  expect(streamed).toEqual(legacy);
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

/** The item for one axis, or undefined when that axis reported nothing. */
function itemFor(check: CheckResult, dimension: string) {
  return check.items?.find((i) => i.meta?.dimension === dimension);
}

/** N pages off one template, numbered so each url is distinct. */
function template(count: number, make: (i: number) => PageSpec): PageSpec[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

/** The canonical healthy corpus: one layout, one favicon, one tint, one default OG. */
function uniformSite(count = 20): PageSpec[] {
  return template(count, (i) => ({
    path: `/page-${pad(i)}`,
    favicon: "/favicon.ico",
    themeColor: "#0a5c36",
    ogImage: "https://cdn.example.com/default-share.png",
  }));
}

describe("social/asset-divergence — silence guards", () => {
  test("skips a crawl below the site page floor", async () => {
    const check = await bothPaths(uniformSite(ASSET_NORM_MIN_PAGES - 1));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${ASSET_NORM_MIN_PAGES} needed`);
  });

  test("skips when too few pages declare any asset", async () => {
    // Enough pages to clear the site floor, but only a handful declare anything.
    const specs = [
      ...template(ASSET_NORM_MIN_SAMPLE - 1, (i) => ({
        path: `/bare-${pad(i)}`,
        favicon: "/favicon.ico",
        themeColor: "#0a5c36",
        ogImage: "https://cdn.example.com/default-share.png",
      })),
      ...template(ASSET_NORM_MIN_PAGES, (i) => ({ path: `/nothing-${pad(i)}` })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${ASSET_NORM_MIN_SAMPLE} page(s)`);
  });

  test("skips a site that genuinely varies its chrome (no modal norm)", async () => {
    // Every page a different favicon/tint/image: nothing reaches the agreement bar.
    const specs = template(20, (i) => ({
      path: `/page-${pad(i)}`,
      favicon: `/icons/icon-${pad(i)}.ico`,
      themeColor: `#00${pad(i)}`,
      ogImage: `https://cdn.example.com/share-${pad(i)}.png`,
    }));
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${Math.round(ASSET_NORM_MIN_AGREEMENT * 100)}%`);
  });

  test("a page that declares nothing is never a deviant", async () => {
    // Half the corpus ships no chrome at all — that is core/favicon's finding,
    // not this rule's, and the declaring half is uniform.
    const specs = [...uniformSite(12), ...template(12, (i) => ({ path: `/bare-${pad(i)}` }))];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.value).toBe(12);
  });

  test("non-2xx pages never vote", async () => {
    const specs = [
      ...uniformSite(12),
      ...template(6, (i) => ({
        path: `/gone-${pad(i)}`,
        status: 404,
        favicon: "/error-favicon.ico",
        themeColor: "#ff0000",
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });
});

describe("social/asset-divergence — no false positives on per-page OG images", () => {
  test("articles and products with their own OG image do not flag", async () => {
    // The exact shape the issue warns about: a uniform default on the marketing
    // pages, a distinct share image on every article and product.
    const specs = [
      ...uniformSite(12),
      ...template(10, (i) => ({
        path: `/blog/post-${pad(i)}`,
        pageType: "article",
        favicon: "/favicon.ico",
        themeColor: "#0a5c36",
        ogImage: `https://cdn.example.com/posts/post-${pad(i)}.png`,
      })),
      ...template(10, (i) => ({
        path: `/shop/item-${pad(i)}`,
        pageType: "product",
        favicon: "/favicon.ico",
        themeColor: "#0a5c36",
        ogImage: `https://cdn.example.com/products/item-${pad(i)}.png`,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    // Their favicon/theme-color still count — chrome is uniform even on an article.
    expect(check.value).toBe(32);
    const norms = (check.details as { norms: Array<{ dimension: string }> }).norms;
    expect(norms.map((n) => n.dimension)).toEqual(["favicon", "theme-color", "og-image"]);
  });

  test("a bespoke OG image on an untyped page does not flag", async () => {
    // Found replaying the rule over a stored crawl of openelectricity.org.au: a
    // site can ship a per-page preview image on pages the classifier calls
    // "unknown", which the page-type exemption alone would not cover. A value
    // carried by exactly ONE page is a per-page asset, not a template.
    const specs = [
      ...uniformSite(20),
      ...template(6, (i) => ({
        path: `/records/${pad(i)}`,
        favicon: "/favicon.ico",
        themeColor: "#0a5c36",
        ogImage: `https://cdn.example.com/previews/records-${pad(i)}.png`,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    // The 6 one-off images neither vote nor are judged on the OG axis.
    const norms = (check.details as { norms: Array<{ dimension: string; pages: number }> }).norms;
    expect(norms.find((n) => n.dimension === "og-image")?.pages).toBe(20);
    expect(check.value).toBe(26);
  });

  test("an article whose favicon drifts is still flagged", async () => {
    const specs = [
      ...uniformSite(20),
      ...template(2, (i) => ({
        path: `/blog/post-${pad(i)}`,
        pageType: "article",
        favicon: "/old-favicon.ico",
        themeColor: "#0a5c36",
        ogImage: `https://cdn.example.com/posts/post-${pad(i)}.png`,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(itemFor(check, "favicon")?.meta?.value).toBe("https://example.com/old-favicon.ico");
    expect(itemFor(check, "og-image")).toBeUndefined();
  });
});

describe("social/asset-divergence — findings", () => {
  test("warns on a small pocket of pages with a stale favicon", async () => {
    const specs = [
      ...uniformSite(20),
      ...template(2, (i) => ({
        path: `/legacy/page-${pad(i)}`,
        favicon: "/old/favicon.ico",
        themeColor: "#0a5c36",
        ogImage: "https://cdn.example.com/default-share.png",
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.value).toBe(2);
    const item = itemFor(check, "favicon");
    expect(item?.meta?.norm).toBe("https://example.com/favicon.ico");
    expect(item?.meta?.pageCount).toBe(2);
    expect(item?.sourcePages).toEqual([
      "https://example.com/legacy/page-000",
      "https://example.com/legacy/page-001",
    ]);
  });

  test("fails when the divergent pocket is large enough", async () => {
    const stale = 6; // 6/26 == 23% >= the fail share
    const specs = [
      ...uniformSite(20),
      ...template(stale, (i) => ({
        path: `/legacy/page-${pad(i)}`,
        favicon: "/old/favicon.ico",
        themeColor: "#123456",
        ogImage: "https://cdn.example.com/old-share.png",
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(stale / (20 + stale)).toBeGreaterThanOrEqual(ASSET_NORM_FAIL_SHARE);
    // One item per axis, all three named.
    expect(check.items?.map((i) => i.meta?.dimension).sort()).toEqual([
      "favicon",
      "og-image",
      "theme-color",
    ]);
  });

  test("reports a theme-color that drifted on its own", async () => {
    const specs = [
      ...uniformSite(20),
      ...template(3, (i) => ({
        path: `/support/page-${pad(i)}`,
        favicon: "/favicon.ico",
        themeColor: "#FFFFFF",
        ogImage: "https://cdn.example.com/default-share.png",
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    // Lowercased on the way in, so "#FFFFFF" and "#ffffff" are ONE value.
    expect(itemFor(check, "theme-color")?.meta?.value).toBe("#ffffff");
  });

  test("reports a divergent DEFAULT og:image on non-article pages", async () => {
    const specs = [
      ...uniformSite(20),
      ...template(3, (i) => ({
        path: `/landing/page-${pad(i)}`,
        favicon: "/favicon.ico",
        themeColor: "#0a5c36",
        ogImage: "https://cdn.example.com/old-brand-share.png",
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(itemFor(check, "og-image")?.meta?.norm).toBe(
      "https://cdn.example.com/default-share.png"
    );
  });

  test("passes a site whose chrome is uniform", async () => {
    const check = await bothPaths(uniformSite(20));
    expect(check.status).toBe("pass");
    expect(check.message).toContain("favicon, theme-color and default OG image");
    expect(check.items).toBeUndefined();
  });
});

describe("social/asset-divergence — extraction", () => {
  const chrome = (head: string, base = "https://example.com/a/b") =>
    extractSiteChromeSignal(parsedFor({ path: "/a/b", head }), base);

  test("resolves a root-relative favicon so depth does not matter", () => {
    expect(chrome('<link rel="icon" href="/favicon.ico">').faviconHref).toBe(
      "https://example.com/favicon.ico"
    );
  });

  test("apple-touch and mask icons never stand in for the favicon", () => {
    const signal = chrome(
      '<link rel="apple-touch-icon" href="/touch.png"><link rel="mask-icon" href="/mask.svg">' +
        '<link rel="shortcut icon" href="/real.ico">'
    );
    expect(signal.faviconHref).toBe("https://example.com/real.ico");
  });

  test("a light/dark theme-color pair reads as the unscoped declaration", () => {
    const signal = chrome(
      '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
        '<meta name="theme-color" content="#0a5c36">'
    );
    expect(signal.themeColor).toBe("#0a5c36");
  });

  test("a media-scoped-only page falls back to its first declaration", () => {
    const signal = chrome(
      '<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">' +
        '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">'
    );
    expect(signal.themeColor).toBe("#ffffff");
  });

  test("absent assets read as null, not empty strings", () => {
    const signal = chrome('<link rel="icon" href="">');
    expect(signal).toEqual({ faviconHref: null, themeColor: null, ogImage: null });
  });
});
