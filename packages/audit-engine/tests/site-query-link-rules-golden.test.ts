// SiteQuery dual-path golden tests (#1022, PR-B).
//
// The Bucket-D link-graph rules gained a streaming path: `if (ctx.siteQuery)` reads
// pre-materialized incoming-link counts instead of `ctx.site.pages`. These tests
// are the MERGE GATE for that path — each rule runs BOTH ways against ONE seeded
// storage fixture and the emitted checks must be deep-equal. The siteQuery run is
// given an EMPTY `site.pages`, so a passing test also proves the rule reads
// nothing from the resident page array on that path.
//
// The fixture deliberately exercises the parity-sensitive filters: nofollow
// exclusion, self-links, query-string collapse, external + non-crawled targets,
// and homepage skipping.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { loadAllRules } from "@squirrelscan/rules";
import { normalizeUrl } from "@squirrelscan/utils";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { LinkData, PageFeatureRow, PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery } from "../src/site-query";

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
const orphanRule = rules.get("links/orphan-pages")!;
const weakRule = rules.get("links/weak-internal-links")!;
const contextualRule = rules.get("links/no-contextual-inbound")!;

// ── fixture builders ──────────────────────────────────────────────────────────

function link(url: string): LinkData {
  return { url, text: "link", isInternal: true };
}
function nofollow(url: string): LinkData {
  return { url, text: "nf", isInternal: true, isNofollow: true, rel: ["nofollow"] };
}
function external(url: string): LinkData {
  return { url, text: "ext", isInternal: false };
}
/** A sitewide-chrome link — counted by incomingLinkCounts, NOT by the contextual map (#109). */
function chrome(url: string): LinkData {
  return { url, text: "chrome", isInternal: true, isChrome: true };
}

function pageRow(normalizedUrl: string, links: LinkData[]): PageRecord {
  return {
    url: normalizedUrl,
    normalizedUrl,
    finalUrl: normalizedUrl,
    depth: normalizedUrl === BASE ? 0 : 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: 128,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: "<html></html>",
    parsedData: JSON.stringify({ links }),
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
      xRobotsTag: null,
    },
  };
}

// A small link graph. Incoming dofollow-internal counts (to crawled pages):
//   /a=5, /b=2, /c=2, /lonely=1, /orphan=0, /nofollowed=0, /selfish=1, /=0
const FIXTURE: PageRecord[] = [
  pageRow(BASE, [
    link("/a"),
    link("/b"),
    link("/c"),
    link("/lonely"),
    external("https://external.com/x"), // external → ignored
    nofollow("/nofollowed"), // nofollow → not counted
    link("/notcrawled"), // target not crawled → ignored
  ]),
  pageRow("https://example.com/a", [
    link("/b"),
    link("/a?ref=1"), // query variant → collapses to /a (self +1)
  ]),
  pageRow("https://example.com/b", [link("/c")]),
  pageRow("https://example.com/c", [link("/a")]),
  pageRow("https://example.com/lonely", []),
  pageRow("https://example.com/nofollowed", []),
  pageRow("https://example.com/orphan", [link("/a")]),
  pageRow("https://example.com/selfish", [link("/selfish"), link("/a")]),
];

async function seedFixture(store: SQLiteStorage): Promise<void> {
  for (const p of FIXTURE) await run(store.upsertPage(CRAWL, p));
}

function parseLinks(parsedData: string | null): LinkData[] {
  if (!parsedData) return [];
  try {
    return (JSON.parse(parsedData) as { links?: LinkData[] }).links ?? [];
  } catch {
    return [];
  }
}

// Run `rule` both ways over the seeded crawl. Legacy: materialized site.pages
// (mapped exactly as the engine builds it — url = normalizedUrl, parsed.links from
// parsedData). Streaming: siteQuery from the factory + EMPTY site.pages.
async function runBothWays(
  store: SQLiteStorage,
  rule: Rule,
  options: Record<string, unknown>
) {
  const pages = await run(store.getPages(CRAWL));
  const sitePages = pages.map((p) => ({
    url: p.normalizedUrl,
    finalUrl: p.finalUrl,
    statusCode: p.status,
    parsed: { links: parseLinks(p.parsedData) } as ParsedPage,
  }));

  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options,
  };

  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: sitePages, robotsTxt: null, sitemaps: null },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    // EMPTY pages — the streaming path must not read them.
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;

  return { legacy, streamed };
}

