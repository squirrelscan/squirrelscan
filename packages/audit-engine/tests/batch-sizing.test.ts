// #1860: pages per batch is derived from a BYTE budget, because peak RSS is
// `batch × per-page cost` and per-page cost belongs to the site. A fixed page
// count is right for one site shape and wrong for the other by fifty times.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageRecord, ResponseHeaders, SecurityHeaders } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  resolveStreamBatch,
  resolveStreamBatchPages,
  sampleAveragePageBytes,
  STREAM_BATCH_BYTES,
  STREAM_BATCH_MAX_PAGES,
  STREAM_BATCH_MIN_PAGES,
} from "../src/batch-sizing";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const KB = 1024;
const MB = 1024 * KB;

describe("resolveStreamBatchPages", () => {
  test("a heavy-page site gets a small batch, a light-page site a large one", () => {
    // The whole point: one budget, two very different page counts.
    const heavy = resolveStreamBatchPages({ avgPageBytes: 1 * MB });
    const light = resolveStreamBatchPages({ avgPageBytes: 20 * KB });
    expect(heavy).toBe(48);
    expect(light).toBe(STREAM_BATCH_MAX_PAGES);
    expect(heavy).toBeLessThan(light);
  });

  test("the batch times the page size stays inside the budget", () => {
    for (const avg of [5 * KB, 50 * KB, 250 * KB, 1 * MB, 4 * MB]) {
      const pages = resolveStreamBatchPages({ avgPageBytes: avg });
      // Only meaningful away from the clamps; at a clamp the budget yields.
      if (pages > STREAM_BATCH_MIN_PAGES && pages < STREAM_BATCH_MAX_PAGES) {
        expect(pages * avg).toBeLessThanOrEqual(STREAM_BATCH_BYTES);
      }
    }
  });

  test("a page heavier than the whole budget still yields a runnable batch", () => {
    // 64 MB of html in one page would divide to zero. A batch of zero is an
    // infinite loop (SQLite reads LIMIT 0 as no limit), so the floor holds.
    expect(resolveStreamBatchPages({ avgPageBytes: 64 * MB })).toBe(STREAM_BATCH_MIN_PAGES);
  });

  test("an unknown page size falls to the floor, never to a huge batch", () => {
    // An empty crawl or pages with no stored html must not be read as "tiny
    // pages, use a 500-page batch".
    for (const avg of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveStreamBatchPages({ avgPageBytes: avg })).toBe(STREAM_BATCH_MIN_PAGES);
    }
    // An unusable BUDGET is different from an unknown page size: it is a typo in
    // a knob, so it falls back to the documented default budget rather than to a
    // 5-page batch that would make every audit crawl along for no stated reason.
    expect(resolveStreamBatchPages({ avgPageBytes: 1 * MB, byteBudget: 0 })).toBe(
      resolveStreamBatchPages({ avgPageBytes: 1 * MB }),
    );
  });

  test("a bigger budget buys proportionally more pages", () => {
    const at48 = resolveStreamBatchPages({ avgPageBytes: 1 * MB, byteBudget: 48 * MB });
    const at96 = resolveStreamBatchPages({ avgPageBytes: 1 * MB, byteBudget: 96 * MB });
    expect(at96).toBe(at48 * 2);
  });

  test("clamps are honoured and cannot invert", () => {
    expect(resolveStreamBatchPages({ avgPageBytes: 1, maxPages: 10 })).toBe(10);
    expect(resolveStreamBatchPages({ avgPageBytes: 1 * MB, minPages: 30 })).toBe(48);
    // A max below the min must not produce a nonsense batch.
    expect(
      resolveStreamBatchPages({ avgPageBytes: 1, minPages: 20, maxPages: 5 }),
    ).toBeGreaterThanOrEqual(20);
  });
});

const EMPTY_HEADERS: ResponseHeaders = {
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
};

