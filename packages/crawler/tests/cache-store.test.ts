// Unit tests for the StorageCacheStore abstraction (#105).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type {
  CrawlStorage,
  PageRecord,
  ResponseHeaders,
} from "../src/storage/types";
import { StorageCacheStore } from "../src/cache-store";

const now = 1_000_000_000_000;

function headers(overrides: Partial<ResponseHeaders> = {}): ResponseHeaders {
  return {
    contentType: "text/html",
    contentEncoding: null,
    cacheControl: null,
    expires: null,
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
    ...overrides,
  };
}

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    url: "https://example.com/",
    normalizedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 1234,
    loadTimeMs: 10,
    fetchedAt: now,
    etag: null,
    lastModified: null,
    contentHash: "hash",
    html: "<html></html>",
    parsedData: null,
    headers: headers(),
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
    requestHeaders: null,
    ...overrides,
  };
}

/** Minimal in-memory CrawlStorage covering only what the cache store calls. */
function fakeStorage(stored: PageRecord | null): {
  storage: CrawlStorage;
  upserts: PageRecord[];
} {
  const upserts: PageRecord[] = [];
  const storage = {
    getCachedPage: (_url: string) => Effect.succeed(stored),
    upsertPage: (_crawlId: string, p: PageRecord) =>
      Effect.sync(() => {
        upserts.push(p);
      }),
  } as unknown as CrawlStorage;
  return { storage, upserts };
}

const ctx = { requestHeaders: { "accept-encoding": "gzip, br" } };

describe("StorageCacheStore.lookup", () => {
  test("miss when nothing stored", async () => {
    const { storage } = fakeStorage(null);
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup("https://example.com/", ctx, { now })
    );
    expect(res.entry).toBeNull();
    expect(res.freshness).toBeUndefined();
  });

  test("fresh hit (max-age) returns fresh verdict", async () => {
    const { storage } = fakeStorage(
      page({
        fetchedAt: now - 60 * 1000,
        headers: headers({ cacheControl: "max-age=3600" }),
      })
    );
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup("https://example.com/", ctx, { now })
    );
    expect(res.entry).not.toBeNull();
    expect(res.freshness?.state).toBe("fresh");
  });

  test("stale entry returns stale verdict (conditional GET path)", async () => {
    const { storage } = fakeStorage(
      page({
        fetchedAt: now - 7200 * 1000,
        headers: headers({ cacheControl: "max-age=3600" }),
      })
    );
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup("https://example.com/", ctx, { now })
    );
    expect(res.entry).not.toBeNull();
    expect(res.freshness?.state).toBe("stale");
  });

  test("Vary mismatch → treated as miss (never reused)", async () => {
    const { storage } = fakeStorage(
      page({
        headers: headers({ cacheControl: "max-age=3600", vary: "User-Agent" }),
        requestHeaders: { "user-agent": "SquirrelBot/1.0" },
      })
    );
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup(
        "https://example.com/",
        { requestHeaders: { "user-agent": "SquirrelBot/2.0" } },
        { now }
      )
    );
    expect(res.entry).toBeNull();
  });

  test("Vary match → hit", async () => {
    const { storage } = fakeStorage(
      page({
        fetchedAt: now - 60 * 1000,
        headers: headers({ cacheControl: "max-age=3600", vary: "User-Agent" }),
        requestHeaders: { "user-agent": "SquirrelBot/1.0" },
      })
    );
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup(
        "https://example.com/",
        { requestHeaders: { "user-agent": "SquirrelBot/1.0" } },
        { now }
      )
    );
    expect(res.entry).not.toBeNull();
    expect(res.freshness?.state).toBe("fresh");
  });

  test("Vary: Accept-Encoding hits (production path — neither side keys on it)", async () => {
    // In production buildCacheRequestContext omits accept-encoding, so a
    // Vary: Accept-Encoding response caches because stored "" === current "".
    const { storage } = fakeStorage(
      page({
        fetchedAt: now - 60 * 1000,
        headers: headers({
          cacheControl: "max-age=3600",
          vary: "Accept-Encoding",
        }),
        requestHeaders: { "accept-language": "en-US,en;q=0.9" },
      })
    );
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup(
        "https://example.com/",
        { requestHeaders: { "accept-language": "en-US,en;q=0.9" } },
        { now }
      )
    );
    expect(res.entry).not.toBeNull();
    expect(res.freshness?.state).toBe("fresh");
  });

  // Crawler SWR branch relies on the seam surfacing a "revalidate" verdict (#147).
  test("stale-while-revalidate entry returns revalidate verdict (SWR branch)", async () => {
    const { storage } = fakeStorage(
      page({
        fetchedAt: now - 120 * 1000,
        headers: headers({ cacheControl: "max-age=60, stale-while-revalidate=600" }),
      })
    );
    const store = new StorageCacheStore(storage);
    const res = await Effect.runPromise(
      store.lookup("https://example.com/", ctx, { now })
    );
    expect(res.entry).not.toBeNull();
    expect(res.freshness?.state).toBe("revalidate");
  });

  // Crawler passes maxStalenessSeconds; the seam must honor it — verdict flips (#147).
  test("honors maxStalenessSeconds the crawler passes (verdict flips with the cap)", async () => {
    const { storage } = fakeStorage(
      page({
        fetchedAt: now - 2 * 24 * 3600 * 1000, // 2 days old; max-age alone says fresh
        headers: headers({ cacheControl: `max-age=${10 * 365 * 24 * 3600}` }),
      })
    );
    const store = new StorageCacheStore(storage);
    const wideCap = await Effect.runPromise(
      store.lookup("https://example.com/", ctx, { now, maxStalenessSeconds: 30 * 24 * 3600 })
    );
    expect(wideCap.freshness?.state).toBe("fresh");
    const tightCap = await Effect.runPromise(
      store.lookup("https://example.com/", ctx, { now, maxStalenessSeconds: 3600 })
    );
    // No stale-while-revalidate directive → the cap surfaces "stale", not "revalidate".
    expect(tightCap.freshness?.state).toBe("stale");
  });
});

describe("StorageCacheStore.store", () => {
  test("delegates to upsertPage", async () => {
    const { storage, upserts } = fakeStorage(null);
    const store = new StorageCacheStore(storage);
    const p = page();
    await Effect.runPromise(store.store("crawl-1", p));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.normalizedUrl).toBe(p.normalizedUrl);
  });
});