describe("SiteQuery dual-path — links/orphan-pages", () => {
  test("streaming path is deep-equal to legacy AND flags the right orphans", async () => {
    const store = await freshStore();
    await seedFixture(store);

    const { legacy, streamed } = await runBothWays(store, orphanRule, {
      minInboundLinks: 2,
      excludePatterns: [],
    });

    expect(streamed).toEqual(legacy);
    expect(legacy).toEqual([
      {
        name: "orphan-pages",
        status: "warn",
        message: "4 orphan page(s) with <2 incoming links",
        items: [
          { id: "https://example.com/lonely" },
          { id: "https://example.com/nofollowed" },
          { id: "https://example.com/orphan" },
          { id: "https://example.com/selfish" },
        ],
        details: { total: 4 },
        value: "/lonely\n/nofollowed\n/orphan\n/selfish",
      },
    ]);
    await run(store.close());
  });

  test("excludePatterns option is honored identically on both paths", async () => {
    const store = await freshStore();
    await seedFixture(store);

    const { legacy, streamed } = await runBothWays(store, orphanRule, {
      minInboundLinks: 2,
      excludePatterns: ["/nofollowed", "/orphan"],
    });

    expect(streamed).toEqual(legacy);
    // The two excluded pages drop out; /lonely and /selfish remain.
    expect(legacy[0]!.items).toEqual([
      { id: "https://example.com/lonely" },
      { id: "https://example.com/selfish" },
    ]);
    await run(store.close());
  });

  test("higher minInboundLinks threshold matches on both paths", async () => {
    const store = await freshStore();
    await seedFixture(store);

    const { legacy, streamed } = await runBothWays(store, orphanRule, {
      minInboundLinks: 3,
      excludePatterns: [],
    });

    expect(streamed).toEqual(legacy);
    // Now /b (2) and /c (2) also fall below 3.
    expect(legacy[0]!.details).toEqual({ total: 6 });
    await run(store.close());
  });
});

describe("SiteQuery dual-path — links/weak-internal-links", () => {
  test("streaming path is deep-equal to legacy AND flags the single-inbound pages", async () => {
    const store = await freshStore();
    await seedFixture(store);

    const { legacy, streamed } = await runBothWays(store, weakRule, {
      excludePatterns: [],
    });

    expect(streamed).toEqual(legacy);
    expect(legacy).toEqual([
      {
        name: "weak-internal-links",
        status: "warn",
        message: "2 page(s) have only 1 internal link",
        items: [
          { id: "https://example.com/lonely" },
          { id: "https://example.com/selfish" },
        ],
        details: { total: 2 },
        value: "/lonely\n/selfish",
      },
    ]);
    await run(store.close());
  });
});

// ── #109: contextual (non-chrome) inbound links ───────────────────────────────

// Every page carries the same footer link to /legal, so /legal has a HEALTHY raw
// inbound count (4) and zero contextual support — the exact case orphan-pages and
// weak-internal-links cannot see. /deep is linked once, from body copy.
const CHROME_FIXTURE: PageRecord[] = [
  pageRow(BASE, [link("/a"), link("/b"), chrome("/legal")]),
  pageRow("https://example.com/a", [link("/b"), link("/deep"), chrome("/legal")]),
  pageRow("https://example.com/b", [link("/a"), chrome("/legal")]),
  pageRow("https://example.com/deep", [link("/a")]),
  pageRow("https://example.com/legal", [chrome("/legal")]),
];

async function seedChromeFixture(store: SQLiteStorage): Promise<void> {
  for (const p of CHROME_FIXTURE) await run(store.upsertPage(CRAWL, p));
}

/** Rebuild both inbound counts the way the LEGACY `site.pages` path does. */
function legacyCounts(pages: PageRecord[]): {
  all: Map<string, number>;
  contextual: Map<string, number>;
} {
  const all = new Map<string, number>();
  const contextual = new Map<string, number>();
  for (const p of pages) {
    all.set(normalizeUrl(p.normalizedUrl), 0);
    contextual.set(normalizeUrl(p.normalizedUrl), 0);
  }
  for (const p of pages) {
    for (const l of parseLinks(p.parsedData)) {
      if (!l.isInternal || !l.url || l.isNofollow) continue;
      const target = normalizeUrl(new URL(l.url, p.normalizedUrl).href);
      if (!all.has(target)) continue;
      all.set(target, all.get(target)! + 1);
      if (!l.isChrome) contextual.set(target, contextual.get(target)! + 1);
    }
  }
  // Project back onto each page's stored identity URL, in crawl order.
  return {
    all: new Map(pages.map((p) => [p.normalizedUrl, all.get(normalizeUrl(p.normalizedUrl))!])),
    contextual: new Map(
      pages.map((p) => [p.normalizedUrl, contextual.get(normalizeUrl(p.normalizedUrl))!])
    ),
  };
}

