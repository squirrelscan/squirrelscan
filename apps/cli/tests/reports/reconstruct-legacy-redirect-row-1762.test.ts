// #1762: the report rebuilt from the store reads pages without their bodies, so a cached row from before the
// redirect rule (the destination's markup filed under the redirecting URL, status 2xx) has `html` null here. It
// is still a redirect row, read by its content hash, and is neither listed as a page nor counted in the totals.

import type {
  CrawlMetadata,
  PageRecord,
} from "@squirrelscan/core-contracts/storage";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(effect));
}

const STATS = {
  pagesTotal: 5,
  pagesFetched: 5,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function page(n: number): PageRecord {
  const url = `${SITE}/page-${n}`;
  const html = `<html><head><title>Page ${n}</title></head><body>Page ${n}</body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `page-${n}`,
    html,
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
      xRobotsTag: null,
    },
  };
}

async function store(extra: PageRecord[]) {
  const db = new SQLiteStorage(":memory:");
  await run(db.init());
  const crawlId = await run(
    db.createCrawl({
      baseUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      config: { maxPages: 5 } as CrawlMetadata["config"],
      stats: STATS,
    })
  );
  for (const row of [page(1), page(2), ...extra])
    await run(db.upsertPage(crawlId, row));
  return { db, crawlId };
}

const hop = (url: string, statusCode: number) => ({
  url,
  statusCode,
  type: "http" as const,
});
const chain = (from: string, to: string, keptAsPage = false) => ({
  sourceUrl: from,
  finalUrl: to,
  hops: [hop(from, 301), hop(to, 200)],
  chainLength: 1,
  isLoop: false,
  endsInError: false,
  httpsToHttp: false,
  httpToHttps: false,
  ...(keptAsPage ? { keptAsPage: true } : {}),
});

describe("a stored legacy redirect row in a rebuilt report (#1762)", () => {
  test("a 2xx row holding the destination's markup under the redirecting URL is not a page", async () => {
    const legacy: PageRecord = {
      ...page(2),
      url: `${SITE}/old`,
      normalizedUrl: `${SITE}/old`,
      finalUrl: `${SITE}/page-2`,
      contentHash: "page-2",
      redirectChain: chain(`${SITE}/old`, `${SITE}/page-2`),
    };
    const { db, crawlId } = await store([legacy]);
    const report = await run(
      reconstructReport(db, crawlId, undefined, { includePageRuleCounts: true })
    );
    const urls = report.pages.map((p) => p.url);
    expect(urls).not.toContain(`${SITE}/old`);
    expect(urls.sort()).toEqual([`${SITE}/page-1`, `${SITE}/page-2`]);
    expect(report.totalPages).toBe(2);
    await run(db.close());
  });

  test("the same row marked as kept on purpose stays a page", async () => {
    const kept: PageRecord = {
      ...page(2),
      url: `${SITE}/docs`,
      normalizedUrl: `${SITE}/docs`,
      finalUrl: `${SITE}/documentation`,
      contentHash: "docs",
      redirectChain: chain(`${SITE}/docs`, `${SITE}/documentation`, true),
    };
    const { db, crawlId } = await store([kept]);
    const report = await run(reconstructReport(db, crawlId));
    expect(report.pages.map((p) => p.url)).toContain(`${SITE}/docs`);
    expect(report.totalPages).toBe(3);
    await run(db.close());
  });
});
