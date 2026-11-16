// repo#4525: `getPageParsedData` reads one column, `parsed_data`, for one page.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
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
  const meta = {
    baseUrl: "https://example.com",
    startedAt: 1,
    status: "running",
    config: {},
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
  } as unknown as Omit<CrawlMetadata, "id">;
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
    contentHash: `h-${normalizedUrl}`,
    html: null,
    parsedData: null,
    headers: HEADERS,
    securityHeaders: SECURITY_HEADERS,
    ...over,
  };
}

let store: SQLiteStorage | null = null;
afterEach(async () => {
  if (store) await run(store.close());
  store = null;
});

describe("getPageParsedData", () => {
  test("returns the stored parsed data, null for no parse or no page", async () => {
    store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await freshCrawl(store);
    const parsed = JSON.stringify({ links: [{ url: "/x" }] });
    await run(
      store.upsertPage(
        crawlId,
        page("https://example.com/a", { html: "<html>big</html>", parsedData: parsed }),
      ),
    );
    await run(store.upsertPage(crawlId, page("https://example.com/b")));

    const full = await run(store.getPage(crawlId, "https://example.com/a"));
    expect(await run(store.getPageParsedData(crawlId, "https://example.com/a"))).toBe(
      full?.parsedData ?? "missing",
    );
    expect(await run(store.getPageParsedData(crawlId, "https://example.com/b"))).toBeNull();
    expect(await run(store.getPageParsedData(crawlId, "https://example.com/nope"))).toBeNull();
    expect(await run(store.getPageParsedData("other-crawl", "https://example.com/a"))).toBeNull();
  });

  test("the query selects only parsed_data, never html", async () => {
    store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await freshCrawl(store);
    await run(
      store.upsertPage(
        crawlId,
        page("https://example.com/a", { parsedData: "{}", html: "<p>x</p>" }),
      ),
    );

    // Spy on the live connection (an own property shadows the native method).
    const db = (store as unknown as { db: Database }).db;
    const seen: string[] = [];
    const real = db.query.bind(db);
    (db as unknown as Record<string, unknown>).query = (sql: string) => {
      seen.push(sql);
      return real(sql);
    };
    try {
      expect(await run(store.getPageParsedData(crawlId, "https://example.com/a"))).toBe("{}");
    } finally {
      delete (db as unknown as Record<string, unknown>).query;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^SELECT parsed_data FROM pages /);
    expect(seen[0]).not.toMatch(/html|\*/i);
  });
});