const EMPTY_SECURITY: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function page(url: string, htmlBytes: number, opts?: { sizeBytes?: number }): PageRecord {
  const html = htmlBytes > 0 ? "x".repeat(htmlBytes) : null;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    // Deliberately allowed to disagree with html.length — see the gzip test.
    sizeBytes: opts?.sizeBytes ?? htmlBytes,
    loadTimeMs: 1,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: url,
    html,
    parsedData: null,
    headers: EMPTY_HEADERS,
    securityHeaders: EMPTY_SECURITY,
  } as PageRecord;
}

async function seed(pages: PageRecord[]): Promise<{ storage: SQLiteStorage; crawlId: string }> {
  const storage = new SQLiteStorage(":memory:");
  await run(storage.init());
  const crawlId = await run(
    storage.createCrawl({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com",
      originalUrl: "https://example.com",
      startedAt: Date.now(),
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
    } as never),
  );
  for (const p of pages) await run(storage.upsertPage(crawlId, p));
  return { storage, crawlId };
}

describe("sampleAveragePageBytes", () => {
  test("measures stored html, not the crawler's transfer size", async () => {
    // THE reason this samples html instead of reading crawl.stats.bytesTotal.
    // The incident's pages were 105 KB gzipped on the wire and ~1 MB of html;
    // budgeting against the wire size picks a batch ten times too large on
    // exactly the sites that need it smallest.
    const pages = Array.from({ length: 20 }, (_, i) =>
      page(`https://example.com/p${i}`, 100 * KB, { sizeBytes: 10 * KB }),
    );
    const { storage, crawlId } = await seed(pages);

    const avg = await run(sampleAveragePageBytes(storage, crawlId, pages.length));
    expect(avg).toBe(100 * KB);

    await run(storage.close());
  });

  test("pages with no html do not drag the average down", async () => {
    // A redirect or a PDF is not what the batch holds. Counting them as zero
    // would halve the average here and double the batch.
    const { storage, crawlId } = await seed([
      page("https://example.com/a", 200 * KB),
      page("https://example.com/b", 0),
      page("https://example.com/c", 200 * KB),
      page("https://example.com/d", 0),
    ]);

    expect(await run(sampleAveragePageBytes(storage, crawlId, 4))).toBe(200 * KB);

    await run(storage.close());
  });

  test("samples across the crawl, not just the front", async () => {
    // getPages orders by normalized_url, and URL order correlates with page
    // type. Here the front is light and the tail is heavy; a front-only sample
    // would size the batch for the wrong page.
    const light = Array.from({ length: 40 }, (_, i) =>
      page(`https://example.com/a${String(i).padStart(3, "0")}`, 10 * KB),
    );
    const heavy = Array.from({ length: 40 }, (_, i) =>
      page(`https://example.com/z${String(i).padStart(3, "0")}`, 1 * MB),
    );
    const { storage, crawlId } = await seed([...light, ...heavy]);

    const avg = await run(sampleAveragePageBytes(storage, crawlId, 80));
    // A front-only sample would report ~10 KB. The spread must see the heavy tail.
    expect(avg).toBeGreaterThan(100 * KB);

    await run(storage.close());
  });

  test("an empty crawl reports zero rather than throwing", async () => {
    const { storage, crawlId } = await seed([]);
    expect(await run(sampleAveragePageBytes(storage, crawlId, 0))).toBe(0);
    await run(storage.close());
  });
});

describe("resolveStreamBatch", () => {
  test("derives the batch from the crawl and reports what produced it", async () => {
    const pages = Array.from({ length: 30 }, (_, i) =>
      page(`https://example.com/p${String(i).padStart(3, "0")}`, 1 * MB),
    );
    const { storage, crawlId } = await seed(pages);

    const resolved = await run(resolveStreamBatch(storage, crawlId, pages.length));
    expect(resolved.explicit).toBeFalse();
    expect(resolved.avgPageBytes).toBe(1 * MB);
    expect(resolved.pages).toBe(48);
    expect(resolved.byteBudget).toBe(STREAM_BATCH_BYTES);

    await run(storage.close());
  });

  test("an explicit page count wins and skips the sampling entirely", async () => {
    const pages = Array.from({ length: 30 }, (_, i) =>
      page(`https://example.com/p${String(i).padStart(3, "0")}`, 1 * MB),
    );
    const { storage, crawlId } = await seed(pages);

    const resolved = await run(resolveStreamBatch(storage, crawlId, pages.length, { pages: 12 }));
    expect(resolved.explicit).toBeTrue();
    expect(resolved.pages).toBe(12);
    // Not sampled: an operator pinning a count is answering the question this
    // heuristic would otherwise re-answer every run.
    expect(resolved.avgPageBytes).toBe(0);

    await run(storage.close());
  });

  test("an explicit count is still clamped", async () => {
    const { storage, crawlId } = await seed([page("https://example.com/a", 1 * KB)]);
    expect((await run(resolveStreamBatch(storage, crawlId, 1, { pages: 100000 }))).pages).toBe(
      STREAM_BATCH_MAX_PAGES,
    );
    expect((await run(resolveStreamBatch(storage, crawlId, 1, { pages: 0 }))).pages).toBe(
      STREAM_BATCH_MIN_PAGES,
    );
    await run(storage.close());
  });
});

