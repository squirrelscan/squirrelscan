// #1912: `self disk --prune` is the only thing in the CLI that deletes a user's
// audit history, so the parts that matter are the guards, not the deletion.
//
// The plan a user confirms on must be the real number, a dry run must leave the
// file untouched, and the reclaim must not take the conditional-GET cache the
// next crawl reads — losing that would cost far more than the disk it saved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import { SQLiteStorage } from "@/crawler/storage/sqlite";

import { planProjectPrune, runProjectPrune } from "../../src/self/disk";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

let dir: string;
let dbPath: string;

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

function page(
  url: string,
  fetchedAt: number,
  etag: string,
  html = "<html></html>"
): PageRecord {
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
    etag,
    lastModified: null,
    contentHash: etag,
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag,
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
  } as PageRecord;
}

/** `audits` crawls of the same 3-page site, oldest first. */
async function project(audits: number): Promise<void> {
  const store = new SQLiteStorage(dbPath);
  await run(store.init());
  for (let i = 0; i < audits; i++) {
    const id = await run(
      store.createCrawl({
        baseUrl: "https://e.test",
        startedAt: 1_000 + i,
        status: "completed",
        config: {} as CrawlMetadata["config"],
        stats: STATS,
      } as Omit<CrawlMetadata, "id">)
    );
    for (const path of ["/a", "/b", "/c"]) {
      const url = `https://e.test${path}`;
      await run(store.upsertPage(id, page(url, 1_000 + i, `v${i}`)));
      await run(
        store.saveRuleResults(id, url, "seo/title", [
          { name: "title-present", status: "pass", message: "m" },
        ])
      );
    }
  }
  store.close?.();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-prune-"));
  mkdirSync(join(dir, "proj"), { recursive: true });
  dbPath = join(dir, "proj", "project.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("planProjectPrune", () => {
  test("nothing to plan when the project holds no more than the window", async () => {
    await project(2);
    expect(await planProjectPrune(dbPath, 2)).toBeNull();
    expect(await planProjectPrune(dbPath, 5)).toBeNull();
  });

  test("plans the audits outside the window, oldest first", async () => {
    await project(4);
    const plan = await planProjectPrune(dbPath, 2);
    expect(plan).not.toBeNull();
    expect(plan!.retiring).toHaveLength(2);
    expect(plan!.keeping).toBe(2);
    // Oldest first, so the listing reads chronologically.
    expect(plan!.retiring[0]!.startedAt).toBeLessThan(
      plan!.retiring[1]!.startedAt
    );
    expect(plan!.rows).toBeGreaterThan(0);
  });

  test("an already-retired project can still be rebuilt, and says so", async () => {
    // The state automatic retention leaves behind: the rows for the audits
    // outside the window are gone, and the file is still the size they made it.
    // Sized so the freed space clears the 1 MB floor without depending on it —
    // 40 pages of 32 KB per audit is over a megabyte an audit.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const html = "x".repeat(32 * 1024);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await run(
        store.createCrawl({
          baseUrl: "https://e.test",
          startedAt: 1_000 + i,
          status: "completed",
          config: {} as CrawlMetadata["config"],
          stats: STATS,
        } as Omit<CrawlMetadata, "id">)
      );
      ids.push(id);
      for (let p = 0; p < 40; p++) {
        const url = `https://e.test/p${p}`;
        await run(store.upsertPage(id, page(url, 1_000 + i, `v${i}`, html)));
      }
    }
    // Retire the oldest, as an audit's retention pass would: rows gone, file
    // not rebuilt.
    await run(store.retireCrawls([ids[0]!]));
    const stats = await run(store.databasePageStats());
    store.close?.();
    expect(stats.freelistPages * stats.pageSize).toBeGreaterThan(1024 * 1024);

    // Nothing beyond a window of 3 and nothing left to retire, but the space is
    // real and only a rebuild returns it, so the plan has to offer that.
    const plan = await planProjectPrune(dbPath, 3);
    expect(plan).not.toBeNull();
    expect(plan!.rows).toBe(0);
    expect(plan!.retiring).toHaveLength(0);
    expect(plan!.reclaimableBytes).toBeGreaterThan(1024 * 1024);

    // And running it actually returns the space.
    const result = await runProjectPrune(plan!);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  });

  test("audits an earlier pass already retired are not planned again", async () => {
    await project(4);
    await runProjectPrune((await planProjectPrune(dbPath, 2))!);
    // The same window a second time: the two beyond it are already retired.
    const again = await planProjectPrune(dbPath, 2);
    expect(again?.retiring ?? []).toHaveLength(0);
    expect(again?.rows ?? 0).toBe(0);
  });

  test("the kept count is audits you can still open, not rows in the table", async () => {
    await project(5);
    // Retire the three oldest, as an audit's retention or an earlier prune
    // would. Five audits are still LISTED; two can be opened.
    await runProjectPrune((await planProjectPrune(dbPath, 2))!);

    const plan = await planProjectPrune(dbPath, 1);
    expect(plan).not.toBeNull();
    expect(plan!.retiring).toHaveLength(1);
    // One left renderable afterwards, not four: counting the crawl rows would
    // describe a history the user does not have.
    expect(plan!.keeping).toBe(1);
  });

  test("an audit with nothing deletable left in it is still a retirement", async () => {
    // A crawl outside the window whose derived rows are already gone is still
    // stamped retired and still stops opening, so the plan has to carry it
    // rather than report a rows-only no-op.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      ids.push(
        await run(
          store.createCrawl({
            baseUrl: "https://e.test",
            startedAt: 1_000 + i,
            status: "completed",
            config: {} as CrawlMetadata["config"],
            stats: STATS,
          } as Omit<CrawlMetadata, "id">)
        )
      );
    }
    store.close?.();

    const plan = await planProjectPrune(dbPath, 1);
    expect(plan).not.toBeNull();
    expect(plan!.rows).toBe(0);
    expect(plan!.retiring).toHaveLength(1);

    await runProjectPrune(plan!);
    const after = new SQLiteStorage(dbPath);
    await run(after.init());
    const byId = new Map((await run(after.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(ids[0]!)?.retiredAt).toBeDefined();
    expect(byId.get(ids[1]!)?.retiredAt).toBeUndefined();
    after.close?.();
  });

  test("a missing database is not an error", async () => {
    expect(
      await planProjectPrune(join(dir, "nope", "project.db"), 1)
    ).toBeNull();
  });

  test("planning deletes nothing", async () => {
    await project(3);
    const before = statSync(dbPath).size;
    await planProjectPrune(dbPath, 1);
    expect(statSync(dbPath).size).toBe(before);

    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    expect((await run(store.listCrawls())).length).toBe(3);
    store.close?.();
  });
});

describe("runProjectPrune", () => {
  test("retires the planned audits and returns the space", async () => {
    await project(4);
    const plan = (await planProjectPrune(dbPath, 1))!;
    const result = await runProjectPrune(plan);

    // The count a user confirmed on is the count that was deleted.
    expect(result.rows).toBe(plan.rows);
    // VACUUM plus a WAL checkpoint, so the saving is on the filesystem rather
    // than moved into the -wal beside it.
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  });

  test("keeps the newest page per url, so the next crawl still has its cache", async () => {
    await project(4);
    await runProjectPrune((await planProjectPrune(dbPath, 1))!);

    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    for (const path of ["/a", "/b", "/c"]) {
      const cached = await run(store.getCachedPage(`https://e.test${path}`));
      // v3 is the newest audit's etag; anything older means a cold re-crawl.
      expect(cached?.etag).toBe("v3");
    }
    // The kept audit is still fully renderable.
    const crawls = await run(store.listCrawls());
    expect((await run(store.getRuleResultsByPage(crawls[0]!.id))).size).toBe(3);
    // And every audit is still listed.
    expect(crawls).toHaveLength(4);
    store.close?.();
  });
});
