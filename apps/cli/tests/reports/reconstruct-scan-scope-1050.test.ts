// repo#1050: a report rebuilt from the project database must carry the exact
// scan scope the original audit printed. Deriving it later is not equivalent:
// the later process cannot know the original runner or requested (pre-clamp)
// page limit, and the frontier can change after the report is produced.

import type {
  CrawlMetadata,
  PageRecord,
} from "@squirrelscan/core-contracts/storage";

import { renderJson } from "@squirrelscan/report";
import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { generateConsoleReport } from "@/reports/output/console";
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

function consoleOutput(report: Awaited<ReturnType<typeof rebuilt>>): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

async function rebuilt(store: SQLiteStorage, crawlId: string) {
  return run(reconstructReport(store, crawlId));
}

describe("database report scan scope (#1050)", () => {
  test("restores the capped scope in the scan line and JSON metadata", async () => {
    const { store, crawlId } = await storedAudit();
    const scope = {
      origin: "ci" as const,
      maxPages: 5,
      requestedMaxPages: 10_000,
      pagesCrawled: 5,
      capped: true,
      unfetched: 4,
    };
    await run(store.updateCrawl(crawlId, { scanScope: scope }));

    const report = await rebuilt(store, crawlId);
    expect(report.scanScope).toEqual(scope);
    expect(consoleOutput(report)).toContain(
      "Scan: 5 pages crawled from CI (page limit 5 of 10000 requested, reached; 4 more discovered but not fetched)."
    );

    const json = JSON.parse(renderJson(report));
    expect(json.meta.maxPages).toBe(5);
    expect(json.meta.requestedMaxPages).toBe(10_000);
    expect(json.meta.unfetched).toBe(4);
    await run(store.close());
  });

  test("does not invent a scope for an older crawl", async () => {
    const { store, crawlId } = await storedAudit();
    const report = await rebuilt(store, crawlId);

    expect(report.scanScope).toBeUndefined();
    expect(consoleOutput(report)).not.toContain("Scan:");
    const json = JSON.parse(renderJson(report));
    expect(json.meta.maxPages).toBeUndefined();
    expect(json.meta.unfetched).toBeUndefined();
    await run(store.close());
  });
});
