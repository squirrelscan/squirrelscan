// The crawl-phase backstop makes a run partial with code crawl_timeout (#1639).
import type { CrawlMetadata, PageRecord } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  reconstructReport,
  stampCrawlPhaseCut,
  withCrawlPhaseCut,
} from "../../src/reports/reconstruct";

const cut = {
  seconds: 1800,
  pagesCollected: 1568,
  pageBudget: 4000,
  unfetchedPages: 2345,
  linkGraphComplete: false as const,
};

describe("withCrawlPhaseCut", () => {
  test("completed becomes partial with crawl_timeout and coverage in the reason", () => {
    const out = withCrawlPhaseCut(
      { status: "completed", reason: undefined, reasonCode: undefined },
      cut
    );
    expect(out.status).toBe("partial");
    expect(out.reasonCode).toBe("crawl_timeout");
    expect(out.reason).toContain("1568 pages");
    expect(out.reason).toContain("link graph is incomplete");
  });

  test("an already failed or partial run keeps its own status", () => {
    const failed = withCrawlPhaseCut(
      { status: "failed", reason: "dns", reasonCode: "dns" },
      cut
    );
    expect(failed.status).toBe("failed");
    const partial = withCrawlPhaseCut(
      { status: "partial", reason: "max", reasonCode: "max_duration" },
      cut
    );
    expect(partial.reasonCode).toBe("max_duration");
  });

  test("no cut leaves the status alone", () => {
    expect(withCrawlPhaseCut({ status: undefined }, undefined).status).toBe(
      "completed"
    );
  });
});

describe("stampCrawlPhaseCut (the live run's stamping)", () => {
  const input = {
    seconds: 1800,
    pagesCollected: 1568,
    pageBudget: 4000,
    unfetchedPages: 2345,
  };

  test("a completed run gets crawlPhase on report and scope, and turns partial", () => {
    const report: Parameters<typeof stampCrawlPhaseCut>[0] = {
      status: "completed",
    };
    const scope: { crawlPhase?: typeof cut } = {};
    const out = stampCrawlPhaseCut(report, scope, input);
    expect(out).toEqual(cut);
    expect(report.crawlPhase).toEqual(cut);
    expect(scope.crawlPhase).toEqual(cut);
    expect(report.status).toBe("partial");
    expect(report.statusReasonCode).toBe("crawl_timeout");
    expect(report.statusReason).toContain("1568 pages");
  });

  test("an already partial run keeps its own reason but still records the cut", () => {
    const report: Parameters<typeof stampCrawlPhaseCut>[0] = {
      status: "partial",
      statusReason: "time limit",
      statusReasonCode: "max_duration",
    };
    stampCrawlPhaseCut(report, {}, input);
    expect(report.statusReasonCode).toBe("max_duration");
    expect(report.statusReason).toBe("time limit");
    expect(report.crawlPhase?.linkGraphComplete).toBe(false);
  });

  test("no page budget leaves pageBudget out", () => {
    const out = stampCrawlPhaseCut({}, {}, { ...input, pageBudget: 0 });
    expect("pageBudget" in out).toBe(false);
  });
});

describe("reconstructReport restores the crawl-phase cut from the scan scope", () => {
  const run = <A>(e: Effect.Effect<A, unknown, never>): Promise<A> =>
    Effect.runPromise(Effect.orDie(e));
  const STATS = {
    pagesTotal: 1,
    pagesFetched: 1,
    pagesFailed: 0,
    pagesSkipped: 0,
    pagesUnchanged: 0,
    linksTotal: 0,
    imagesTotal: 0,
    bytesTotal: 0,
    avgLoadTimeMs: 0,
  };

  async function stored(withCut: boolean) {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await run(
      store.createCrawl({
        baseUrl: "https://example.com",
        originalUrl: "https://example.com",
        startedAt: 1,
        status: "analyzed",
        config: { maxPages: 5 } as CrawlMetadata["config"],
        stats: STATS,
        ...(withCut
          ? { scanScope: { crawlPhase: cut } as CrawlMetadata["scanScope"] }
          : {}),
      })
    );
    const url = "https://example.com/";
    const html =
      "<html><head><title>Home</title></head><body>Home</body></html>";
    await run(
      store.upsertPage(crawlId, {
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
        contentHash: "home",
        html,
        parsedData: null,
        headers: {
          contentType: null,
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
      } as unknown as PageRecord)
    );
    return { store, crawlId };
  }

  test("a stored crawlPhase cut rebuilds as partial crawl_timeout with report.crawlPhase", async () => {
    const { store, crawlId } = await stored(true);
    const report = await run(reconstructReport(store, crawlId));
    expect(report.status).toBe("partial");
    expect(report.statusReasonCode).toBe("crawl_timeout");
    expect(report.crawlPhase).toEqual(cut);
  });

  test("no stored cut adds neither a status nor crawlPhase", async () => {
    const { store, crawlId } = await stored(false);
    const report = await run(reconstructReport(store, crawlId));
    expect(report.status).toBeUndefined();
    expect(report.crawlPhase).toBeUndefined();
  });
});
