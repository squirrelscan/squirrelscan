// A report rebuilt from the store reads a `--max-duration` cut the way the live run did (#1662).
//
// The rebuild half is pinned from the stored scope (this file ran green on the code before the
// shared function existed); the live half is in max-duration-status-1662.test.ts.

import type {
  CrawlMetadata,
  MaxDurationCut,
  PageRecord,
} from "@squirrelscan/core-contracts";

import { maxDurationReason } from "@squirrelscan/core-contracts/failure-reason";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";
const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

const STATS = {
  pagesTotal: 3,
  pagesFetched: 3,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function page(n: number, status = 200): PageRecord {
  const url = `${SITE}/page-${n}`;
  const html = `<html><head><title>Page ${n}</title></head><body>Page ${n}</body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status,
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
  } as unknown as PageRecord;
}

const CUT: MaxDurationCut = {
  seconds: 30,
  unfetchedPages: 12,
  pagesNotEvaluated: 0,
  siteChecksCut: false,
};

async function stored(opts: { cut?: MaxDurationCut; pageStatus?: number }) {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      config: { maxPages: 5 } as CrawlMetadata["config"],
      stats: STATS,
      ...(opts.cut
        ? { scanScope: { maxDuration: opts.cut } as CrawlMetadata["scanScope"] }
        : {}),
    })
  );
  for (let n = 1; n <= 3; n++)
    await run(store.upsertPage(crawlId, page(n, opts.pageStatus ?? 200)));
  return { store, crawlId };
}

describe("rebuilding a stored audit", () => {
  test("a crawl with no cut rebuilds as a normal completed audit (no status stamped)", async () => {
    const { store, crawlId } = await stored({});
    const report = await run(reconstructReport(store, crawlId));
    expect(report.status).toBeUndefined();
    expect(report.statusReason).toBeUndefined();
  });

  test("a crawl whose scope records a max-duration cut rebuilds as partial with the cut's reason", async () => {
    const { store, crawlId } = await stored({ cut: CUT });
    const report = await run(reconstructReport(store, crawlId));
    expect(report.status).toBe("partial");
    expect(report.statusReason).toBe(maxDurationReason(CUT));
    expect(report.statusReasonCode).toBe("max_duration");
  });
});
