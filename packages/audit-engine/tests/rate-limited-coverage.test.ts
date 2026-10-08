// A crawl that a host rate limits must say so in the summary, with how much it
// lost, and must not read as a complete run. Driven through both report
// assemblers over real crawl storage, plus the coverage the cloud merge reports.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import type { PageRecord, SitePageRecord } from "@squirrelscan/core-contracts";

import { generateReportFromStorage } from "../src/adapter";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import {
  buildV2Report,
  emptyRuleExecutionResult,
  type StreamingReportInput,
} from "../src/report-stream";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

const BASE = "https://shop.example.com";

const STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function pageRow(path: string): PageRecord {
  const url = `${BASE}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: 128,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h${path}`,
    html: "<html></html>",
    parsedData: JSON.stringify({ links: [] }),
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

/**
 * A crawl in the shape the issue reports: a few pages fetched, a pile of URLs
 * the host answered 429 until the crawler gave up on them, and more still
 * queued when it stopped.
 */
async function throttledCrawl(opts: { rateLimited: number; pending: number }) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        originalUrl: BASE,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {
          ...STATS,
          pagesFetched: 3,
          pagesFailed: opts.rateLimited,
          pagesRateLimited: opts.rateLimited,
        },
      });
      for (const path of ["/", "/a", "/b"]) yield* storage.upsertPage(crawlId, pageRow(path));
      for (let i = 0; i < opts.pending; i++) {
        yield* storage.upsertFrontier(crawlId, {
          normalizedUrl: `${BASE}/queued/${i}`,
          rawUrl: `${BASE}/queued/${i}`,
          depth: 2,
          priority: 0,
          status: "pending",
          source: "discovered",
          enqueuedAt: 1,
          retryCount: 0,
        });
      }
      const input: StreamingReportInput = { ...emptyRuleExecutionResult(), tallies: new Map() };
      const v1 = yield* generateReportFromStorage(storage, crawlId, emptyRuleExecutionResult());
      const v2 = yield* buildV2Report(storage, crawlId, input);
      return { v1, v2 };
    }),
  );
}

describe("rate-limited crawl summary", () => {
  test("both assemblers report the failed and pending counts and a partial status", async () => {
    const { v1, v2 } = await throttledCrawl({ rateLimited: 437, pending: 918 });

    for (const report of [v1, v2]) {
      expect(report.status).toBe("partial");
      expect(report.rateLimited).toEqual({
        pages: 437,
        hosts: ["shop.example.com"],
        // The abandoned URLs and the still-queued ones, which are disjoint.
        unfetched: 437 + 918,
      });
      expect(report.statusReason).toContain("437 pages rate limited by shop.example.com");
      expect(report.statusReason).toContain("1355 more discovered but not fetched");
    }
  });

  test("an unthrottled crawl carries no rate-limit block, even with URLs still queued", async () => {
    const { v1, v2 } = await throttledCrawl({ rateLimited: 0, pending: 40 });

    for (const report of [v1, v2]) {
      expect(report.rateLimited).toBeUndefined();
      expect(report.status).toBeUndefined();
    }
  });
});

/** No findings; its site pages are a keyed upsert, as the store contract requires. */
class EmptyStore implements SmartAuditStore {
  private readonly pages = new Map<string, SitePageRecord>();
  async getFindings() {
    return [];
  }
  async getSitePages() {
    return [...this.pages.values()];
  }
  async upsertFindings() {}
  async upsertSitePages(pages: SitePageRecord[]) {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved() {}
  async markPagesRemoved() {}
  async compactFindings() {
    return 0;
  }
}

describe("coverage of a rate-limited run", () => {
  const crawled = ["/", "/a", "/b"].map((path) => ({ url: `${BASE}${path}`, status: 200 }));
  const run = (unfetchedPages?: number) =>
    runCloudSmartAudits({
      store: new EmptyStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {},
      pageStatuses: crawled,
      ...(unfetchedPages === undefined ? {} : { unfetchedPages }),
    });

  test("known pages include the URLs the run never fetched", async () => {
    const { coverage } = await run(1355);
    expect(coverage.auditedPages).toBe(3);
    expect(coverage.knownPages).toBe(3 + 1355);
    expect(coverage.auditedPages).toBeLessThan(coverage.knownPages);
  });

  test("without a throttle the coverage is unchanged", async () => {
    for (const none of [undefined, 0]) {
      const { coverage } = await run(none);
      expect(coverage).toEqual({ auditedPages: 3, knownPages: 3, carriedFindings: 0 });
    }
  });
});

describeSitePagesContract("rate-limited-coverage.test.ts EmptyStore", () => new EmptyStore());
