// The fresh-fetch note on a reconstructed report (#2032).

import type { PageRecord } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(eff));
}

async function freshCrawl(
  pages: PageRecord[],
  noCache: boolean
): Promise<{
  store: SQLiteStorage;
  crawlId: string;
}> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      seedUrl: SITE,
      originalUrl: SITE,
      startedAt: Date.now(),
      status: "analyzed",
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 30000,
        userAgent: "test",
        followRedirects: true,
        respectRobots: false,
        incremental: false,
        include: [],
        exclude: [],
        allowQueryParams: [],
        dropQueryPrefixes: [],
        allowedDomains: [],
        ...(noCache ? { noCache: true } : {}),
      },
      stats: {
        pagesTotal: pages.length,
        pagesFetched: pages.length,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      },
    })
  );
  for (const page of pages) await run(store.upsertPage(crawlId, page));
  return { store, crawlId };
}

function page(
  url: string,
  age: string | null,
  xCache: string | null
): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 0,
    loadTimeMs: 0,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: null,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: "nginx",
      lastModified: null,
      link: null,
      serverTiming: null,
      age,
      xCache,
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

const PAGES = () => [page(SITE, "300", null), page(`${SITE}/b`, null, "MISS")];

describe("reconstructReport cacheFreshness (#2032)", () => {
  test("an ordinary crawl carries no note even when a response has Age", async () => {
    const { store, crawlId } = await freshCrawl(PAGES(), false);
    const report = await run(reconstructReport(store, crawlId, undefined));
    expect(report.cacheFreshness).toBeUndefined();
    await run(store.close());
  }, 30_000);

  test("a no-cache crawl lists the page that still looks cached", async () => {
    const { store, crawlId } = await freshCrawl(PAGES(), true);
    const report = await run(reconstructReport(store, crawlId, undefined));
    expect(report.cacheFreshness).toEqual({
      noCache: true,
      freshRender: false,
      stalePageCount: 1,
      stalePages: [{ url: SITE, signal: "Age: 300" }],
    });
    await run(store.close());
  }, 30_000);

  test("freshRender on the options states it without a no-cache crawl", async () => {
    const { store, crawlId } = await freshCrawl(PAGES(), false);
    const report = await run(
      reconstructReport(store, crawlId, undefined, { freshRender: true })
    );
    expect(report.cacheFreshness).toEqual({
      noCache: false,
      freshRender: true,
      stalePageCount: 0,
      stalePages: [],
    });
    await run(store.close());
  }, 30_000);
});
