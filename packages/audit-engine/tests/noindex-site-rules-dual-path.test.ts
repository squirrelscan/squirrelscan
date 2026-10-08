// Site rules leave noindex pages out on BOTH paths, pub#457.
//
// content/duplicate-title, content/duplicate-description, core/title-unique and
// links/orphan-pages exclude pages marked noindex. The legacy path decides from
// each page's parsed meta + headers (`noindexSource`); the streaming path reads
// `page_features.robots_noindex`, which extractPageFeatures computes with the same
// `isPageIndexable`. Each rule runs both ways over one seeded store and must agree,
// with and without a site known to be indexed (`SiteData.siteIndexable`).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { LinkData, PageFeatureRow, PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery } from "../src/site-query";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";

const rules = loadAllRules();

interface Spec {
  normalizedUrl: string;
  title: string;
  description: string;
  robots: string | null;
  xRobotsTag: string | null;
  links: string[];
}

// normalized_url ASC order (the page_features cursor and getPages order).
// Two indexable pages share a title/description; two noindex pages (meta, and
// googlebot-scoped header) share another, so a duplicate group exists only when
// noindex pages are counted. The noindex pages also have no inbound links.
const FIXTURE: Spec[] = [
  {
    normalizedUrl: "https://example.com/",
    title: "Home",
    description: "Home page",
    robots: null,
    xRobotsTag: null,
    links: ["/a", "/a", "/b", "/b"],
  },
  {
    normalizedUrl: "https://example.com/a",
    title: "Shared",
    description: "Shared desc",
    robots: null,
    xRobotsTag: null,
    links: ["/b"],
  },
  {
    normalizedUrl: "https://example.com/b",
    title: "Shared",
    description: "Shared desc",
    robots: null,
    xRobotsTag: null,
    links: ["/a"],
  },
  {
    normalizedUrl: "https://example.com/hdr",
    title: "Hidden",
    description: "Hidden desc",
    robots: null,
    xRobotsTag: "googlebot: noindex",
    links: [],
  },
  {
    normalizedUrl: "https://example.com/meta",
    title: "Hidden",
    description: "Hidden desc",
    robots: "noindex,nofollow",
    xRobotsTag: null,
    links: [],
  },
];

const isNoindex = (s: Spec) =>
  (s.robots ?? "").toLowerCase().includes("noindex") ||
  (s.xRobotsTag ?? "").toLowerCase().includes("noindex");

function link(url: string): LinkData {
  return { url, text: "link", isInternal: true };
}

function pageRow(s: Spec): PageRecord {
  return {
    url: s.normalizedUrl,
    normalizedUrl: s.normalizedUrl,
    finalUrl: s.normalizedUrl,
    depth: s.normalizedUrl === BASE ? 0 : 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: 128,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: "<html></html>",
    parsedData: JSON.stringify({ links: s.links.map(link) }),
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: s.xRobotsTag,
    },
  };
}

function feat(s: Spec): PageFeatureRow {
  return {
    normalizedUrl: s.normalizedUrl,
    status: 200,
    depth: s.normalizedUrl === BASE ? 0 : 1,
    title: s.title,
    titleHash: `h:${s.title.toLowerCase()}`,
    description: s.description,
    descHash: `h:${s.description.toLowerCase()}`,
    contentHash: null,
    wordCount: null,
    pageType: null,
    schemaTypes: [],
    robotsNoindex: isNoindex(s),
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: (s.robots ?? "").includes("noindex"),
    indexableReasons: [],
    richResultTypes: [],
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
    faviconHref: null,
    themeColor: null,
    ogImage: null,
  };
}

async function seededStore(fixture: Spec[] = FIXTURE): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  for (const s of fixture) await run(store.upsertPage(CRAWL, pageRow(s)));
  await run(store.upsertPageFeaturesBatch(CRAWL, fixture.map(feat)));
  return store;
}

// The legacy site.pages entry, shaped as the engine builds it (headers from
// buildHeadersMap: lowercase `x-robots-tag`).
function legacyPages(fixture: Spec[] = FIXTURE) {
  return fixture.map((s) => ({
    url: s.normalizedUrl,
    statusCode: 200,
    parsed: {
      meta: { title: s.title, description: s.description, robots: s.robots },
      links: s.links.map(link),
    } as unknown as ParsedPage,
    headers: s.xRobotsTag ? { "x-robots-tag": s.xRobotsTag } : {},
  }));
}

