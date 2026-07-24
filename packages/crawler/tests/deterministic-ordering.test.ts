// #150 — repeat audits must emit pages/links/images/findings/site-pages in a
// stable order. #114's bounded-concurrency rule execution inserts rows in a
// nondeterministic order, so the read queries (getPages/getLinks/getImages/
// getFindings/getSitePages) now carry an explicit ORDER BY. These tests assert
// the read order is independent of insert order (insert shuffled → identical
// sorted output).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type {
  CrawlMetadata,
  ImageRecord,
  LinkRecord,
  PageFindingRecord,
  PageRecord,
  ResponseHeaders,
  SecurityHeaders,
  SitePageRecord,
} from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const HEADERS: ResponseHeaders = {
  contentType: null,
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
};

const SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

async function freshCrawl(store: SQLiteStorage): Promise<string> {
  const meta: Omit<CrawlMetadata, "id"> = {
    baseUrl: "https://example.com",
    startedAt: 1,
    status: "running",
    config: {
      maxPages: 10,
      concurrency: 1,
      perHostConcurrency: 1,
      delayMs: 0,
      perHostDelayMs: 0,
      timeoutMs: 1000,
      userAgent: "test",
      followRedirects: true,
      respectRobots: false,
      incremental: false,
      include: [],
      exclude: [],
      allowQueryParams: [],
      dropQueryPrefixes: [],
      allowedDomains: [],
    },
    stats: {
      pagesTotal: 0,
      pagesFetched: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
      pagesUnchanged: 0,
      linksTotal: 0,
      imagesTotal: 0,
      bytesTotal: 0,
      avgLoadTimeMs: 0,
    },
  };
  return run(store.createCrawl(meta));
}

function page(normalizedUrl: string): PageRecord {
  return {
    url: normalizedUrl,
    normalizedUrl,
    finalUrl: normalizedUrl,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 1,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: null,
    parsedData: null,
    headers: HEADERS,
    securityHeaders: SECURITY_HEADERS,
  };
}

function link(href: string): LinkRecord {
  return { href, isInternal: true };
}

function image(src: string): ImageRecord {
  return { src };
}

const SITE = "https://example.com";

function finding(over: Partial<PageFindingRecord> = {}): PageFindingRecord {
  return {
    siteKey: SITE,
    normalizedUrl: "https://example.com/a",
    ruleId: "core/meta-title",
    checkName: "Meta Title",
    locator: "",
    status: "fail",
    severity: "error",
    message: "Missing title",
    value: null,
    expected: null,
    payload: null,
    fingerprint: "fp1",
    firstSeenAt: 1000,
    lastSeenCrawlId: "crawl-1",
    lastSeenAt: 1000,
    provenance: "fresh",
    state: "open",
    ...over,
  };
}

// Deliberately out-of-order insert set; expected = the same set sorted ASC.
const SHUFFLED = ["c", "a", "d", "b"];
const SORTED = ["a", "b", "c", "d"];

describe("deterministic read ordering (#150)", () => {
  test("getPages returns pages sorted by normalized_url regardless of insert order", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);
    for (const s of SHUFFLED) {
      await run(store.upsertPage(crawlId, page(`https://example.com/${s}`)));
    }
    const got = await run(store.getPages(crawlId));
    expect(got.map((p) => p.normalizedUrl)).toEqual(
      SORTED.map((s) => `https://example.com/${s}`)
    );
    await run(store.close());
  });

  test("getLinks returns links sorted by href regardless of insert order", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);
    for (const s of SHUFFLED) {
      await run(store.upsertLink(crawlId, link(`https://example.com/${s}`)));
    }
    const got = await run(store.getLinks(crawlId));
    expect(got.map((l) => l.href)).toEqual(
      SORTED.map((s) => `https://example.com/${s}`)
    );
    await run(store.close());
  });

  test("getImages returns images sorted by src regardless of insert order", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);
    for (const s of SHUFFLED) {
      await run(store.upsertImage(crawlId, image(`https://example.com/${s}.png`)));
    }
    const got = await run(store.getImages(crawlId));
    expect(got.map((i) => i.src)).toEqual(
      SORTED.map((s) => `https://example.com/${s}.png`)
    );
    await run(store.close());
  });

  test("getFindings orders by (normalized_url, rule_id, check_name, locator)", async () => {
    const store = await freshStore();
    // Insert in a deliberately scrambled order across all four key columns.
    await run(
      store.upsertFindings([
        finding({ normalizedUrl: `${SITE}/b`, ruleId: "r2", locator: "z", fingerprint: "1" }),
        finding({ normalizedUrl: `${SITE}/a`, ruleId: "r2", locator: "a", fingerprint: "2" }),
        finding({ normalizedUrl: `${SITE}/a`, ruleId: "r1", locator: "b", fingerprint: "3" }),
        finding({ normalizedUrl: `${SITE}/a`, ruleId: "r1", locator: "a", fingerprint: "4" }),
        finding({ normalizedUrl: `${SITE}/b`, ruleId: "r1", locator: "a", fingerprint: "5" }),
      ])
    );
    const key = (f: PageFindingRecord) =>
      `${f.normalizedUrl}|${f.ruleId}|${f.checkName}|${f.locator}`;
    const got = (await run(store.getFindings(SITE))).map(key);
    expect(got).toEqual([
      `${SITE}/a|r1|Meta Title|a`,
      `${SITE}/a|r1|Meta Title|b`,
      `${SITE}/a|r2|Meta Title|a`,
      `${SITE}/b|r1|Meta Title|a`,
      `${SITE}/b|r2|Meta Title|z`,
    ]);
    // The state-filtered branch carries the same ORDER BY.
    const open = (await run(store.getFindings(SITE, ["open"]))).map(key);
    expect(open).toEqual(got);
    await run(store.close());
  });

  test("getSitePages returns pages sorted by normalized_url", async () => {
    const store = await freshStore();
    const pages: SitePageRecord[] = SHUFFLED.map((s) => ({
      siteKey: SITE,
      normalizedUrl: `${SITE}/${s}`,
      lastStatus: 200,
      state: "active",
      lastSeenCrawlId: "c1",
      lastSeenAt: 1,
    }));
    await run(store.upsertSitePages(pages));
    const got = await run(store.getSitePages(SITE));
    expect(got.map((p) => p.normalizedUrl)).toEqual(
      SORTED.map((s) => `${SITE}/${s}`)
    );
    await run(store.close());
  });

  test("two independent stores with shuffled inserts read back byte-identical", async () => {
    // Same logical set, two different insert orders → identical read order.
    const orderA = ["d", "b", "a", "c"];
    const orderB = ["a", "c", "d", "b"];

    async function pageUrls(order: string[]): Promise<string[]> {
      const store = await freshStore();
      const crawlId = await freshCrawl(store);
      for (const s of order) {
        await run(store.upsertPage(crawlId, page(`https://example.com/${s}`)));
      }
      const out = (await run(store.getPages(crawlId))).map((p) => p.normalizedUrl);
      await run(store.close());
      return out;
    }

    expect(await pageUrls(orderA)).toEqual(await pageUrls(orderB));
  });
});