describe("SiteQuery — contextual inbound link counts (#109)", () => {
  test("chrome links count toward the raw map but not the contextual one", async () => {
    const store = await freshStore();
    await seedChromeFixture(store);

    const sq = await run(createSiteQuery(store, CRAWL));
    const all = sq.incomingLinkCounts();
    const contextual = sq.contextualIncomingLinkCounts();

    // Same keys, same order — the two maps are built in one pass.
    expect([...contextual.keys()]).toEqual([...all.keys()]);

    // /legal: four footer links, zero contextual → healthy on paper, unsupported.
    expect(all.get("https://example.com/legal")).toBe(4);
    expect(contextual.get("https://example.com/legal")).toBe(0);
    // /deep: one body-copy link.
    expect(all.get("https://example.com/deep")).toBe(1);
    expect(contextual.get("https://example.com/deep")).toBe(1);
    // contextual <= all holds for every page.
    for (const [url, count] of contextual) {
      expect(count).toBeLessThanOrEqual(all.get(url)!);
    }

    await run(store.close());
  });

  test("the legacy site.pages rebuild produces IDENTICAL counts to the accumulator", async () => {
    const store = await freshStore();
    await seedChromeFixture(store);

    const sq = await run(createSiteQuery(store, CRAWL));
    const legacy = legacyCounts(await run(store.getPages(CRAWL)));

    expect([...sq.incomingLinkCounts()]).toEqual([...legacy.all]);
    expect([...sq.contextualIncomingLinkCounts()]).toEqual([...legacy.contextual]);

    await run(store.close());
  });
});

describe("SiteQuery dual-path — links/no-contextual-inbound", () => {
  test("streaming path is deep-equal to legacy AND flags the chrome-only page", async () => {
    const store = await freshStore();
    await seedChromeFixture(store);

    const { legacy, streamed } = await runBothWays(store, contextualRule, {
      minInboundLinks: 2,
      excludePatterns: [],
    });

    expect(streamed).toEqual(legacy);
    expect(legacy).toEqual([
      {
        name: "no-contextual-inbound",
        status: "warn",
        message: "1 page(s) are linked only from sitewide chrome",
        items: [{ id: "https://example.com/legal" }],
        details: { total: 1 },
        value: "/legal",
      },
    ]);
    await run(store.close());
  });

  test("links/orphan-pages does NOT report that page — the blind spot is real", async () => {
    const store = await freshStore();
    await seedChromeFixture(store);

    const { legacy, streamed } = await runBothWays(store, orphanRule, {
      minInboundLinks: 2,
      excludePatterns: [],
    });

    expect(streamed).toEqual(legacy);
    // Only /deep (one inbound link) is an orphan; /legal's four footer links
    // keep it comfortably above the threshold on both paths.
    expect(legacy[0]!.items).toEqual([{ id: "https://example.com/deep" }]);
    await run(store.close());
  });

  test("a page linked once from body copy is not flagged, on either path", async () => {
    const store = await freshStore();
    // Raise the threshold so /deep's single body-copy link clears it and the rule
    // is forced to judge it on contextual support alone.
    await seedChromeFixture(store);

    const { legacy, streamed } = await runBothWays(store, contextualRule, {
      minInboundLinks: 1,
      excludePatterns: [],
    });

    expect(streamed).toEqual(legacy);
    expect(legacy[0]!.items).toEqual([{ id: "https://example.com/legal" }]);
    await run(store.close());
  });

  test("excludePatterns are honoured identically on both paths", async () => {
    const store = await freshStore();
    await seedChromeFixture(store);

    const { legacy, streamed } = await runBothWays(store, contextualRule, {
      minInboundLinks: 2,
      excludePatterns: ["/legal"],
    });

    expect(streamed).toEqual(legacy);
    expect(legacy[0]!.status).toBe("pass");
    await run(store.close());
  });
});

