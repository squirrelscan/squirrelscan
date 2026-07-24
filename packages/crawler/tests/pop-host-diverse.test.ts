// #440 — popNextUrls caps URLs per host within a batch so a single busy host
// can't fill the batch while its per-host throttle stalls the extra workers.
// Multi-host batches diversify; single-host batches are returned untouched.

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

async function freshCrawl(store: SQLiteStorage): Promise<string> {
  const meta: Omit<CrawlMetadata, "id"> = {
    baseUrl: "https://a.example.com",
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

// Seed a pending frontier entry. `priority` ascending = higher priority first.
async function seed(
  store: SQLiteStorage,
  crawlId: string,
  url: string,
  priority: number
): Promise<void> {
  const entry: FrontierRecord = {
    normalizedUrl: url,
    rawUrl: url,
    depth: 0,
    priority,
    status: "pending",
    source: "discovered",
    enqueuedAt: 1,
    retryCount: 0,
  };
  await run(store.upsertFrontier(crawlId, entry));
}

function hostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

function countByHost(records: FrontierRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const h = hostOf(r.normalizedUrl);
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return counts;
}

describe("popNextUrls per-host batch diversity (#440)", () => {
  test("caps URLs per host when a batch spans multiple hosts", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);

    // Host A dominates the top of the frontier (highest priority), host B/C
    // trail. Without the cap the batch would be all host A.
    for (let i = 0; i < 6; i++) {
      await seed(store, crawlId, `https://a.example.com/${i}`, i);
    }
    for (let i = 0; i < 3; i++) {
      await seed(store, crawlId, `https://b.example.com/${i}`, 10 + i);
    }
    for (let i = 0; i < 3; i++) {
      await seed(store, crawlId, `https://c.example.com/${i}`, 20 + i);
    }

    const batch = await run(store.popNextUrls(crawlId, 10, 2));
    const counts = countByHost(batch);

    // No host contributes more than perHostConcurrency (2).
    for (const [, n] of counts) {
      expect(n).toBeLessThanOrEqual(2);
    }
    // Diversity pulls in the trailing hosts instead of only host A.
    expect(counts.size).toBeGreaterThan(1);

    // Only the returned subset is marked fetching; the rest stay pending.
    const fetching = await run(store.getFetchingCount(crawlId));
    expect(fetching).toBe(batch.length);
    const pending = await run(store.getPendingCount(crawlId));
    expect(pending).toBe(12 - batch.length);

    await run(store.close());
  });

  test("leaves a single-host batch untouched (no churn)", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);

    for (let i = 0; i < 8; i++) {
      await seed(store, crawlId, `https://a.example.com/${i}`, i);
    }

    // Cap of 2, but only one host present: return the full requested batch so
    // single-host crawls behave exactly as before (no per-pop churn).
    const batch = await run(store.popNextUrls(crawlId, 5, 2));
    expect(batch).toHaveLength(5);

    await run(store.close());
  });

  test("without perHostLimit, batch is bounded only by count (backward compat)", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);

    for (let i = 0; i < 6; i++) {
      await seed(store, crawlId, `https://a.example.com/${i}`, i);
    }

    const batch = await run(store.popNextUrls(crawlId, 4));
    expect(batch).toHaveLength(4);
    for (const r of batch) {
      expect(r.status).toBe("fetching");
    }

    await run(store.close());
  });

  test("perHostLimit <= 0 disables the cap (behaves like the 2-arg call)", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);

    // Multi-host so the <= 0 guard is what returns the full batch, not the
    // single-host short-circuit. Without the guard, a cap of 0 would keep zero
    // rows per host and return an empty batch.
    for (let i = 0; i < 3; i++) {
      await seed(store, crawlId, `https://a.example.com/${i}`, i);
      await seed(store, crawlId, `https://b.example.com/${i}`, 10 + i);
    }

    const batch = await run(store.popNextUrls(crawlId, 6, 0));
    expect(batch).toHaveLength(6);

    await run(store.close());
  });

  test("preserves priority order within the diversified batch", async () => {
    const store = await freshStore();
    const crawlId = await freshCrawl(store);

    await seed(store, crawlId, "https://a.example.com/0", 0);
    await seed(store, crawlId, "https://b.example.com/0", 1);
    await seed(store, crawlId, "https://a.example.com/1", 2);
    await seed(store, crawlId, "https://b.example.com/1", 3);

    const batch = await run(store.popNextUrls(crawlId, 4, 1));
    // perHostLimit 1 → one URL per host, highest-priority per host, in order.
    expect(batch.map((r) => r.normalizedUrl)).toEqual([
      "https://a.example.com/0",
      "https://b.example.com/0",
    ]);

    await run(store.close());
  });
});
