// repo#2342: a page whose body the content store has evicted.
//
// The body lives in the content store, the page row only holds its hash, and the
// store's size cap can drop the body at any later point. Two readers used to
// carry on regardless: the incremental crawl reused the row on a 304 and handed
// the audit a page with no HTML, and `squirrel report` / a resume read a partial
// crawl without saying so. `getCachedPage` now treats such an entry as a miss,
// and `countEvictedPageBodies` is the census those notices are built from.

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

const HEADERS = {
  contentType: "text/html",
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
} satisfies ResponseHeaders;
const SECURITY_HEADERS = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
} satisfies SecurityHeaders;

function page(normalizedUrl: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    url: normalizedUrl,
    normalizedUrl,
    finalUrl: normalizedUrl,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: '"e"',
    lastModified: null,
    contentHash: `crawler-${normalizedUrl}`,
    html: `<html><body>${normalizedUrl}</body></html>`,
    parsedData: null,
    headers: HEADERS,
    securityHeaders: SECURITY_HEADERS,
    ...over,
  };
}

/** A content store whose entries the test can evict, as the size cap would. */
function evictableStore() {
  const bodies = new Map<string, string>();
  let next = 0;
  return {
    bodies,
    store: {
      put(content: string) {
        const hash = `body-${next++}`;
        bodies.set(hash, content);
        return hash;
      },
      getString: (hash: string) => bodies.get(hash) ?? null,
      has: (hash: string) => bodies.has(hash),
    },
  };
}

async function crawl(store: SQLiteStorage): Promise<string> {
  return run(
    store.createCrawl({
      baseUrl: "https://example.com",
      startedAt: 1,
      status: "running",
      config: {},
      stats: {},
    } as unknown as Omit<CrawlMetadata, "id">),
  );
}

let storage: SQLiteStorage | null = null;
afterEach(async () => {
  if (storage) await run(storage.close());
  storage = null;
});

