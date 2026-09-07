// #1860 — `getPageLinkRows` is `getPages` with the columns the audit's
// incoming-link scan does not read left out. It exists purely so that scan
// stops materializing every page's HTML, so the one thing that matters is that
// it never disagrees with `getPages` about which rows exist, in what order, or
// what the two fields hold.

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

describe("getPageLinkRows", () => {
  test("matches getPages row for row, in the same order, paged the same way", async () => {
    store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await freshCrawl(store);

    // Inserted out of order on purpose: both reads sort by normalized_url.
    const urls = [
      "https://example.com/c",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/d",
      "https://example.com/e",
    ];
    for (const [i, url] of urls.entries()) {
      await run(
        store.upsertPage(
          crawlId,
          page(url, {
            html: `<html><body>${"x".repeat(2048)}</body></html>`,
            // A page with no stored parse (an error page, a non-HTML response)
            // must come back as null, not as an empty string.
            parsedData: i === 2 ? null : JSON.stringify({ links: [{ url: `/l${i}` }] }),
          }),
        ),
      );
    }

    const full = await run(store.getPages(crawlId));
    const projected = await run(store.getPageLinkRows(crawlId));

    expect(projected).toEqual(
      full.map((p) => ({ normalizedUrl: p.normalizedUrl, parsedData: p.parsedData ?? null })),
    );
    expect(projected.map((r) => r.normalizedUrl)).toEqual([...urls].sort());
    // The one page stored without a parse (inserted third, sorts second).
    expect(projected.find((r) => r.normalizedUrl.endsWith("/b"))!.parsedData).toBeNull();

    // Paging: same window, same rows.
    for (const limit of [1, 2, 5]) {
      for (let offset = 0; offset < urls.length; offset += limit) {
        const a = await run(store.getPages(crawlId, { limit, offset }));
        const b = await run(store.getPageLinkRows(crawlId, { limit, offset }));
        expect(b).toEqual(
          a.map((p) => ({ normalizedUrl: p.normalizedUrl, parsedData: p.parsedData ?? null })),
        );
      }
    }
  });

  test("reads the parse WITHOUT touching the content store", async () => {
    // The HTML lives in the content store, and pulling it back is the expensive
    // half of what this read exists to avoid — so the projection must not ask
    // for it even once.
    let reads = 0;
    const contentStore = {
      put: (content: string) => {
        const hash = `cs-${content.length}`;
        return hash;
      },
      getString: (_hash: string) => {
        reads++;
        return "<html></html>";
      },
    };
    store = new SQLiteStorage(":memory:", contentStore);
    await run(store.init());
    const crawlId = await freshCrawl(store);
    await run(
      store.upsertPage(
        crawlId,
        page("https://example.com/a", { html: null, parsedData: '{"links":[]}' }),
      ),
    );

    reads = 0;
    const rows = await run(store.getPageLinkRows(crawlId));
    expect(rows).toEqual([{ normalizedUrl: "https://example.com/a", parsedData: '{"links":[]}' }]);
    expect(reads).toBe(0);

    // The control: the full read DOES go to the content store for the same row.
    reads = 0;
    await run(store.getPages(crawlId));
    expect(reads).toBe(1);
  });
});
