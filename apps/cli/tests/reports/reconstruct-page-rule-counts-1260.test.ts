// #1260: the per-page rule count is a GROUP BY over every stored check, so a report
// rebuilt from the store computes it only when `--include-pages` asked for it.

import type {
  CrawlMetadata,
  PageRecord,
} from "@squirrelscan/core-contracts/storage";

import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { generateJsonReport } from "@/reports/output/json";
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

describe("URLs with no stored page, executed rules (#1396)", () => {
  const front = (
    path: string,
    status: "failed" | "skipped",
    reason: string,
    at: number
  ) => ({
    normalizedUrl: `${SITE}${path}`,
    rawUrl: `${SITE}${path}`,
    depth: 1,
    priority: 0,
    status,
    source: "discovered" as const,
    enqueuedAt: at,
    retryCount: 0,
    reason,
  });

  async function withUnstored() {
    const { store, crawlId } = await storedAudit();
    await run(
      store.upsertFrontier(
        crawlId,
        front("/excluded/a", "skipped", "excluded", 1)
      )
    );
    await run(
      store.upsertFrontier(
        crawlId,
        front("/private/x", "skipped", "robots_disallowed", 2)
      )
    );
    await run(
      store.upsertFrontier(
        crawlId,
        front("/boom", "failed", "connect ECONNREFUSED", 3)
      )
    );
    await run(
      store.upsertFrontier(
        crawlId,
        front("/throttled", "failed", "Rate limited by example.com", 4)
      )
    );
    // A request that failed but whose response was stored is a page, not an unstored URL.
    await run(
      store.upsertFrontier(crawlId, front("/page-1", "failed", "HTTP 503", 5))
    );
    // A rule that only skipped, and one that ran.
    await run(
      store.saveRuleResults(
        crawlId,
        `${SITE}/page-2`,
        "core/meta-description",
        [
          {
            name: "description",
            status: "skipped",
            message: "limit",
            skipReason: "scan-limit",
          } as never,
        ]
      )
    );
    return { store, crawlId };
  }

  test("a default report does not read them", async () => {
    const { store, crawlId } = await withUnstored();
    const spy = spyOn(store, "getUnstoredFrontierEntries");
    const report = await run(reconstructReport(store, crawlId));
    expect(spy).not.toHaveBeenCalled();
    expect(report.unstoredPages).toBeUndefined();
  });

  test("includePageRuleCounts lists an errored fetch, a rate-limited request, an excluded URL and a robots-blocked one", async () => {
    const { store, crawlId } = await withUnstored();
    const report = await run(
      reconstructReport(store, crawlId, undefined, {
        includePageRuleCounts: true,
      })
    );
    expect(report.unstoredPagesTotal).toBe(4);
    const rows = new Map(
      (report.unstoredPages ?? []).map((row) => [
        new URL(row.url).pathname,
        row,
      ])
    );
    expect(rows.get("/excluded/a")).toMatchObject({
      outcome: "skipped",
      reason: "excluded",
    });
    expect(rows.get("/private/x")).toMatchObject({
      outcome: "skipped",
      reason: "robots-disallowed",
    });
    expect(rows.get("/boom")).toMatchObject({
      outcome: "error",
      reason: "connection-refused",
    });
    expect(rows.get("/throttled")).toMatchObject({
      outcome: "error",
      reason: "rate-limited",
    });
    expect(rows.has("/page-1")).toBe(false);
  });

  test("--include-pages JSON lists them after the crawled pages, inside pagesTotal, and executedRules omits a fully skipped rule", async () => {
    const { store, crawlId } = await withUnstored();
    const report = await run(
      reconstructReport(store, crawlId, undefined, {
        includePageRuleCounts: true,
      })
    );
    const dir = mkdtempSync(join(tmpdir(), "sq-1396-"));
    try {
      const out = join(dir, "r.json");
      const err = spyOn(console, "error").mockImplementation(() => {});
      generateJsonReport(report, out, false, true);
      err.mockRestore();
      const json = JSON.parse(readFileSync(out, "utf8")) as {
        meta: { schemaVersion: string };
        pages: Array<{
          url: string;
          outcome: string;
          reason?: string;
          status: number;
        }>;
        pagesTotal: number;
        executedRules?: string[];
      };
      expect(json.meta.schemaVersion).toBe("1.5");
      expect(json.pages).toHaveLength(5 + 4);
      expect(json.pagesTotal).toBe(9);
      expect(
        json.pages.slice(0, 5).every((row) => row.reason === undefined)
      ).toBe(true);
      expect(
        json.pages
          .slice(5)
          .map((row) => row.outcome)
          .sort()
      ).toEqual(["error", "error", "skipped", "skipped"]);
      expect(json.executedRules).toContain("core/meta-title");
      expect(json.executedRules).not.toContain("core/meta-description");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
