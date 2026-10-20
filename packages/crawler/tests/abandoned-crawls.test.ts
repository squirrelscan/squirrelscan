// #941: which unfinished crawls are provably abandoned.
//
// A killed audit leaves its crawl at running/paused/stopped/crawled. Retiring
// one is only safe when a newer finished crawl proves the default flow moved on;
// the predicate is the single choke point, so it gets a status x recency matrix.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlMetadata } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
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

async function store(
  crawls: Array<[number, CrawlMetadata["status"]]>
): Promise<{ s: SQLiteStorage; ids: string[] }> {
  const s = new SQLiteStorage(":memory:");
  await run(s.init());
  const ids: string[] = [];
  for (const [startedAt, status] of crawls) {
    ids.push(
      await run(
        s.createCrawl({
          baseUrl: "https://e.test",
          startedAt,
          status,
          config: {} as CrawlMetadata["config"],
          stats: STATS,
        } as Omit<CrawlMetadata, "id">)
      )
    );
  }
  return { s, ids };
}

const UNFINISHED = ["running", "paused", "stopped", "crawled", "failed"] as const;

describe("listAbandonedCrawls", () => {
  for (const status of UNFINISHED) {
    test(`${status} older than a finished crawl is abandoned`, async () => {
      const { s, ids } = await store([
        [100, status],
        [200, "analyzed"],
      ]);
      expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([
        ids[0]!,
      ]);
    });
  }

  for (const status of ["running", "paused", "stopped", "crawled"] as const) {
    test(`${status} newer than every finished crawl is possibly live, not abandoned`, async () => {
      const { s, ids } = await store([
        [100, "completed"],
        [200, status],
      ]);
      expect(await run(s.listAbandonedCrawls())).toEqual([]);
      expect((await run(s.listPossiblyLiveCrawls())).map((c) => c.id)).toEqual([
        ids[1]!,
      ]);
    });
  }

  test("with no finished crawl at all, nothing is abandoned", async () => {
    const { s } = await store([
      [100, "crawled"],
      [200, "running"],
    ]);
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
  });

  test("finished crawls are never listed, and retired ones are skipped", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [150, "completed"],
      [200, "analyzed"],
    ]);
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([ids[0]!]);
    await run(s.retireCrawls([ids[0]!], Date.now(), { allowAbandoned: true }));
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
  });
});

describe("retireCrawls guard", () => {
  test("still refuses an unfinished crawl without allowAbandoned", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [200, "analyzed"],
    ]);
    await expect(run(s.retireCrawls([ids[0]!]))).rejects.toThrow(/not finished/);
  });

  test("refuses the newest running crawl even with allowAbandoned", async () => {
    const { s, ids } = await store([
      [100, "analyzed"],
      [200, "running"],
    ]);
    await expect(
      run(s.retireCrawls([ids[1]!], Date.now(), { allowAbandoned: true }))
    ).rejects.toThrow(/not finished/);
  });

  test("a refused batch retires nothing, not even its abandoned members", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [200, "analyzed"],
      [300, "running"],
    ]);
    await expect(
      run(s.retireCrawls([ids[0]!, ids[2]!], Date.now(), { allowAbandoned: true }))
    ).rejects.toThrow(/not finished/);
    expect(
      (await run(s.listCrawls())).every((c) => c.retiredAt === undefined)
    ).toBe(true);
  });
});
