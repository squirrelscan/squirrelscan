// The storage statements a crawl runs PER PAGE must be cached (#1911).
//
// `db.query(sql)` caches the compiled statement by SQL text; `db.prepare(sql)`
// compiles a new one every call. The storage layer used `prepare` in all 116
// places, so every operation re-parsed its SQL. #247 converted the per-link
// frontier existence check; a census of a real crawl
// (scripts/statement-compile-census.ts) then showed exactly four statements
// left running once per page and every other one running once per crawl.
//
// This pins those four. It counts COMPILATIONS rather than timing anything: the
// saving is about 2.2 us per compilation, which is far too small to assert on a
// clock and far too easy to assert on by accident. A regression to `prepare`
// shows up here as one compile per call instead of one per suite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";

import type { CrawlMetadata, FrontierRecord, PageRecord } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CONFIG: CrawlMetadata["config"] = {
  maxPages: 100,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 1000,
  userAgent: "test",
  followRedirects: true,
  respectRobots: false,
  incremental: false,
  include: [],
  exclude: [],
  allowQueryParams: [],
  dropQueryPrefixes: [],
  allowedDomains: [],
} as CrawlMetadata["config"];

const STATS: CrawlMetadata["stats"] = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
} as CrawlMetadata["stats"];

async function freshCrawl(): Promise<{ store: SQLiteStorage; crawlId: string }> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: "http://example.test",
      seedUrl: "http://example.test",
      originalUrl: "http://example.test",
      startedAt: 1,
      status: "running",
      config: CONFIG,
      stats: STATS,
    } as Omit<CrawlMetadata, "id">),
  );
  return { store, crawlId };
}

function page(crawlId: string, i: number): PageRecord {
  return {
    url: `http://example.test/p/${i}`,
    normalizedUrl: `http://example.test/p/${i}`,
    finalUrl: `http://example.test/p/${i}`,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h${i}`,
    html: "<html></html>",
    parsedData: null,
    headers: {},
    securityHeaders: {},
  } as unknown as PageRecord;
}

function frontier(i: number): FrontierRecord {
  return {
    normalizedUrl: `http://example.test/f/${i}`,
    rawUrl: `http://example.test/f/${i}`,
    depth: 1,
    priority: 1,
    status: "pending",
    source: "discovered",
    enqueuedAt: 1,
    retryCount: 0,
  } as unknown as FrontierRecord;
}

/** Compilations that happen while `body` runs, counted on the prototype. */
async function compilationsDuring(body: () => Promise<void>): Promise<number> {
  let compiles = 0;
  const real = Database.prototype.prepare;
  (Database.prototype as unknown as Record<string, unknown>).prepare = function patched(
    this: Database,
    ...args: unknown[]
  ) {
    compiles++;
    return (real as (this: Database, ...a: unknown[]) => unknown).call(this, ...args);
  };
  try {
    await body();
  } finally {
    (Database.prototype as unknown as Record<string, unknown>).prepare = real;
  }
  return compiles;
}

describe("per-page storage statements are cached", () => {
  const N = 50;

  test("upsertPage compiles once, not once per page", async () => {
    const { store, crawlId } = await freshCrawl();
    // Warm first: the first call of anything also compiles whatever the method
    // touches on its way in, and counting that would hide the thing being
    // asserted behind a constant.
    await run(store.upsertPage(crawlId, page(crawlId, 0)));
    const compiles = await compilationsDuring(async () => {
      for (let i = 1; i <= N; i++) await run(store.upsertPage(crawlId, page(crawlId, i)));
    });
    expect(compiles).toBe(0);
    expect(await run(store.getPageCount(crawlId))).toBe(N + 1);
    await run(store.close());
  });

  test("upsertFrontier compiles once, not once per discovered url", async () => {
    const { store, crawlId } = await freshCrawl();
    await run(store.upsertFrontier(crawlId, frontier(0)));
    const compiles = await compilationsDuring(async () => {
      for (let i = 1; i <= N; i++) await run(store.upsertFrontier(crawlId, frontier(i)));
    });
    expect(compiles).toBe(0);
    await run(store.close());
  });

  test("getIncomingLinkCount compiles once, not once per url", async () => {
    const { store, crawlId } = await freshCrawl();
    await run(store.getIncomingLinkCount(crawlId, "http://example.test/p/0"));
    const compiles = await compilationsDuring(async () => {
      for (let i = 1; i <= N; i++) {
        await run(store.getIncomingLinkCount(crawlId, `http://example.test/p/${i}`));
      }
    });
    expect(compiles).toBe(0);
    await run(store.close());
  });

  test("the crawl stats write compiles once, not once per page", async () => {
    const { store, crawlId } = await freshCrawl();
    // Always the same SET clause, which is what the crawl loop emits. A caller
    // that varied the updated columns would legitimately compile one statement
    // per distinct shape; that set is bounded by the eight optional columns.
    await run(store.updateCrawl(crawlId, { stats: STATS }));
    const compiles = await compilationsDuring(async () => {
      for (let i = 1; i <= N; i++) {
        await run(store.updateCrawl(crawlId, { stats: { ...STATS, pagesFetched: i } }));
      }
    });
    expect(compiles).toBe(0);
    await run(store.close());
  });

  test("a whole crawl's storage work does not compile per page", async () => {
    // The four above in one loop, which is the shape the crawl loop runs them
    // in. Asserted as a total rather than per method so a NEW per-page
    // statement added later fails here too, which is the regression this is
    // actually guarding against.
    const { store, crawlId } = await freshCrawl();
    const oneRound = async (i: number) => {
      await run(store.upsertFrontier(crawlId, frontier(i)));
      await run(store.getIncomingLinkCount(crawlId, `http://example.test/p/${i}`));
      await run(store.upsertPage(crawlId, page(crawlId, i)));
      await run(store.updateCrawl(crawlId, { stats: { ...STATS, pagesFetched: i } }));
    };
    await oneRound(0);
    const compiles = await compilationsDuring(async () => {
      for (let i = 1; i <= N; i++) await oneRound(i);
    });
    expect(compiles).toBe(0);
    await run(store.close());
  });
});
