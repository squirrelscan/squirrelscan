// #941: which unfinished crawls are provably abandoned.
//
// A killed audit leaves its crawl at running/paused/stopped/crawled. Retiring
// one is only safe when a newer finished crawl proves the default flow moved on;
// the predicate is the single choke point, so it gets a status x recency matrix.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlMetadata, PageRecord } from "../src/storage/types";
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

  test("skips the newest running crawl even with allowAbandoned, retiring nothing", async () => {
    const { s, ids } = await store([
      [100, "analyzed"],
      [200, "running"],
    ]);
    const result = await run(
      s.retireCrawlsDetailed([ids[1]!], Date.now(), { allowAbandoned: true })
    );
    expect(result).toEqual({ deleted: 0, retired: [], skipped: [ids[1]!] });
    expect(
      (await run(s.listCrawls())).every((c) => c.retiredAt === undefined)
    ).toBe(true);
  });

  test("one crawl that stopped qualifying skips ALONE: the rest of the batch still retires", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [150, "completed"],
      [200, "analyzed"],
      [300, "running"],
    ]);
    // ids[0] is abandoned; ids[1] is finished; ids[3] is newer than every
    // finished crawl (live). A caller that listed ids[3] earlier, before a
    // newer finish was undone, must not lose the other two.
    const result = await run(
      s.retireCrawlsDetailed([ids[0]!, ids[1]!, ids[3]!], Date.now(), {
        allowAbandoned: true,
      })
    );
    expect(result.retired.sort()).toEqual([ids[0]!, ids[1]!].sort());
    expect(result.skipped).toEqual([ids[3]!]);
    const byId = new Map((await run(s.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(ids[0]!)?.retiredAt).toBeDefined();
    expect(byId.get(ids[1]!)?.retiredAt).toBeDefined();
    expect(byId.get(ids[3]!)?.retiredAt).toBeUndefined();
  });

  test("without allowAbandoned an unfinished crawl still throws and retires nothing", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [200, "analyzed"],
      [250, "completed"],
    ]);
    await expect(run(s.retireCrawls([ids[1]!, ids[0]!]))).rejects.toThrow(
      /not finished/
    );
    expect(
      (await run(s.listCrawls())).every((c) => c.retiredAt === undefined)
    ).toBe(true);
  });
});

describe("stopped and paused (resumable) crawls", () => {
  const DAY = 24 * 60 * 60_000;
  for (const status of ["stopped", "paused"] as const) {
    test(`${status} idle for 31 minutes is NOT abandoned; idle 8 days is`, async () => {
      const now = Date.now();
      const { s, ids } = await store([
        [now - 2 * DAY, status],
        [now - 1 * DAY, "analyzed"],
        [now - 40 * DAY, status],
      ]);
      // ids[0]: idle 2 days (> 30 minutes, < 7 days): kept and listed as live.
      // ids[2]: idle 40 days but older than the newest finished: abandoned.
      expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([
        ids[2]!,
      ]);
      expect((await run(s.listPossiblyLiveCrawls())).map((c) => c.id)).toEqual([
        ids[0]!,
      ]);
    });
  }
});

describe("failed crawls agree across the three queries", () => {
  test("a failed crawl newer than the newest finished audit is possibly live, never abandoned, never retired", async () => {
    const { s, ids } = await store([
      [100, "analyzed"],
      [200, "failed"],
    ]);
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    expect((await run(s.listPossiblyLiveCrawls())).map((c) => c.id)).toEqual([
      ids[1]!,
    ]);
    const result = await run(
      s.retireCrawlsDetailed([ids[1]!], Date.now(), { allowAbandoned: true })
    );
    expect(result.skipped).toEqual([ids[1]!]);
    await expect(run(s.retireCrawls([ids[1]!]))).rejects.toThrow(
      /not finished/
    );
  });

  test("a failed crawl older than a finished audit, idle, is abandoned and retired", async () => {
    const { s, ids } = await store([
      [100, "failed"],
      [200, "analyzed"],
    ]);
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([
      ids[0]!,
    ]);
    const result = await run(
      s.retireCrawlsDetailed([ids[0]!], Date.now(), { allowAbandoned: true })
    );
    expect(result.retired).toEqual([ids[0]!]);
  });
});

function pageAt(url: string, fetchedAt: number): PageRecord {
  const nulls = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    fetchedAt,
    etag: "e",
    lastModified: null,
    contentHash: "e",
    html: "<html></html>",
    parsedData: null,
    headers: nulls([
      "contentType", "contentEncoding", "cacheControl", "vary", "etag", "server",
      "lastModified", "link", "serverTiming", "age", "xCache", "cfCacheStatus",
      "xVercelCache", "altSvc", "acceptRanges",
    ]),
    securityHeaders: nulls([
      "hsts", "csp", "xFrameOptions", "xContentTypeOptions", "referrerPolicy",
      "permissionsPolicy", "xRobotsTag",
    ]),
  } as unknown as PageRecord;
}

describe("activity guard (#941)", () => {
  const MIN = 60_000;

  test("an orphan with a page fetched 5 minutes ago is kept and listed as possibly live", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [200, "analyzed"],
    ]);
    await run(s.upsertPage(ids[0]!, pageAt("https://e.test/a", Date.now() - 5 * MIN)));
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    const live = await run(s.listPossiblyLiveCrawls());
    expect(live.map((c) => c.id)).toEqual([ids[0]!]);
    expect(live[0]!.lastActivityAt).toBeGreaterThan(Date.now() - 6 * MIN);
    const result = await run(
      s.retireCrawlsDetailed([ids[0]!], Date.now(), { allowAbandoned: true })
    );
    expect(result.skipped).toEqual([ids[0]!]);
  });

  test("an orphan idle for 31 minutes is abandoned and retired", async () => {
    const { s, ids } = await store([
      [100, "running"],
      [200, "analyzed"],
    ]);
    await run(s.upsertPage(ids[0]!, pageAt("https://e.test/a", Date.now() - 31 * MIN)));
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([ids[0]!]);
    await run(s.retireCrawls([ids[0]!], Date.now(), { allowAbandoned: true }));
    expect(
      (await run(s.listCrawls())).find((c) => c.id === ids[0])?.retiredAt
    ).toBeDefined();
  });

  test("a crawl that STARTED 5 minutes ago is not abandoned even with no pages yet", async () => {
    const now = Date.now();
    const { s } = await store([
      [now - 5 * MIN, "running"],
      [now - 1 * MIN, "analyzed"],
    ]);
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
  });

  test("KNOWN LIMIT: an overlapping audit in a long no-write phase is retired once it has been silent 30 minutes", async () => {
    // Audit A crawled, then spends 40 minutes in the analyze phase writing
    // nothing to pages or frontier. Audit B started later and finished. With
    // only timestamps there is no way to tell A from a killed crawl; a
    // pid/heartbeat lease (#946) closes this.
    const now = Date.now();
    const { s, ids } = await store([
      [now - 90 * MIN, "crawled"],
      [now - 80 * MIN, "analyzed"],
    ]);
    await run(s.upsertPage(ids[0]!, pageAt("https://e.test/a", now - 40 * MIN)));
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([
      ids[0]!,
    ]);
  });
});
