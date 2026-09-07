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

function page(url: string, fetchedAt: number, etag: string): PageRecord {
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
    html: "<html></html>",
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