async function runBothWays(
  store: SQLiteStorage,
  rule: Rule,
  siteIndexable: boolean | undefined,
  options: Record<string, unknown> = {},
  fixture: Spec[] = FIXTURE,
) {
  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options,
  };
  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: legacyPages(fixture), robotsTxt: null, sitemaps: null, siteIndexable },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    // EMPTY pages: the streaming path must not read them.
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, siteIndexable },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;
  return { legacy, streamed };
}

const CASES: Array<{
  id: string;
  options?: Record<string, unknown>;
  skipped: string;
  counted: string;
}> = [
  {
    id: "content/duplicate-title",
    skipped: "1 duplicate title(s) found across 2 pages",
    counted: "2 duplicate title(s) found across 4 pages",
  },
  {
    id: "content/duplicate-description",
    skipped: "1 duplicate description(s) found across 2 pages",
    counted: "2 duplicate description(s) found across 4 pages",
  },
  {
    id: "core/title-unique",
    skipped: "1 duplicate title(s) affecting 2 pages",
    counted: "2 duplicate title(s) affecting 4 pages",
  },
  {
    id: "links/orphan-pages",
    options: { minInboundLinks: 2, excludePatterns: [] },
    skipped: "All pages have sufficient internal links pointing to them",
    counted: "2 orphan page(s) with <2 incoming links",
  },
];

describe("noindex pages are left out of the site rules, identically on both paths", () => {
  for (const c of CASES) {
    test(`${c.id}: excluded on an indexed site, counted otherwise`, async () => {
      const store = await seededStore();
      const rule = rules.get(c.id)!;

      const skipped = await runBothWays(store, rule, true, c.options);
      expect(skipped.streamed).toEqual(skipped.legacy);
      expect(skipped.legacy[0]?.message).toBe(c.skipped);

      // A staging or preview host (false) and an unknown one (undefined) count all.
      for (const siteIndexable of [false, undefined]) {
        const counted = await runBothWays(store, rule, siteIndexable, c.options);
        expect(counted.streamed).toEqual(counted.legacy);
        expect(counted.legacy[0]?.message).toBe(c.counted);
      }

      await run(store.close());
    });
  }
});

// content/title-pattern-outlier (pub#488): 12 catalogue pages share one template and
// two noindex pages (one meta, one X-Robots-Tag header) carry short titles.
const OUTLIER_FIXTURE: Spec[] = [
  ...Array.from({ length: 12 }, (_, i): Spec => ({
    normalizedUrl: `https://example.com/p${String(i + 1).padStart(2, "0")}.html`,
    title: `Product number ${i + 1} in our catalogue | Brand`,
    description: `Product ${i + 1}`,
    robots: null,
    xRobotsTag: null,
    links: [],
  })),
  {
    normalizedUrl: "https://example.com/campaign-terms.html",
    title: "Terms",
    description: "Terms",
    robots: null,
    xRobotsTag: "noindex",
    links: [],
  },
  {
    normalizedUrl: "https://example.com/campaign.html",
    title: "Campaign",
    description: "Campaign",
    robots: "noindex,follow",
    xRobotsTag: null,
    links: [],
  },
].sort((a, b) => (a.normalizedUrl < b.normalizedUrl ? -1 : 1));

describe("content/title-pattern-outlier leaves noindex pages out, identically on both paths", () => {
  test("excluded on an indexed site, judged otherwise", async () => {
    const store = await seededStore(OUTLIER_FIXTURE);
    const rule = rules.get("content/title-pattern-outlier")!;

    const skipped = await runBothWays(store, rule, true, {}, OUTLIER_FIXTURE);
    expect(skipped.streamed).toEqual(skipped.legacy);
    expect(skipped.legacy[0]?.status).toBe("pass");

    for (const siteIndexable of [false, undefined]) {
      const counted = await runBothWays(store, rule, siteIndexable, {}, OUTLIER_FIXTURE);
      expect(counted.streamed).toEqual(counted.legacy);
      expect(counted.legacy[0]?.status).toBe("warn");
      expect(counted.legacy[0]?.items?.[0]?.id).toBe("brand-missing:");
    }

    await run(store.close());
  });
});