describe("SiteQuery dual-path — edge cases parity", () => {
  test("a crawl with <2 pages skips identically on both paths", async () => {
    const store = await freshStore();
    await run(store.upsertPage(CRAWL, pageRow(BASE, [link("/a")])));

    for (const [rule, options] of [
      [orphanRule, { minInboundLinks: 2, excludePatterns: [] }],
      [weakRule, { excludePatterns: [] }],
    ] as const) {
      const { legacy, streamed } = await runBothWays(store, rule, options);
      expect(streamed).toEqual(legacy);
      expect(legacy[0]!.status).toBe("skipped");
    }
    await run(store.close());
  });

  test("a fully-linked crawl passes identically on both paths", async () => {
    const store = await freshStore();
    // Every non-home page has >=2 incoming links.
    await run(store.upsertPage(CRAWL, pageRow(BASE, [link("/x"), link("/y")])));
    await run(store.upsertPage(CRAWL, pageRow("https://example.com/x", [link("/y")])));
    await run(store.upsertPage(CRAWL, pageRow("https://example.com/y", [link("/x")])));

    const { legacy, streamed } = await runBothWays(store, orphanRule, {
      minInboundLinks: 2,
      excludePatterns: [],
    });
    expect(streamed).toEqual(legacy);
    expect(legacy[0]!.status).toBe("pass");
    await run(store.close());
  });
});

// ── factory: page_features-backed methods (used by later buckets / E-E) ─────────

function feat(over: Partial<PageFeatureRow> = {}): PageFeatureRow {
  return {
    normalizedUrl: "https://example.com/a",
    status: 200,
    depth: 1,
    title: "T",
    titleHash: "th",
    description: "D",
    descHash: "dh",
    contentHash: "ch",
    wordCount: 10,
    pageType: "article",
    schemaTypes: [],
    robotsNoindex: false,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: 100,
    templateFp: "tpl",
    secretHits: 0,
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
    ...over,
  };
}

describe("createSiteQuery — page_features-backed aggregates", () => {
  test("wraps the PR-A read methods (count, dup groups, templates, byType, sums, homepage, cursor)", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/1", depth: 0, titleHash: "dup", pageType: "product", transferBytes: 100, secretHits: 1, templateFp: "T" }),
        feat({ normalizedUrl: "https://example.com/2", titleHash: "dup", pageType: "product", transferBytes: 200, secretHits: 2, templateFp: "T" }),
        feat({ normalizedUrl: "https://example.com/3", titleHash: "uniq", pageType: "article", transferBytes: 50, secretHits: 0, templateFp: "solo" }),
      ])
    );

    const sq = await run(createSiteQuery(store, CRAWL));

    expect(sq.pageCount()).toBe(3);
    expect(sq.sumTransferBytes()).toBe(350);
    expect(sq.sumSecretHits()).toBe(3);
    expect(sq.homepage()?.normalizedUrl).toBe("https://example.com/1"); // depth 0
    expect(sq.pagesByType("product")).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
    expect(sq.pagesByType("unknown")).toEqual([]);

    const dup = sq.duplicateGroups("title");
    expect(dup).toEqual([
      { hash: "dup", sample: "T", urls: ["https://example.com/1", "https://example.com/2"], count: 2 },
    ]);
    expect(sq.templateClusters()).toEqual([
      { fp: "T", urls: ["https://example.com/1", "https://example.com/2"], count: 2 },
    ]);

    const seen: string[] = [];
    for await (const row of sq.pagesMatching((r) => r.pageType === "product")) {
      seen.push(row.normalizedUrl);
    }
    expect(seen).toEqual(["https://example.com/1", "https://example.com/2"]);

    await run(store.close());
  });

  test("empty crawl → zero/empty aggregates, empty incoming counts", async () => {
    const store = await freshStore();
    const sq = await run(createSiteQuery(store, CRAWL));
    expect(sq.pageCount()).toBe(0);
    expect(sq.incomingLinkCounts().size).toBe(0);
    expect(sq.contextualIncomingLinkCounts().size).toBe(0);
    expect(sq.homepage()).toBeNull();
    expect(sq.duplicateGroups("content")).toEqual([]);
    expect(sq.templateClusters()).toEqual([]);
    expect(sq.pagesByType("article")).toEqual([]);
    expect(sq.sumTransferBytes()).toBe(0);
    const seen: PageFeatureRow[] = [];
    for await (const row of sq.pagesMatching(() => true)) seen.push(row);
    expect(seen).toEqual([]);
    await run(store.close());
  });
});
