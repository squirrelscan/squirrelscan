// The storage statements a crawl runs PER PAGE must be cached (#1911).
//
// `db.query(sql)` caches the compiled statement by SQL text; `db.prepare(sql)`
// compiles a new one every call. The storage layer used `prepare` in all 116
// places, so every operation re-parsed its SQL. #247 converted the per-link
// frontier existence check; a census of a real crawl
// (scripts/statement-compile-census.ts) then showed exactly four statements
// left running once per page and every other one running once per crawl.
//
// This pins those five. It asserts on COMPILATION rather than on a clock: the
// saving is tens of microseconds per page, far too small to assert on time and
// far too easy to assert on by accident.
//
// TWO assertions are needed, and the first alone is not enough. Counting calls
// to `Database.prototype.prepare` catches a regression BACK to `prepare` — and
// only that. `db.query` compiles through an internal path that a hook on
// `prepare` never sees, so a suite that only counts `prepare` passes just as
// happily with the statement cache disabled entirely. The second assertion
// tests the mechanism directly: `db.query` must hand back the SAME statement
// object for the same SQL text on the Bun actually running.

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

  test("db.query really caches on this Bun, which the counters assume", () => {
    // The counters below prove the code no longer calls `prepare`. They cannot
    // prove `query` caches, because its compilation is invisible to them. If
    // this ever fails, every other test in this file is passing for free.
    const db = new Database(":memory:");
    db.run("CREATE TABLE t (a TEXT)");
    const sql = "SELECT a FROM t WHERE a = ?";
    expect(db.query(sql)).toBe(db.query(sql));
    // Different text is a different statement, which is what makes the cache a
    // cache rather than a single slot.
    expect(db.query(sql)).not.toBe(db.query("SELECT a FROM t WHERE a != ?"));
    db.close();
  });

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

  test("getCachedPage compiles once, not once per url on the incremental path", async () => {
    // The CLI defaults `incremental` to true, so this runs once per URL on the
    // path most audits take. A census run with incremental off does not see it,
    // which is how it was missed the first time.
    const { store, crawlId } = await freshCrawl();
    await run(store.getCachedPage("http://example.test/p/0"));
    const compiles = await compilationsDuring(async () => {
      for (let i = 1; i <= N; i++) await run(store.getCachedPage(`http://example.test/p/${i}`));
    });
    expect(compiles).toBe(0);
    expect(crawlId).toBeTruthy();
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

  test("the converted methods together compile nothing per round", async () => {
    // The converted methods in one loop, in the shape the crawl loop runs them.
    //
    // This does NOT catch a new per-page statement added elsewhere in the
    // storage layer: it only calls these methods, so a `prepare` introduced in,
    // say, updateFrontierStatus passes here untouched (I checked). The guard
    // for that is scripts/statement-compile-census.ts, which drives a real
    // crawl and counts everything; this test is the fast regression pin for the
    // five that census already found.
    const { store, crawlId } = await freshCrawl();
    const oneRound = async (i: number) => {
      await run(store.upsertFrontier(crawlId, frontier(i)));
      await run(store.getIncomingLinkCount(crawlId, `http://example.test/p/${i}`));
      await run(store.getCachedPage(`http://example.test/p/${i}`));
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
