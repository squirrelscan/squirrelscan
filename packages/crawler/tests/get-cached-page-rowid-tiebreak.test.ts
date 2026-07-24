// #846 — reuseCachedPage copies a cached row into the current crawl without
// bumping fetched_at (crawler.ts's reuseCachedPage spreads `...cachedPage`
// verbatim). On the hash_match path a fresh source_hash is persisted onto
// that copy (#839), but since fetched_at is untouched, the copy ties the
// original row's fetched_at. getCachedPage's `ORDER BY fetched_at DESC` had
// no secondary key, so the tie-break was unspecified — the freshly-persisted
// source_hash could be shadowed by the older row. Fixed by adding
// `rowid DESC` as a deterministic tie-break: the most recently written row
// (the reuse-path copy, always inserted later) wins.

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import type {
  CrawlMetadata,
  PageRecord,
  ResponseHeaders,
  SecurityHeaders,
} from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const HEADERS: ResponseHeaders = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  vary: null,
  etag: null,
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
};

const SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

async function freshCrawl(store: SQLiteStorage): Promise<string> {
  const meta: Omit<CrawlMetadata, "id"> = {
    baseUrl: "https://example.com",
    startedAt: 1,
    status: "running",
    config: {
      maxPages: 10,
      concurrency: 1,
      perHostConcurrency: 1,
      delayMs: 0,
      perHostDelayMs: 0,
      timeoutMs: 1000,
      userAgent: "test",
      followRedirects: true,
      respectRobots: false,
      incremental: true,
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

function page(normalizedUrl: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    url: normalizedUrl,
    normalizedUrl,
    finalUrl: normalizedUrl,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 1,
    loadTimeMs: 1,
    fetchedAt: 1_000,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: null,
    parsedData: null,
    headers: HEADERS,
    securityHeaders: SECURITY_HEADERS,
    ...over,
  };
}

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `squirrel-846-${randomUUID()}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore missing temp files
    }
  }
});

describe("getCachedPage rowid tie-break (#846)", () => {
  test("a same-fetched_at reuse copy with a persisted source_hash wins over the older row", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    const url = "https://example.com/a";

    // Crawl 1: the original fetch, no source_hash yet.
    const crawl1 = await freshCrawl(store);
    await run(store.upsertPage(crawl1, page(url, { sourceHash: null })));

    // Crawl 2: reuseCachedPage's hash_match copy — SAME fetched_at (never
    // bumped by reuseCachedPage) but with the freshly-computed source_hash
    // persisted onto it (crawler.ts: `cachedPage.sourceHash = result.sourceHash`
    // before the copy is written). Inserted after crawl1's row, so it gets a
    // higher rowid.
    const crawl2 = await freshCrawl(store);
    await run(
      store.upsertPage(crawl2, page(url, { sourceHash: "fresh-normalized-source-hash" }))
    );

    const cached = await run(store.getCachedPage(url));
    expect(cached).not.toBeNull();
    expect(cached?.sourceHash).toBe("fresh-normalized-source-hash");

    await run(store.close());
  });

  test("tie-break holds across a reopened on-disk DB (rowid persists, not just in-memory insert order)", async () => {
    const path = tmpDbPath();
    const store = new SQLiteStorage(path);
    await run(store.init());

    const url = "https://example.com/b";
    const crawl1 = await freshCrawl(store);
    await run(store.upsertPage(crawl1, page(url, { sourceHash: null })));
    const crawl2 = await freshCrawl(store);
    await run(store.upsertPage(crawl2, page(url, { sourceHash: "reused-hash" })));
    await run(store.close());

    const reopened = new SQLiteStorage(path);
    await run(reopened.init());
    const cached = await run(reopened.getCachedPage(url));
    expect(cached?.sourceHash).toBe("reused-hash");
    await run(reopened.close());
  });
});
