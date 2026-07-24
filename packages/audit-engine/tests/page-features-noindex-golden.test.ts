// Page-time extraction + Bucket-E/noindex dual-path golden tests (#1022, PR-D).
//
// The chain under test: extractPageFeatures(page, parsed) -> upsertPageFeatures ->
// createSiteQuery -> rule streaming branch. For each of the 5 unlocked crawl rules
// we run the legacy branch (over the SAME parsed pages) and the streaming branch
// (over the extracted+stored features) and assert deep-equal checks. Because the
// stored features come from extractPageFeatures applied to the identical parsed
// pages, this also end-to-end-validates the extractor + the v19 columns.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type {
  PageRecord,
  RobotsTxtData,
  SitemapDiscovery,
} from "@squirrelscan/core-contracts";

import { createSiteQuery, extractPageFeatures, isAuditablePage } from "../src/index";
import { buildHeadersMap } from "../src/adapter";

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

const rules = loadAllRules();
const robotsMetaConflictRule = rules.get("crawl/robots-meta-conflict")!;
const noindexInSitemapRule = rules.get("crawl/noindex-in-sitemap")!;
const indexabilityConflicts = rules.get("crawl/indexability-conflicts")!;
const allNoindexPages = rules.get("crawl/all-noindex-pages")!;
const schemaNoindexConflict = rules.get("crawl/schema-noindex-conflict")!;

interface Spec {
  normalizedUrl: string;
  robots: string | null; // meta robots
  xRobotsTag: string | null; // X-Robots-Tag header
  schemaTypes: string[];
}

function mkPage(spec: Spec): { page: PageRecord; parsed: ParsedPage } {
  const page: PageRecord = {
    url: spec.normalizedUrl,
    normalizedUrl: spec.normalizedUrl,
    finalUrl: spec.normalizedUrl,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: 1234,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "chash",
    html: "<html></html>",
    parsedData: null,
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
      xRobotsTag: spec.xRobotsTag,
    },
  };
  const parsed = {
    meta: {
      title: "T",
      description: "D",
      canonical: null,
      robots: spec.robots,
    },
    schemas: { types: spec.schemaTypes, valid: true, errors: [], raw: null },
    content: { wordCount: 100 },
    pageType: "generic",
    visibleAuthor: null,
    visibleDatePublished: null,
    visibleDateModified: null,
  } as unknown as ParsedPage;
  return { page, parsed };
}

// Fixture (normalized_url ASC): exercises meta-noindex, header-noindex,
// robots.txt-disallow, and rich-schema conflicts.
const FIXTURE: Spec[] = [
  { normalizedUrl: "https://example.com/a", robots: "noindex,follow", xRobotsTag: null, schemaTypes: [] },
  { normalizedUrl: "https://example.com/c", robots: "index,follow", xRobotsTag: null, schemaTypes: ["Article", "Product"] },
  { normalizedUrl: "https://example.com/private/x", robots: "noindex", xRobotsTag: null, schemaTypes: ["Recipe"] },
  { normalizedUrl: "https://example.com/z", robots: null, xRobotsTag: "noindex", schemaTypes: [] },
];

const ROBOTS_TXT: RobotsTxtData = {
  exists: true,
  rules: [{ userAgent: "*", rules: [{ type: "disallow", path: "/private" }] }],
} as unknown as RobotsTxtData;

const SITEMAPS: SitemapDiscovery = {
  discovered: [
    {
      urls: [{ loc: "https://example.com/a" }, { loc: "https://example.com/c" }],
    },
  ],
} as unknown as SitemapDiscovery;

async function seedAndRun(rule: Rule, options: Record<string, unknown> = {}) {
  const store = await freshStore();
  const built = FIXTURE.map(mkPage);

  // Streaming: extract features from each parsed page and store them.
  for (const { page, parsed } of built) {
    await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));
  }

  // Legacy site.pages, normalized_url ASC (== cursor order), headers via buildHeadersMap.
  const sitePages = [...built]
    .sort((a, b) => (a.page.normalizedUrl < b.page.normalizedUrl ? -1 : 1))
    .map(({ page, parsed }) => ({
      url: page.normalizedUrl,
      statusCode: page.status,
      parsed,
      headers: buildHeadersMap(page),
    }));

  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options,
  };
  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: sitePages, robotsTxt: ROBOTS_TXT, sitemaps: SITEMAPS },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: [], robotsTxt: ROBOTS_TXT, sitemaps: SITEMAPS },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;

  await run(store.close());
  return { legacy, streamed };
}

