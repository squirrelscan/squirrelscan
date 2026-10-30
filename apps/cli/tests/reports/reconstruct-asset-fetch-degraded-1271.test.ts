// #1271: a `--max-duration` run that cuts the resource checks stores the engine's own
// `crawl/asset-fetch-degraded` note. It is not a registry rule, so the report build must not
// warn about it, and the note must reach the report.

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
    store.saveRuleResults(crawlId, "", "crawl/asset-fetch-degraded", [
      {
        name: "asset-fetch-degraded",
        status: "info",
        message:
          "Resource fetching was cut short by the resource-fetch time budget: 197 asset request(s) skipped. Some size/script findings may be incomplete.",
      },
    ])
  );
  return { store, crawlId };
}

describe("the asset-fetch-degraded note (#1271)", () => {
  test("is in the report, with no registry warning", async () => {
    const { store, crawlId } = await storedAudit();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const report = await run(reconstructReport(store, crawlId));
      expect(warn.mock.calls.flat().join(" ")).not.toContain(
        "Rule not found in registry"
      );
      const rule = report.ruleResults["crawl/asset-fetch-degraded"];
      expect(rule?.checks[0]?.message).toContain(
        "Resource fetching was cut short by the resource-fetch time budget"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
