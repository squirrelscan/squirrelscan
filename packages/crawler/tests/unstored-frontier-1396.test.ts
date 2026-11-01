// #1396: the URLs a crawl requested but stored no page for, for `--include-pages`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteStorage } from "../src/storage/sqlite";
import type { CrawlMetadata, FrontierRecord, PageRecord } from "../src/storage/types";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);
const STATS = { pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-unstored-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const frontier = (url: string, status: FrontierRecord["status"], reason?: string, at = 1): FrontierRecord => ({
  normalizedUrl: url, rawUrl: url, depth: 1, priority: 0, status, source: "discovered", enqueuedAt: at, retryCount: 0, ...(reason ? { reason } : {}),
});
const page = (url: string): PageRecord =>
  ({
    url, normalizedUrl: url, finalUrl: url, depth: 0, status: 503, contentType: "text/html", sizeBytes: 1, loadTimeMs: 1, fetchedAt: 1,
    etag: null, lastModified: null, contentHash: "h", html: "<html></html>", parsedData: null, headers: {}, securityHeaders: {},
  }) as unknown as PageRecord;

test("failed and skipped entries with no stored page, oldest first, with the true total; a stored page and done or pending entries are not listed", async () => {
  const s = new SQLiteStorage(join(dir, "project.db"));
  await run(s.init());
  const id = await run(s.createCrawl({ baseUrl: "https://e.test", startedAt: 1, status: "analyzed", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">));
  await run(s.upsertFrontier(id, frontier("https://e.test/robots", "skipped", "robots_disallowed", 3)));
  await run(s.upsertFrontier(id, frontier("https://e.test/boom", "failed", "connect ECONNREFUSED", 2)));
  await run(s.upsertFrontier(id, frontier("https://e.test/excluded/a", "skipped", "excluded", 1)));
  await run(s.upsertFrontier(id, frontier("https://e.test/stored-503", "failed", "HTTP 503", 4)));
  await run(s.upsertFrontier(id, frontier("https://e.test/done", "done")));
  await run(s.upsertFrontier(id, frontier("https://e.test/pending", "pending")));
  await run(s.upsertPage(id, page("https://e.test/stored-503")));

  const all = await run(s.getUnstoredFrontierEntries(id, 10));
  expect(all.total).toBe(3);
  expect(all.entries.map((e) => [e.url, e.status, e.reason])).toEqual([
    ["https://e.test/excluded/a", "skipped", "excluded"],
    ["https://e.test/boom", "failed", "connect ECONNREFUSED"],
    ["https://e.test/robots", "skipped", "robots_disallowed"],
  ]);

  const capped = await run(s.getUnstoredFrontierEntries(id, 2));
  expect(capped.entries).toHaveLength(2);
  expect(capped.total).toBe(3);
  expect((await run(s.getUnstoredFrontierEntries(id, 0))).entries).toEqual([]);
  s.close?.();
});

test("another crawl's entries are not listed", async () => {
  const s = new SQLiteStorage(join(dir, "project.db"));
  await run(s.init());
  const a = await run(s.createCrawl({ baseUrl: "https://e.test", startedAt: 1, status: "analyzed", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">));
  const b = await run(s.createCrawl({ baseUrl: "https://e.test", startedAt: 2, status: "analyzed", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">));
  await run(s.upsertFrontier(a, frontier("https://e.test/x", "failed", "boom")));
  expect((await run(s.getUnstoredFrontierEntries(b, 10))).total).toBe(0);
  s.close?.();
});