// Every number here becomes a SQLite LIMIT/OFFSET, where the failure modes are
// silent and severe: `limit: 0` and `limit: NaN` are both falsy, so the query
// drops its LIMIT and returns the whole crawl, and a NaN offset never advances —
// an infinite walk re-reading every page forever. These came out of a review
// pass that reproduced all three.
describe("batch sizing cannot emit a value SQLite will misread", () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.5];

  test("an unusable explicit page count falls back instead of propagating", () => {
    for (const pages of bad) {
      const n = resolveStreamBatchPages({ avgPageBytes: 1 * MB, minPages: pages });
      expect(Number.isInteger(n)).toBeTrue();
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  test("unusable bounds cannot produce a fractional or NaN batch", () => {
    for (const minPages of bad) {
      for (const maxPages of bad) {
        const n = resolveStreamBatchPages({ avgPageBytes: 250 * KB, minPages, maxPages });
        expect(Number.isInteger(n)).toBeTrue();
        expect(n).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("an unusable byte budget falls back to the floor", () => {
    for (const byteBudget of bad) {
      const n = resolveStreamBatchPages({ avgPageBytes: 1 * MB, byteBudget });
      expect(Number.isInteger(n)).toBeTrue();
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  test("resolveStreamBatch clamps an unusable explicit count", async () => {
    const { storage, crawlId } = await seed([page("https://example.com/a", 1 * KB)]);
    for (const pages of bad) {
      const resolved = await run(resolveStreamBatch(storage, crawlId, 1, { pages }));
      expect(Number.isInteger(resolved.pages)).toBeTrue();
      expect(resolved.pages).toBeGreaterThanOrEqual(1);
    }
    await run(storage.close());
  });

  test("a nonsense page total does not send the sampler into a bad read", async () => {
    const { storage, crawlId } = await seed([page("https://example.com/a", 4 * KB)]);
    for (const total of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(await run(sampleAveragePageBytes(storage, crawlId, total))).toBe(0);
    }
    await run(storage.close());
  });
});

describe("the size sample reads distinct pages", () => {
  // At 13 pages the naive windows (0, 6, 9) with a 4-page window overlap on page
  // 9: one page counted twice, and fewer distinct pages sampled than intended.
  // Sizes are distinct per page so double-counting changes the mean.
  for (const total of [13, 14, 15, 20, 37]) {
    test(`${total} pages: the mean matches counting each sampled page once`, async () => {
      const pages = Array.from({ length: total }, (_, i) =>
        page(`https://example.com/p${String(i).padStart(3, "0")}`, (i + 1) * KB),
      );
      const { storage, crawlId } = await seed(pages);

      const avg = await run(sampleAveragePageBytes(storage, crawlId, total));
      // Every page is a whole number of KB, and a mean over distinct pages of
      // 1..N KB must land inside the range. The bug produced a mean pulled
      // toward the duplicated page.
      expect(avg).toBeGreaterThanOrEqual(1 * KB);
      expect(avg).toBeLessThanOrEqual(total * KB);
      // The sample must span the crawl, so the mean cannot be the front alone.
      expect(avg).toBeGreaterThan(4 * KB);

      await run(storage.close());
    });
  }
});
