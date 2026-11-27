// #2419: a throttled fetch leaves no page row, only a failed frontier entry whose
// reason says so. The engine reads those entries back to treat the URLs as
// unverified instead of missing.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CrawlMetadata,
  FrontierRecord,
  PageRecord,
} from "../src/storage/types";

import { CrawlError } from "../src/fetcher";
import { SQLiteStorage } from "../src/storage/sqlite";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);
const BASE = "https://example.com";
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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-rate-limited-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const frontier = (
  path: string,
  status: FrontierRecord["status"],
  reason: string | undefined,
  at: number
): FrontierRecord => ({
  normalizedUrl: `${BASE}${path}`,
  rawUrl: `${BASE}${path}`,
  depth: 1,
  priority: 0,
  status,
  source: "discovered",
  enqueuedAt: at,
  retryCount: 0,
  ...(reason ? { reason } : {}),
});

async function crawl(s: SQLiteStorage): Promise<string> {
  await run(s.init());
  return run(
    s.createCrawl({
      baseUrl: BASE,
      startedAt: 1,
      status: "analyzed",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
}

test("lists unstored failed entries the host rate limited, with the status the reason names", async () => {
  const s = new SQLiteStorage(join(dir, "project.db"));
  const id = await crawl(s);
  const throttled = (path: string, status: number) =>
    CrawlError.rateLimit(`${BASE}${path}`, 30_000, status).message;
  const entries = [
    frontier("/p430", "failed", throttled("/p430", 430), 1),
    frontier("/p429", "failed", throttled("/p429", 429), 2),
    // The crawler's own backoff gave up on the host: no status in the reason.
    frontier("/backoff", "failed", "Rate limited by example.com", 3),
    frontier("/refused", "failed", "connect ECONNREFUSED", 4),
    frontier("/stored", "failed", throttled("/stored", 429), 5),
    frontier("/pending", "pending", undefined, 6),
  ];
  for (const entry of entries) await run(s.upsertFrontier(id, entry));
  await run(
    s.upsertPage(id, {
      url: `${BASE}/stored`,
      normalizedUrl: `${BASE}/stored`,
      finalUrl: `${BASE}/stored`,
      depth: 1,
      status: 200,
      contentType: "text/html",
      sizeBytes: 1,
      loadTimeMs: 1,
      fetchedAt: 1,
      etag: null,
      lastModified: null,
      contentHash: "h",
      html: "<html></html>",
      parsedData: null,
      headers: {},
      securityHeaders: {},
    } as unknown as PageRecord)
  );

  expect(await run(s.getRateLimitedFrontierUrls(id, 10))).toEqual([
    { url: `${BASE}/p430`, status: 430 },
    { url: `${BASE}/p429`, status: 429 },
    { url: `${BASE}/backoff`, status: 429 },
  ]);
  expect(await run(s.getRateLimitedFrontierUrls(id, 1))).toHaveLength(1);
  s.close?.();
});

test("the prefix is matched exactly: a lowercase or wildcard-like reason is not a rate limit", async () => {
  const s = new SQLiteStorage(join(dir, "project.db"));
  const id = await crawl(s);
  await run(
    s.upsertFrontier(id, frontier("/lower", "failed", "rate limited (429)", 1))
  );
  await run(
    s.upsertFrontier(id, frontier("/like", "failed", "Rate_limited (429)", 2))
  );
  expect(await run(s.getRateLimitedFrontierUrls(id, 10))).toEqual([]);
  s.close?.();
});
