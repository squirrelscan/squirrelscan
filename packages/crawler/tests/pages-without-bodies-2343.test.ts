// repo#2343 — `getPagesWithoutBodies` is `getPages` minus the two body columns.
// It exists so the report's page walk stops pulling every page's HTML out of the
// content store (1.5 GB of transient strings over 1,000 1.5 MB pages, the
// audit's memory peak), so what matters is that it never disagrees with
// `getPages` about anything BUT the body: same rows, same order, same paging,
// every other field identical, and no content-store read at all.

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
  contentType: "text/html",
  contentEncoding: "gzip",
  cacheControl: "max-age=60",
  vary: null,
  etag: '"e1"',
  server: "test",
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
  hsts: "max-age=1",
  csp: null,
  xFrameOptions: "DENY",
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

/** Every scalar set to something distinguishable, so a dropped column shows. */
function page(normalizedUrl: string, i: number, over: Partial<PageRecord> = {}): PageRecord {
  return {
    url: `${normalizedUrl}?raw`,
    normalizedUrl,
    finalUrl: `${normalizedUrl}/final`,
    depth: i,
    parentUrl: "https://example.com/",
    redirectChain: { hops: [{ url: `${normalizedUrl}/old`, status: 301 }] } as never,
    status: 200 + i,
    contentType: "text/html",
    sizeBytes: 1000 + i,
    loadTimeMs: 10 + i,
    ttfb: 5 + i,
    downloadTime: 3 + i,
    fetchedAt: 100 + i,
    etag: `"e${i}"`,
    lastModified: "Tue, 01 Sep 2026 00:00:00 GMT",
    contentHash: `h-${normalizedUrl}`,
    html: `<html><body>${"x".repeat(2048)} ${i}</body></html>`,
    parsedData: JSON.stringify({ links: [{ url: `/l${i}` }] }),
    headers: HEADERS,
    securityHeaders: SECURITY_HEADERS,
    requestHeaders: { "user-agent": `ua-${i}` },
    fetcherId: i % 2 ? "http" : "render",
    fallbackReason: i % 2 ? undefined : "spa",
    sourceHash: `src-${i}`,
    ...over,
  };
}

/** A content store that counts body reads. */
function countingStore() {
  const bodies = new Map<string, string>();
  const counter = { reads: 0 };
  return {
    counter,
    store: {
      put(content: string) {
        const hash = `cs-${bodies.size}-${content.length}`;
        bodies.set(hash, content);
        return hash;
      },
      getString(hash: string) {
        counter.reads++;
        return bodies.get(hash) ?? null;
      },
    },
  };
}

const withoutBody = (p: PageRecord) => ({ ...p, html: null, parsedData: null });

let store: SQLiteStorage | null = null;
afterEach(async () => {
  if (store) await run(store.close());
  store = null;
});

describe("getPagesWithoutBodies (#2343)", () => {
  test("is getPages with html and parsedData nulled, row for row, page for page", async () => {
    const { store: content } = countingStore();
    store = new SQLiteStorage(":memory:", content);
    await run(store.init());
    const crawlId = await freshCrawl(store);
    const other = await freshCrawl(store);

    // Inserted out of order, with mixed case: both reads sort BINARY.
    const urls = [
      "https://example.com/c",
      "https://example.com/A",
      "https://example.com/b",
      "https://example.com/d",
    ];
    for (const [i, url] of urls.entries()) {
      // One page stored with no body at all (a non-HTML response).
      await run(store.upsertPage(crawlId, page(url, i, i === 3 ? { html: null } : {})));
    }
    // Another crawl's rows must not leak in.
    await run(store.upsertPage(other, page("https://example.com/only-other", 9)));

    const full = await run(store.getPages(crawlId));
    const light = await run(store.getPagesWithoutBodies(crawlId));
    // The full read really had bodies to leave out, or this proves nothing.
    expect(full.filter((p) => p.html !== null)).toHaveLength(3);
    expect(light).toEqual(full.map(withoutBody));
    expect(light.map((p) => p.normalizedUrl)).toEqual([
      "https://example.com/A",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ]);

    for (const limit of [1, 2, 4]) {
      for (const offset of [0, 1, 3, urls.length]) {
        const a = await run(store.getPages(crawlId, { limit, offset }));
        const b = await run(store.getPagesWithoutBodies(crawlId, { limit, offset }));
        expect(b).toEqual(a.map(withoutBody));
      }
    }
  });

  test("never reads a body from the content store", async () => {
    const { store: content, counter } = countingStore();
    store = new SQLiteStorage(":memory:", content);
    await run(store.init());
    const crawlId = await freshCrawl(store);
    for (let i = 0; i < 5; i++) {
      await run(store.upsertPage(crawlId, page(`https://example.com/p${i}`, i)));
    }

    counter.reads = 0;
    const light = await run(store.getPagesWithoutBodies(crawlId));
    expect(light).toHaveLength(5);
    expect(counter.reads).toBe(0);

    // The control: the full read goes to the store once per stored body.
    counter.reads = 0;
    await run(store.getPages(crawlId));
    expect(counter.reads).toBe(5);
  });
});
