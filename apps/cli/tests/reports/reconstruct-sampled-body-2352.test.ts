// repo#2352: a crawl past the check cap gets a sampled report body: the same score,
// totals and issue classes as the full body, no per-page check lists, and a payload
// field saying so. `fullBody` and a small crawl keep the full body.

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

async function storedAudit(pages: number, rowsPerPage: number) {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      config: { maxPages: pages } as CrawlMetadata["config"],
      stats: { ...STATS, pagesTotal: pages, pagesFetched: pages },
    })
  );
  for (let n = 1; n <= pages; n++) {
    await run(store.upsertPage(crawlId, page(n)));
    for (let r = 0; r < rowsPerPage; r++) {
      await run(
        store.saveRuleResults(crawlId, `${SITE}/page-${n}`, "core/meta-title", [
          n % 3 === 0
            ? {
                name: `title-${r}`,
                status: "fail",
                message: "Title missing",
              }
            : { name: `title-${r}`, status: "pass", message: "Title present" },
        ])
      );
    }
  }
  return { store, crawlId };
}

describe("sampled report body (repo#2352)", () => {
  test("a crawl over the cap keeps score and totals, drops page checks, and says so", async () => {
    const { store, crawlId } = await storedAudit(30, 2);
    const full = await run(reconstructReport(store, crawlId));
    const sampled = await run(
      reconstructReport(store, crawlId, undefined, { fullBodyMaxChecks: 10 })
    );
    expect(full.reportBody).toBeUndefined();
    expect(full.pages.some((p) => p.checks.length > 0)).toBe(true);

    expect(sampled.healthScore).toEqual(full.healthScore);
    expect(sampled.passed).toBe(full.passed);
    expect(sampled.warnings).toBe(full.warnings);
    expect(sampled.failed).toBe(full.failed);
    expect(sampled.totalPages).toBe(full.totalPages);
    expect(sampled.pages).toHaveLength(full.pages.length);
    expect(sampled.pages.every((p) => p.checks.length === 0)).toBe(true);
    expect(sampled.reportBody).toMatchObject({
      mode: "sampled",
      totalChecks: 60,
      pageChecksOmitted: true,
    });
    expect(sampled.reportBody?.reason).toContain("--full-report");
  });

  test("a rule over the per-rule cap is folded and the cut is recorded on the check", async () => {
    const { store, crawlId } = await storedAudit(30, 20);
    const sampled = await run(
      reconstructReport(store, crawlId, undefined, { fullBodyMaxChecks: 10 })
    );
    const checks = sampled.ruleResults["core/meta-title"]!.checks;
    expect(checks.length).toBeLessThan(600);
    expect(sampled.reportBody!.keptChecks).toBe(checks.length);
    expect(sampled.reportBody!.rulesFolded).toBe(1);
    const full = await run(reconstructReport(store, crawlId));
    expect(sampled.failed).toBe(full.failed);
    expect(sampled.passed).toBe(full.passed);
  });

  test("fullBody and a crawl under the cap build the whole body", async () => {
    const { store, crawlId } = await storedAudit(6, 1);
    const under = await run(reconstructReport(store, crawlId));
    const forced = await run(
      reconstructReport(store, crawlId, undefined, {
        fullBodyMaxChecks: 1,
        fullBody: true,
      })
    );
    expect(under.reportBody).toBeUndefined();
    expect(forced.reportBody).toBeUndefined();
    expect(forced.pages).toEqual(under.pages);
  });
});
