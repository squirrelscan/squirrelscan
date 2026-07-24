// Regression: a migration renumbering collision (a beta bumped SCHEMA_VERSION to
// 16 with migration 15 = project_meta; the release redefined 15 = source_hash,
// #839) left existing DBs recorded at version 16 WITHOUT the `source_hash`
// column. `runMigrations` only runs when currentVersion < SCHEMA_VERSION, so the
// column was never added, and every `upsertPage` INSERT threw
// "table pages has no column named source_hash" → the crawl stored 0 pages and
// ground to the wall-clock backstop. `reconcilePagesColumns` adds any missing
// column on open regardless of the version counter, healing such DBs.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
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
    fetchedAt: 1,
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
  const p = join(tmpdir(), `squirrel-839-${randomUUID()}.db`);
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

// Build a DB in the exact broken state: `pages` has every column through
// migration 14 but NOT `source_hash`, and schema_version is already 16 — so the
// version-gated runner would skip the source_hash migration forever.
function buildCollisionDb(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE crawls (
      id TEXT PRIMARY KEY, base_url TEXT NOT NULL, seed_url TEXT, original_url TEXT,
      started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL,
      config TEXT NOT NULL, stats TEXT NOT NULL
    );
    CREATE TABLE pages (
      crawl_id TEXT NOT NULL, url TEXT NOT NULL, normalized_url TEXT NOT NULL,
      final_url TEXT, depth INTEGER NOT NULL, parent_url TEXT, redirect_chain TEXT,
      status INTEGER NOT NULL, content_type TEXT, size_bytes INTEGER NOT NULL,
      load_time_ms INTEGER NOT NULL, ttfb INTEGER, download_time INTEGER,
      fetched_at INTEGER NOT NULL, etag TEXT, last_modified TEXT,
      content_hash TEXT NOT NULL, html TEXT, parsed_data TEXT, headers TEXT NOT NULL,
      security_headers TEXT NOT NULL, request_headers TEXT,
      fetcher_id TEXT, fallback_reason TEXT,
      PRIMARY KEY (crawl_id, normalized_url)
    );
    CREATE TABLE project_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (16);
  `);
  legacy.close();
}

describe("source_hash migration collision self-heal (#839)", () => {
  test("reconcile adds source_hash on a v16 DB that skipped migration 15", async () => {
    const path = tmpDbPath();
    buildCollisionDb(path);

    // Sanity: the collision state really is missing the column.
    const before = new Database(path);
    const colsBefore = (
      before.prepare("PRAGMA table_info(pages)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(colsBefore).not.toContain("source_hash");
    before.close();

    // Opening the store must self-heal the column despite version === 16.
    const store = new SQLiteStorage(path);
    await run(store.init());

    const check = new Database(path);
    const colsAfter = (
      check.prepare("PRAGMA table_info(pages)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(colsAfter).toContain("source_hash");
    check.close();

    await run(store.close());
  });

  test("upsertPage with a sourceHash succeeds (no throw) on a healed DB and round-trips", async () => {
    const path = tmpDbPath();
    buildCollisionDb(path);

    const store = new SQLiteStorage(path);
    await run(store.init());
    const crawlId = await freshCrawl(store);

    // Before the fix this threw "table pages has no column named source_hash".
    await run(store.upsertPage(crawlId, page("https://example.com/a", { sourceHash: "abc123" })));

    const a = await run(store.getPage(crawlId, "https://example.com/a"));
    expect(a?.sourceHash).toBe("abc123");

    await run(store.close());
  });

  test("reconcile is idempotent: re-opening a healthy DB doesn't change the pages columns", async () => {
    const path = tmpDbPath();

    const store = new SQLiteStorage(path);
    await run(store.init());
    const crawlId = await freshCrawl(store);
    await run(store.upsertPage(crawlId, page("https://example.com/b", { sourceHash: "def456" })));
    await run(store.close());

    const snap = new Database(path);
    const colsFirst = (snap.prepare("PRAGMA table_info(pages)").all() as Array<{
      name: string;
    }>).map((c) => c.name);
    snap.close();

    // Re-open: runMigrations + reconcile run again on an already-healthy DB.
    const store2 = new SQLiteStorage(path);
    await run(store2.init());
    const b = await run(store2.getPage(crawlId, "https://example.com/b"));
    expect(b?.sourceHash).toBe("def456");
    await run(store2.close());

    const snap2 = new Database(path);
    const colsSecond = (snap2.prepare("PRAGMA table_info(pages)").all() as Array<{
      name: string;
    }>).map((c) => c.name);
    snap2.close();

    // No duplicate/extra columns from a second reconcile pass.
    expect(colsSecond).toEqual(colsFirst);
  });
});