describe("PR-D dual-path golden — noindex family (extractor → siteQuery)", () => {
  test("crawl/robots-meta-conflict", async () => {
    const { legacy, streamed } = await seedAndRun(robotsMetaConflictRule);
    expect(streamed).toEqual(legacy);
    // /private/x is robots.txt-blocked AND meta-noindex → redundant.
    expect(legacy.find((c) => c.name === "redundant-noindex")?.message).toBe(
      "1 page(s) blocked in robots.txt also have noindex"
    );
  });

  test("crawl/noindex-in-sitemap", async () => {
    const { legacy, streamed } = await seedAndRun(noindexInSitemapRule);
    expect(streamed).toEqual(legacy);
    // /a is meta-noindex AND in the sitemap.
    expect(legacy).toEqual([
      {
        name: "noindex-in-sitemap",
        status: "warn",
        message: "1 noindexed page(s) found in sitemap",
        items: [{ id: "https://example.com/a" }],
      },
    ]);
  });

  test("crawl/indexability-conflicts", async () => {
    const { legacy, streamed } = await seedAndRun(indexabilityConflicts);
    expect(streamed).toEqual(legacy);
    // /a (meta noindex, not blocked) + /z (header noindex, not blocked) → type1.
    expect(legacy.find((c) => c.name === "robots-allow-but-noindex")?.message).toBe(
      "2 page(s) allowed in robots.txt but have noindex"
    );
  });

  test("crawl/all-noindex-pages", async () => {
    const { legacy, streamed } = await seedAndRun(allNoindexPages, {
      warnOnPatterns: [],
      errorOnPatterns: [],
    });
    expect(streamed).toEqual(legacy);
    // /a, /private/x, /z blocked; /c indexable. All fall in the info bucket.
    const info = legacy.find((c) => c.name === "all-noindex" && c.status === "info");
    expect(info?.message).toBe("3 page(s) blocked from indexing");
    // Reason reconstruction (2-arg + robots.txt append) surfaces both reasons.
    expect(String(info?.value)).toContain("/private/x (meta:noindex, robots.txt:disallowed)");
  });

  test("crawl/schema-noindex-conflict", async () => {
    const { legacy, streamed } = await seedAndRun(schemaNoindexConflict);
    expect(streamed).toEqual(legacy);
    // /private/x has rich schema (Recipe) AND is blocked.
    expect(legacy[0]!.status).toBe("fail");
    expect(String(legacy[0]!.value)).toContain("Schema: Recipe");
  });
});

describe("extractPageFeatures — field extraction", () => {
  test("computes meta/header indexability, meta-only noindex, rich types, raw scalars", async () => {
    const { page, parsed } = mkPage({
      normalizedUrl: "https://example.com/p",
      robots: "NoIndex, nofollow",
      xRobotsTag: null,
      schemaTypes: ["article", "UnknownType"],
    });
    const row = extractPageFeatures(page, parsed);
    expect(row.normalizedUrl).toBe("https://example.com/p");
    expect(row.metaNoindex).toBe(true); // token-exact, case-insensitive
    expect(row.indexableReasons).toEqual(["meta:noindex"]);
    expect(row.robotsNoindex).toBe(true);
    expect(row.richResultTypes).toEqual(["Article"]); // canonical casing, unknown dropped
    expect(row.title).toBe("T"); // raw
    expect(row.transferBytes).toBe(1234); // page.sizeBytes
    expect(row.templateFp).toBeNull(); // deferred
    expect(row.secretHits).toBeNull(); // deferred
  });

  test("header X-Robots-Tag noindex is captured via buildHeadersMap", async () => {
    const { page, parsed } = mkPage({
      normalizedUrl: "https://example.com/h",
      robots: null,
      xRobotsTag: "noindex",
      schemaTypes: [],
    });
    const row = extractPageFeatures(page, parsed);
    expect(row.metaNoindex).toBe(false); // meta-only notion: header doesn't count
    expect(row.indexableReasons).toEqual(["header:noindex"]);
    expect(row.robotsNoindex).toBe(true); // combined notion: header counts
  });
});

describe("isAuditablePage — page-universe predicate (E-E gates extraction on this)", () => {
  function base(): PageRecord {
    return mkPage({ normalizedUrl: BASE, robots: null, xRobotsTag: null, schemaTypes: [] }).page;
  }

  test("normal 200 text/html page with a body → true", () => {
    expect(isAuditablePage(base())).toBe(true);
  });

  test("non-HTML content-type → false", () => {
    expect(isAuditablePage({ ...base(), contentType: "application/pdf" })).toBe(false);
  });

  test("missing body → false", () => {
    expect(isAuditablePage({ ...base(), html: null })).toBe(false);
  });

  test("WAF-challenge interstitial → false", () => {
    const waf: PageRecord = {
      ...base(),
      status: 503,
      html: "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing.</body></html>",
    };
    expect(isAuditablePage(waf)).toBe(false);
  });
});
