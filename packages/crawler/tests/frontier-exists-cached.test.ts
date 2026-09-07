// hasFrontierEntry — the enqueue path asks "is this URL already known?" once
// per discovered link, roughly 50x per page on a link-dense site. It must
// answer that without selecting or materialising the whole frontier row, and
// it must agree with getFrontierEntry (which the watchdog path still needs for
// `status`).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlMetadata, FrontierRecord } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

async function freshCrawl(store: SQLiteStorage, baseUrl: string): Promise<string> {
  const meta: Omit<CrawlMetadata, "id"> = {
    baseUrl,
    startedAt: 1,
    status: "running",
    config: {
      maxPages: 100,
      concurrency: 10,
      perHostConcurrency: 2,
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
    },
    stats: {
      pagesTotal: 0,
      pagesFetched: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
      pagesUnchanged: 0,
      linksTotal: 0,
      imagesTotal: 0,
      bytesTotal: 0,
      avgLoadTimeMs: 0,
    },
  };
  return run(store.createCrawl(meta));
}

async function seed(
  store: SQLiteStorage,
  crawlId: string,
  url: string,
  status: FrontierRecord["status"] = "pending"
): Promise<void> {
  const entry: FrontierRecord = {
    normalizedUrl: url,
    rawUrl: `${url}?utm_source=x`,
    depth: 2,
    priority: 0,
    status,
    source: "discovered",
    enqueuedAt: 1,
    retryCount: 0,
  };
  await run(store.upsertFrontier(crawlId, entry));
}

describe("hasFrontierEntry", () => {
  test("reports presence and absence", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store, "https://example.com");
    await seed(store, crawlId, "https://example.com/known");

    expect(await run(store.hasFrontierEntry(crawlId, "https://example.com/known"))).toBe(true);
    expect(await run(store.hasFrontierEntry(crawlId, "https://example.com/unknown"))).toBe(false);
    store.close();
  });

  test("agrees with getFrontierEntry across every status", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store, "https://example.com");
    const statuses: FrontierRecord["status"][] = [
      "pending",
      "fetching",
      "done",
      "failed",
      "skipped",
    ];

    for (const status of statuses) {
      const url = `https://example.com/${status}`;
      await seed(store, crawlId, url, status);
      const record = await run(store.getFrontierEntry(crawlId, url));
      const exists = await run(store.hasFrontierEntry(crawlId, url));
      // An entry is "already known" regardless of how its fetch turned out;
      // treating a failed/skipped URL as unknown would re-enqueue it forever.
      expect(exists).toBe(record !== null);
      expect(exists).toBe(true);
    }
    store.close();
  });

  test("is scoped to its crawl", async () => {
    const store = await freshStore();
    const crawlA = await freshCrawl(store, "https://a.example.com");
    const crawlB = await freshCrawl(store, "https://b.example.com");
    const url = "https://a.example.com/only-in-a";
    await seed(store, crawlA, url);

    expect(await run(store.hasFrontierEntry(crawlA, url))).toBe(true);
    expect(await run(store.hasFrontierEntry(crawlB, url))).toBe(false);
    store.close();
  });

  test("reuses one cached statement instead of compiling per call", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store, "https://example.com");
    await seed(store, crawlId, "https://example.com/known");

    // The whole point of this path is that it is called once per discovered
    // link. Count compilations: db.query caches by SQL text, db.prepare does
    // not, so a regression to prepare shows up here as one compile per call.
    const db = (store as unknown as { getDb: () => import("bun:sqlite").Database }).getDb();
    let compiles = 0;
    const realPrepare = db.prepare.bind(db);
    const realQuery = db.query.bind(db);
    db.prepare = (sql: string) => {
      compiles++;
      return realPrepare(sql);
    };
    db.query = (sql: string) => realQuery(sql);

    for (let i = 0; i < 200; i++) {
      await run(store.hasFrontierEntry(crawlId, "https://example.com/known"));
    }

    // db.query compiles once and caches; db.prepare would compile 200 times.
    expect(compiles).toBeLessThanOrEqual(1);
    store.close();
  });
});