describe("evicted page bodies (#2342)", () => {
  test("getCachedPage treats an entry whose body was evicted as a miss", async () => {
    const content = evictableStore();
    storage = new SQLiteStorage(":memory:", content.store);
    await run(storage.init());
    const crawlId = await crawl(storage);
    await run(storage.upsertPage(crawlId, page("https://example.com/kept")));
    await run(storage.upsertPage(crawlId, page("https://example.com/evicted")));

    const before = await run(storage.getCachedPage("https://example.com/evicted"));
    expect(before?.html).toContain("/evicted");
    // The cap evicts the body; the page row still points at it.
    content.bodies.delete(before!.htmlHash!);

    expect(await run(storage.getCachedPage("https://example.com/evicted"))).toBeNull();
    expect((await run(storage.getCachedPage("https://example.com/kept")))?.html).toContain(
      "/kept",
    );
    expect(storage.evictedCacheEntryCount()).toBe(1);
  });

  test("a page stored with no body is a hit, not an eviction", async () => {
    // A redirect or a non-HTML response stores no body at all, so it never went
    // to the content store and there is nothing to have evicted.
    const content = evictableStore();
    storage = new SQLiteStorage(":memory:", content.store);
    await run(storage.init());
    const crawlId = await crawl(storage);
    await run(
      storage.upsertPage(
        crawlId,
        page("https://example.com/file.pdf", { html: null, contentType: "application/pdf" }),
      ),
    );
    const hit = await run(storage.getCachedPage("https://example.com/file.pdf"));
    expect(hit).not.toBeNull();
    expect(storage.evictedCacheEntryCount()).toBe(0);
  });

  test("a pre-v28 row with no html_hash and no body left is a miss, not counted", async () => {
    // Rows written before html_hash existed cannot prove their body went to the
    // store. An HTML one with a content hash and no body is refetched either way.
    const content = evictableStore();
    storage = new SQLiteStorage(":memory:", content.store);
    await run(storage.init());
    const crawlId = await crawl(storage);
    await run(storage.upsertPage(crawlId, page("https://example.com/legacy")));
    const stored = await run(storage.getCachedPage("https://example.com/legacy"));
    content.bodies.delete(stored!.htmlHash!);
    // Wind the row back to the pre-v28 shape.
    (storage as unknown as { getDb(): import("bun:sqlite").Database })
      .getDb()
      .prepare("UPDATE pages SET html_hash = NULL")
      .run();

    expect(await run(storage.getCachedPage("https://example.com/legacy"))).toBeNull();
    expect(storage.evictedCacheEntryCount()).toBe(0);
  });

  test("a pre-v28 row with no content type and no body left is a miss too", async () => {
    // The crawler sniffs headerless HTML, so a missing content type is no
    // evidence the page had no body.
    const content = evictableStore();
    storage = new SQLiteStorage(":memory:", content.store);
    await run(storage.init());
    const crawlId = await crawl(storage);
    await run(
      storage.upsertPage(crawlId, page("https://example.com/sniffed", { contentType: null })),
    );
    const stored = await run(storage.getCachedPage("https://example.com/sniffed"));
    content.bodies.delete(stored!.htmlHash!);
    (storage as unknown as { getDb(): import("bun:sqlite").Database })
      .getDb()
      .prepare("UPDATE pages SET html_hash = NULL")
      .run();

    expect(await run(storage.getCachedPage("https://example.com/sniffed"))).toBeNull();
  });

  test("retainPageBodies touches this crawl's stored bodies only", async () => {
    const content = evictableStore();
    const touched: string[] = [];
    storage = new SQLiteStorage(":memory:", {
      ...content.store,
      touch: (hashes: readonly string[]) => {
        touched.push(...hashes);
        return hashes.length;
      },
    });
    await run(storage.init());
    const mine = await crawl(storage);
    const other = await crawl(storage);
    await run(storage.upsertPage(mine, page("https://example.com/a")));
    await run(storage.upsertPage(mine, page("https://example.com/b")));
    await run(storage.upsertPage(other, page("https://example.com/c")));

    expect(await run(storage.retainPageBodies(mine))).toBe(2);
    expect(touched.sort()).toEqual(
      [
        (await run(storage.getCachedPage("https://example.com/a")))!.htmlHash!,
        (await run(storage.getCachedPage("https://example.com/b")))!.htmlHash!,
      ].sort(),
    );
  });

  test("without a content store (the cloud), bodies are inline and never evicted", async () => {
    storage = new SQLiteStorage(":memory:");
    await run(storage.init());
    const crawlId = await crawl(storage);
    await run(storage.upsertPage(crawlId, page("https://example.com/a")));
    expect((await run(storage.getCachedPage("https://example.com/a")))?.html).toContain("/a");
    expect(await run(storage.countEvictedPageBodies(crawlId))).toEqual({ evicted: 0, stored: 0 });
  });

  test("countEvictedPageBodies counts this crawl's missing bodies and nothing else", async () => {
    const content = evictableStore();
    storage = new SQLiteStorage(":memory:", content.store);
    await run(storage.init());
    const mine = await crawl(storage);
    const other = await crawl(storage);
    for (const path of ["a", "b", "c", "d"]) {
      await run(storage.upsertPage(mine, page(`https://example.com/${path}`)));
    }
    await run(storage.upsertPage(mine, page("https://example.com/no-body", { html: null })));
    await run(storage.upsertPage(other, page("https://example.com/other")));

    expect(await run(storage.countEvictedPageBodies(mine))).toEqual({ evicted: 0, stored: 4 });

    // Evict two of this crawl's bodies and the other crawl's one.
    for (const url of ["https://example.com/a", "https://example.com/c", "https://example.com/other"]) {
      const row = await run(storage.getCachedPage(url));
      content.bodies.delete(row!.htmlHash!);
    }
    expect(await run(storage.countEvictedPageBodies(mine))).toEqual({ evicted: 2, stored: 4 });
    expect(await run(storage.countEvictedPageBodies(other))).toEqual({ evicted: 1, stored: 1 });
  });
});
