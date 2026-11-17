// repo#3094: `squirrel report` rebuilds the audit from the store. The live audit stamps `render` after
// the crawl, so the rebuilt report has to read it back from the stored pages, or a rendered audit
// reads as one that rendered nothing.

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
  pagesTotal: 2,
  pagesFetched: 2,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function page(n: number, fetcherId?: string): PageRecord {
  const url = `${SITE}/page-${n}`;
  const html = `<html lang="en"><head><title>Page ${n}</title></head><body>Page ${n}</body></html>`;
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
    ...(fetcherId ? { fetcherId } : {}),
  };
}

async function store(rows: PageRecord[]) {
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
  for (const row of rows) await run(db.upsertPage(crawlId, row));
  return { db, crawlId };
}

describe("render block of a report rebuilt from the store (repo#3094)", () => {
  test("rendered pages restore the render block", async () => {
    const { db, crawlId } = await store([
      page(1, "cloud-render"),
      page(2, "fetch"),
    ]);
    const report = await run(reconstructReport(db, crawlId));
    expect(report.render).toEqual({
      requested: true,
      mode: "auto",
      pagesRendered: 1,
      pagesFetchedPlain: 1,
    });
    await run(db.close());
  });

  test("an audit that rendered nothing has no render block", async () => {
    const { db, crawlId } = await store([page(1, "fetch"), page(2)]);
    const report = await run(reconstructReport(db, crawlId));
    expect(report.render).toBeUndefined();
    await run(db.close());
  });
});
