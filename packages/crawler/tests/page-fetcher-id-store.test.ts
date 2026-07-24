// #512 — the crawler SQLite store persists per-page fetch egress/method
// (fetcherId) + fallbackReason, round-trips them, and back-fills the columns
// on an older (v13) DB via migration.

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
  const p = join(tmpdir(), `squirrel-512-${randomUUID()}.db`);
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

describe("per-page fetcherId persistence (#512)", () => {
  test("upsertPage round-trips fetcherId + fallbackReason via getPage/getPages", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await freshCrawl(store);

    await run(
      store.upsertPage(
        crawlId,
        page("https://example.com/a", { fetcherId: "fetch", fallbackReason: "render-block" })
      )
    );
    await run(
      store.upsertPage(crawlId, page("https://example.com/b", { fetcherId: "cloud-render" }))
    );

    const a = await run(store.getPage(crawlId, "https://example.com/a"));
    expect(a?.fetcherId).toBe("fetch");
    expect(a?.fallbackReason).toBe("render-block");

    const b = await run(store.getPage(crawlId, "https://example.com/b"));
    expect(b?.fetcherId).toBe("cloud-render");
    expect(b?.fallbackReason).toBeUndefined();

    const all = await run(store.getPages(crawlId));
    expect(all.map((p) => p.fetcherId)).toEqual(["fetch", "cloud-render"]);

    await run(store.close());
  });

  test("a page written without the fields reads back undefined (back-compat)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await freshCrawl(store);

    await run(store.upsertPage(crawlId, page("https://example.com/x")));
    const x = await run(store.getPage(crawlId, "https://example.com/x"));
    expect(x?.fetcherId).toBeUndefined();
    expect(x?.fallbackReason).toBeUndefined();

    await run(store.close());
  });

  test("migration back-fills fetcher_id/fallback_reason on a pre-#512 (v13) DB", async () => {
    const path = tmpDbPath();

    // Hand-build a v13-shaped store: pages table WITHOUT the #512 columns.
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
        PRIMARY KEY (crawl_id, normalized_url)
      );
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (13);
    `);
    legacy.close();

    // Reopen through SQLiteStorage → runMigrations applies step 14 (ALTER TABLE).
    const store = new SQLiteStorage(path);
    await run(store.init());
    const crawlId = await freshCrawl(store);
    await run(
      store.upsertPage(
        crawlId,
        page("https://example.com/a", { fetcherId: "fetch", fallbackReason: "render-block" })
      )
    );
    const a = await run(store.getPage(crawlId, "https://example.com/a"));
    expect(a?.fetcherId).toBe("fetch");
    expect(a?.fallbackReason).toBe("render-block");
    await run(store.close());
  });
});
