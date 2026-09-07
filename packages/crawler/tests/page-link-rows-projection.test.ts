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

    // Compared RAW, with no `?? null` on either side: normalizing here would
    // hide exactly the kind of divergence this test exists to catch.
    expect(projected).toEqual(
      full.map((p) => ({ normalizedUrl: p.normalizedUrl, parsedData: p.parsedData })),
    );
    expect(projected.map((r) => r.normalizedUrl)).toEqual([...urls].sort());
    // The one page stored without a parse (inserted third, sorts second).
    expect(projected.find((r) => r.normalizedUrl.endsWith("/b"))!.parsedData).toBeNull();

    // Paging: same window, same rows — including the edges. Offset past the end
    // returns nothing; limit 0 is falsy in BOTH builders, so both omit LIMIT,
    // and a nonzero offset with no LIMIT is a SQLite syntax error in both. The
    // comparison is over the OUTCOME, so "they fail the same way" counts as
    // agreement and a divergence in either direction fails the test.
    const outcome = async (read: Promise<unknown>) => {
      try {
        return { ok: await read };
      } catch {
        return { failed: true };
      }
    };
    for (const limit of [1, 2, 5, 0]) {
      for (const offset of [0, 1, 3, urls.length, urls.length + 10]) {
        const a = await outcome(run(store!.getPages(crawlId, { limit, offset })));
        const b = await outcome(run(store!.getPageLinkRows(crawlId, { limit, offset })));
        if (a.failed || b.failed) {
          expect({ limit, offset, a: a.failed, b: b.failed }).toEqual({
            limit,
            offset,
            a: true,
            b: true,
          });
          continue;
        }
        expect(b.ok).toEqual(
          (a.ok as PageRecord[]).map((p) => ({
            normalizedUrl: p.normalizedUrl,
            parsedData: p.parsedData,
          })),
        );
      }
    }
  });

  test("is scoped to its crawl, and orders the way getPages orders", async () => {
    // One crawl on its own cannot catch a dropped `crawl_id` filter, and
    // all-lowercase URLs cannot catch a change of collation.
    store = new SQLiteStorage(":memory:");
    await run(store.init());
    const mine = await freshCrawl(store);
    const other = await freshCrawl(store);

    const shared = ["https://example.com/Zeta", "https://example.com/alpha"];
    for (const url of shared) {
      await run(store.upsertPage(mine, page(url, { parsedData: '{"links":[],"who":"mine"}' })));
      await run(store.upsertPage(other, page(url, { parsedData: '{"links":[],"who":"other"}' })));
    }
    await run(
      store.upsertPage(other, page("https://example.com/only-other", { parsedData: "{}" })),
    );

    const projected = await run(store.getPageLinkRows(mine));
    const full = await run(store.getPages(mine));
    expect(projected).toEqual(
      full.map((p) => ({ normalizedUrl: p.normalizedUrl, parsedData: p.parsedData })),
    );
    // The other crawl's extra page must not appear, and its rows must not win.
    expect(projected).toHaveLength(2);
    for (const row of projected) expect(row.parsedData).toContain('"who":"mine"');
    // BINARY collation puts uppercase first; a switch to NOCASE would reorder.
    expect(projected.map((r) => r.normalizedUrl)).toEqual([
      "https://example.com/Zeta",
      "https://example.com/alpha",
    ]);
  });

  test("returns an empty stored parse as an empty string, not as null", async () => {
    // `parsedData` is nullable AND can legitimately be "", and the two mean
    // different things to the link scan: no stored parse vs a stored empty one.
    store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await freshCrawl(store);
    await run(store.upsertPage(crawlId, page("https://example.com/empty", { parsedData: "" })));
    await run(store.upsertPage(crawlId, page("https://example.com/null", { parsedData: null })));

    const projected = await run(store.getPageLinkRows(crawlId));
    const full = await run(store.getPages(crawlId));
    expect(projected).toEqual(
      full.map((p) => ({ normalizedUrl: p.normalizedUrl, parsedData: p.parsedData })),
    );
    expect(projected.find((r) => r.normalizedUrl.endsWith("/empty"))!.parsedData).toBe("");
    expect(projected.find((r) => r.normalizedUrl.endsWith("/null"))!.parsedData).toBeNull();
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
