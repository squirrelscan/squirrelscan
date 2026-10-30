// #1260: the per-page rule count is a GROUP BY over every stored check, so a report
// rebuilt from the store computes it only when `--include-pages` asked for it.

import type {
  CrawlMetadata,
  PageRecord,
} from "@squirrelscan/core-contracts/storage";

import { describe, expect, spyOn, test } from "bun:test";
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

async function storedAudit() {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      // maxPages is present on old crawl records too. Its presence must not be
      // mistaken for proof that every other scan-scope field was recorded.
      config: { maxPages: 5 } as CrawlMetadata["config"],
      stats: STATS,
    })
  );
  for (let n = 1; n <= 5; n++) {
    await run(store.upsertPage(crawlId, page(n)));
  }
  await run(
    store.saveRuleResults(crawlId, `${SITE}/page-1`, "core/meta-title", [
      { name: "title-present", status: "pass", message: "Title present" },
    ])
  );
  return { store, crawlId };
}

describe("per-page rule counts (#1260)", () => {
  test("a default report does not run the count and carries no ruleCount", async () => {
    const { store, crawlId } = await storedAudit();
    const spy = spyOn(store, "getRuleCountsByPage");
    const report = await run(reconstructReport(store, crawlId));
    expect(spy).not.toHaveBeenCalled();
    expect(report.pages.every((p) => p.ruleCount === undefined)).toBe(true);
  });

  test("includePageRuleCounts runs it once and fills each page", async () => {
    const { store, crawlId } = await storedAudit();
    const spy = spyOn(store, "getRuleCountsByPage");
    const report = await run(
      reconstructReport(store, crawlId, undefined, {
        includePageRuleCounts: true,
      })
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const byUrl = new Map(report.pages.map((p) => [p.url, p.ruleCount]));
    expect(byUrl.get(`${SITE}/page-1`)).toBe(1);
    expect(byUrl.get(`${SITE}/page-2`)).toBe(0);
  });
});
