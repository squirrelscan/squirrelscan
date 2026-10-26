// `scanScope.unfetched`: the in-scope URLs a crawl had queued and never fetched
// when it stopped. Only `pending` frontier rows count: a fetched, failed,
// skipped (scope, robots) or in-flight URL is not one.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage, type CrawlStorage } from "@squirrelscan/crawler";

import { unfetchedFrontierCount } from "../src";

const BASE = "https://example.com";

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

type Status = "pending" | "fetching" | "done" | "failed" | "skipped";

async function crawlWith(rows: Partial<Record<Status, number>>) {
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
        stats: STATS,
      });
      for (const [status, n] of Object.entries(rows) as Array<[Status, number]>) {
        for (let i = 0; i < n; i++) {
          yield* storage.upsertFrontier(crawlId, {
            normalizedUrl: `${BASE}/${status}/${i}`,
            rawUrl: `${BASE}/${status}/${i}`,
            depth: 1,
            priority: 0,
            status,
            source: i % 2 === 0 ? "discovered" : "sitemap",
            enqueuedAt: 1,
            retryCount: 0,
          });
        }
      }
      // A second crawl's queue in the same database is not this crawl's.
      const other = yield* storage.createCrawl({
        baseUrl: BASE,
        originalUrl: BASE,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: STATS,
      });
      yield* storage.upsertFrontier(other, {
        normalizedUrl: `${BASE}/other`,
        rawUrl: `${BASE}/other`,
        depth: 1,
        priority: 0,
        status: "pending",
        source: "discovered",
        enqueuedAt: 1,
        retryCount: 0,
      });
      return yield* unfetchedFrontierCount(storage, crawlId);
    }),
  );
}

describe("unfetchedFrontierCount", () => {
  test("counts only the URLs still queued", async () => {
    const count = await crawlWith({ pending: 7, fetching: 2, done: 20, failed: 3, skipped: 5 });
    expect(count).toBe(7);
  });

  test("a drained crawl has none", async () => {
    expect(await crawlWith({ done: 20, skipped: 4 })).toBe(0);
  });

  test("a failed read counts as none instead of failing the report", async () => {
    const broken = {
      getPendingCount: () => Effect.fail(new Error("db gone")),
    } as unknown as CrawlStorage;
    expect(await Effect.runPromise(unfetchedFrontierCount(broken, "crawl"))).toBe(0);
  });
});
