// Audit-validity status on the reconstruct path (#489 / #510). A smart
// re-audit reflects carried state when it fetched nothing fresh, but a FIRST
// smart run with no carried data + 0 pages must not pose as "completed".

import type { PageRecord } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import {
  reconstructReport,
  type SmartMergeOverride,
} from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  // orDie keeps setup failures as legible defects instead of opaque rejections.
  return Effect.runPromise(Effect.orDie(eff));
}

async function freshCrawl(pages: PageRecord[]): Promise<{
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

function page(status: number, path = "/"): PageRecord {
  const url = `${SITE}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status,
    contentType: "text/html",
    sizeBytes: 0,
    loadTimeMs: 0,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: path,
    html: null,
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

function smartMerge(
  coverage: SmartMergeOverride["coverage"]
): SmartMergeOverride {
  return {
    unionRuleResults: new Map<string, RuleRunResult>(),
    coverage,
    carriedLastSeen: new Map<string, number>(),
  };
}

// `report.status` is stamped only on non-completed runs (#489), so an
// undefined status === completed in the assertions below.
describe("reconstructReport audit status (#510)", () => {
  test("smart first run, 0 fresh pages + 0 carried → failed, not completed", async () => {
    const { store, crawlId } = await freshCrawl([]);
    const report = await run(
      reconstructReport(
        store,
        crawlId,
        smartMerge({ auditedPages: 0, knownPages: 0, carriedFindings: 0 })
      )
    );
    expect(report.status).toBe("failed");
    expect(report.statusReason).toBeTruthy();
    await run(store.close());
  });

  test("smart first run, only blocked pages + 0 carried → blocked, not completed", async () => {
    const { store, crawlId } = await freshCrawl([page(403)]);
    const report = await run(
      reconstructReport(
        store,
        crawlId,
        smartMerge({ auditedPages: 1, knownPages: 1, carriedFindings: 0 })
      )
    );
    expect(report.status).toBe("blocked");
    expect(report.statusReason).toBeTruthy();
    await run(store.close());
  });

  // Carried pages (knownPages > auditedPages) — even all-clean, 0 carried
  // findings — mean prior known state: a site that went down stays completed.
  test("smart re-audit, 0 fresh pages but carried pages → stays completed", async () => {
    const { store, crawlId } = await freshCrawl([]);
    const report = await run(
      reconstructReport(
        store,
        crawlId,
        smartMerge({ auditedPages: 0, knownPages: 50, carriedFindings: 0 })
      )
    );
    expect(report.status).toBeUndefined();
    await run(store.close());
  });

  test("smart partial re-audit, fresh subset + carried data → stays completed", async () => {
    const { store, crawlId } = await freshCrawl([page(200)]);
    const report = await run(
      reconstructReport(
        store,
        crawlId,
        smartMerge({ auditedPages: 1, knownPages: 50, carriedFindings: 10 })
      )
    );
    expect(report.status).toBeUndefined();
    await run(store.close());
  });

  // Fallthrough: both carry-data operands false, so status comes from runStatus
  // (real content this run) rather than the smart short-circuit.
  test("smart full re-audit, all pages re-crawled 200 → completed via runStatus", async () => {
    const { store, crawlId } = await freshCrawl([
      page(200, "/a"),
      page(200, "/b"),
    ]);
    const report = await run(
      reconstructReport(
        store,
        crawlId,
        smartMerge({ auditedPages: 2, knownPages: 2, carriedFindings: 0 })
      )
    );
    expect(report.status).toBeUndefined();
    await run(store.close());
  });

  // Fallthrough complement: all known pages re-crawled but now 403, nothing
  // carried → blocked via runStatus (not masked as completed).
  test("smart full re-audit, all pages re-crawled 403 → blocked via runStatus", async () => {
    const { store, crawlId } = await freshCrawl([
      page(403, "/a"),
      page(403, "/b"),
    ]);
    const report = await run(
      reconstructReport(
        store,
        crawlId,
        smartMerge({ auditedPages: 2, knownPages: 2, carriedFindings: 0 })
      )
    );
    expect(report.status).toBe("blocked");
    expect(report.statusReason).toBeTruthy();
    await run(store.close());
  });

  test("non-smart 0-page run still flagged failed (#489, no regression)", async () => {
    const { store, crawlId } = await freshCrawl([]);
    const report = await run(reconstructReport(store, crawlId, undefined));
    expect(report.status).toBe("failed");
    expect(report.statusReason).toBeTruthy();
    await run(store.close());
  });
});
