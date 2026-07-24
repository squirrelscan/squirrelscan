// getCachedResources (#107) — most-recent prior record per (type,url), no dupes,
// deterministic tie-break, current crawl excluded.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type {
  CrawlMetadata,
  ResourceSizeRecord,
} from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

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

function crawlMeta(startedAt: number): Omit<CrawlMetadata, "id"> {
  return {
    baseUrl: "https://example.com",
    startedAt,
    status: "completed",
    config: {} as CrawlMetadata["config"],
    stats: STATS,
  };
}

function res(over: Partial<ResourceSizeRecord> = {}): ResourceSizeRecord {
  return {
    type: "css",
    url: "https://example.com/a.css",
    status: 200,
    error: null,
    contentType: "text/css",
    sizeBytes: 100,
    sourcePages: [],
    ...over,
  };
}

describe("getCachedResources", () => {
  test("returns the most-recent prior record per (type,url), excluding the current crawl", async () => {
    const store = await freshStore();
    const oldId = await run(store.createCrawl(crawlMeta(1000)));
    const newId = await run(store.createCrawl(crawlMeta(2000)));
    const curId = await run(store.createCrawl(crawlMeta(3000)));

    await run(store.saveResourceSizes(oldId, [res({ sizeBytes: 100 })]));
    await run(store.saveResourceSizes(newId, [res({ sizeBytes: 200, cacheControl: "max-age=60" })]));
    // The current crawl also has the resource — it must NOT be returned.
    await run(store.saveResourceSizes(curId, [res({ sizeBytes: 999 })]));

    const cached = await run(store.getCachedResources(curId));
    expect(cached).toHaveLength(1);
    expect(cached[0]!.sizeBytes).toBe(200); // newer prior wins over older
    expect(cached[0]!.cacheControl).toBe("max-age=60");
    expect(cached[0]!.fetchedAt).toBe(2000); // prior crawl's startedAt
  });

  test("no duplicate rows per (type,url) even with many prior crawls", async () => {
    const store = await freshStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await run(store.createCrawl(crawlMeta(1000 + i))));
      await run(store.saveResourceSizes(ids[i]!, [res()]));
    }
    const curId = await run(store.createCrawl(crawlMeta(9000)));
    const cached = await run(store.getCachedResources(curId));
    // One row only, despite 4 prior crawls all storing the same (type,url).
    expect(cached).toHaveLength(1);
    expect(cached[0]!.fetchedAt).toBe(1003); // latest prior
  });

  test("distinct (type,url) pairs each return their own latest row", async () => {
    const store = await freshStore();
    const priorId = await run(store.createCrawl(crawlMeta(1000)));
    await run(
      store.saveResourceSizes(priorId, [
        res({ type: "css", url: "https://example.com/a.css", sizeBytes: 11 }),
        res({ type: "image", url: "https://example.com/b.png", sizeBytes: 22 }),
      ])
    );
    const curId = await run(store.createCrawl(crawlMeta(2000)));
    const cached = await run(store.getCachedResources(curId));
    expect(cached).toHaveLength(2);
    expect(new Set(cached.map((c) => c.url))).toEqual(
      new Set(["https://example.com/a.css", "https://example.com/b.png"])
    );
  });

  test("returns empty when there is no prior crawl", async () => {
    const store = await freshStore();
    const curId = await run(store.createCrawl(crawlMeta(1000)));
    await run(store.saveResourceSizes(curId, [res()]));
    expect(await run(store.getCachedResources(curId))).toEqual([]);
  });
});
