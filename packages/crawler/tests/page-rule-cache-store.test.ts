// The SQL half of the per-page rule-result cache (#1990).
//
// The engine's parity gate runs against an in-memory store, so nothing there
// exercises the statements: the gzip round-trip, the newest-row-wins lookup, the
// carry-forward copy, or the retirement that keeps project.db from growing a
// permanent second copy of every audit.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { SQLiteStorage } from "../src/storage/sqlite";
import type { CrawlMetadata, PageRecord } from "../src/storage/types";

const STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

const crawlMeta = (startedAt: number): Omit<CrawlMetadata, "id"> => ({
  baseUrl: "http://x.test",
  startedAt,
  status: "completed",
  config: {} as CrawlMetadata["config"],
  stats: STATS,
});

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "squirrelscan-prc-")), `${name}.sqlite`);
}

async function withStorage<T>(fn: (s: SQLiteStorage, crawlId: string) => Promise<T>): Promise<T> {
  const dir = tmpDb("store");
  const storage = new SQLiteStorage(dir);
  try {
    await run(storage.init());
    const crawlId = await run(
      storage.createCrawl(crawlMeta(1_000)));
    return await fn(storage, crawlId);
  } finally {
    await run(storage.close());
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

describe("page_rule_cache storage", () => {
  test("round-trips a payload through gzip", async () => {
    await withStorage(async (storage, crawlId) => {
      const payload = JSON.stringify({ ruleResults: [["core/meta-title", []]], big: "x".repeat(5000) });
      await run(
        storage.savePageRuleCacheBatch(crawlId, [
          { normalizedUrl: "http://x.test/a", cacheKey: "k1", payload },
        ])
      );
      const loaded = await run(storage.loadPageRuleCache(["k1", "missing"]));
      expect(loaded.get("k1")).toBe(payload);
      expect(loaded.has("missing")).toBe(false);
    });
  });

  test("an empty key list does no query and returns nothing", async () => {
    await withStorage(async (storage) => {
      expect((await run(storage.loadPageRuleCache([]))).size).toBe(0);
    });
  });

  test("carry-forward copies the row into a new crawl without re-encoding", async () => {
    await withStorage(async (storage, firstCrawl) => {
      const payload = JSON.stringify({ ruleResults: [], marker: "original" });
      await run(
        storage.savePageRuleCacheBatch(firstCrawl, [
          { normalizedUrl: "http://x.test/a", cacheKey: "k1", payload },
        ])
      );
      const secondCrawl = await run(
        storage.createCrawl(crawlMeta(2_000)));
      await run(
        storage.carryForwardPageRuleCache(secondCrawl, [
          { normalizedUrl: "http://x.test/a", cacheKey: "k1" },
        ])
      );
      // Retiring the crawl the entry came FROM must not lose it: that is the whole
      // point of carrying it forward.
      await run(storage.retireCrawls([firstCrawl]));
      const loaded = await run(storage.loadPageRuleCache(["k1"]));
      expect(loaded.get("k1")).toBe(payload);
    });
  });

  test("carrying forward a key with no row is a no-op, not an error", async () => {
    await withStorage(async (storage, crawlId) => {
      await run(
        storage.carryForwardPageRuleCache(crawlId, [
          { normalizedUrl: "http://x.test/gone", cacheKey: "never-stored" },
        ])
      );
      expect((await run(storage.loadPageRuleCache(["never-stored"]))).size).toBe(0);
    });
  });

  test("retiring a crawl reclaims its cache rows", async () => {
    await withStorage(async (storage, crawlId) => {
      await run(
        storage.savePageRuleCacheBatch(crawlId, [
          { normalizedUrl: "http://x.test/a", cacheKey: "k1", payload: "{}" },
          { normalizedUrl: "http://x.test/b", cacheKey: "k2", payload: "{}" },
        ])
      );
      const preview = await run(storage.previewRetireCrawls([crawlId]));
      expect(preview.rowsByTable.page_rule_cache).toBe(2);
      await run(storage.retireCrawls([crawlId]));
      expect((await run(storage.loadPageRuleCache(["k1", "k2"]))).size).toBe(0);
    });
  });

  // Two crawls holding a row for one key is the ordinary steady state, and the
  // lookup must resolve to exactly one payload. WHICH one is deliberately not
  // asserted: the key covers every input that determines the payload, so rows
  // sharing a key hold the same bytes. Pinning "newest" would be pinning SQLite's
  // tie-break on two rows written in the same millisecond, which is the index
  // plan's choice and not the query's.
  test("a key held by two crawls resolves to one payload", async () => {
    await withStorage(async (storage, firstCrawl) => {
      const payload = '{"gen":"identical-by-construction"}';
      await run(
        storage.savePageRuleCacheBatch(firstCrawl, [
          { normalizedUrl: "http://x.test/a", cacheKey: "k1", payload },
        ])
      );
      const secondCrawl = await run(storage.createCrawl(crawlMeta(2_000)));
      await run(
        storage.savePageRuleCacheBatch(secondCrawl, [
          { normalizedUrl: "http://x.test/a", cacheKey: "k1", payload },
        ])
      );
      const loaded = await run(storage.loadPageRuleCache(["k1"]));
      expect(loaded.size).toBe(1);
      expect(loaded.get("k1")).toBe(payload);
    });
  });

  // SQLite's default bound-parameter limit is 32k; a page batch on a large crawl
  // plus a caller that batched more aggressively would blow past it as one IN list.
  test("a key list larger than one chunk is still resolved in full", async () => {
    await withStorage(async (storage, crawlId) => {
      const entries = Array.from({ length: 950 }, (_, i) => ({
        normalizedUrl: `http://x.test/${i}`,
        cacheKey: `k${i}`,
        payload: `{"i":${i}}`,
      }));
      await run(storage.savePageRuleCacheBatch(crawlId, entries));
      const loaded = await run(storage.loadPageRuleCache(entries.map((e) => e.cacheKey)));
      expect(loaded.size).toBe(950);
      expect(loaded.get("k949")).toBe('{"i":949}');
    });
  });
});

describe("pages.html_hash", () => {
  // The exact-bytes identity the cache key needs. Without a content store there is
  // none, and the cache simply does not engage — which must read as null rather
  // than as the NORMALIZED content hash, or a whitespace-only edit would look
  // unchanged.
  test("is null without a content store, and the exact hash with one", async () => {
    const dir = tmpDb("hash");
    const blobs = new Map<string, string>();
    const contentStore = {
      put(content: string) {
        const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
        blobs.set(hash, content);
        return hash;
      },
      getString(hash: string) {
        return blobs.get(hash) ?? null;
      },
    };

    const bare = new SQLiteStorage(dir);
    await run(bare.init());
    const crawlId = await run(bare.createCrawl(crawlMeta(1_000)));
    const page: PageRecord = {
      url: "http://x.test/a",
      normalizedUrl: "http://x.test/a",
      finalUrl: "http://x.test/a",
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 20,
      loadTimeMs: 5,
      fetchedAt: 1,
      etag: null,
      lastModified: null,
      contentHash: "normalized-hash",
      html: "<html> <body>hi</body></html>",
      parsedData: null,
      headers: {} as never,
      securityHeaders: {} as never,
    };
    await run(bare.upsertPage(crawlId, page));
    expect((await run(bare.getPage(crawlId, page.normalizedUrl)))!.htmlHash).toBeNull();
    await run(bare.close());

    const withStore = new SQLiteStorage(dir, contentStore);
    await run(withStore.init());
    await run(withStore.upsertPage(crawlId, page));
    const stored = await run(withStore.getPage(crawlId, page.normalizedUrl));
    const expected = new Bun.CryptoHasher("sha256").update(page.html!).digest("hex");
    expect(stored!.htmlHash).toBe(expected);
    // Whitespace-only edit: the exact hash moves even though a normalized one
    // would not. This is the property the cache key depends on.
    const reformatted = { ...page, html: "<html>  <body>hi</body></html>" };
    await run(withStore.upsertPage(crawlId, reformatted));
    const after = await run(withStore.getPage(crawlId, page.normalizedUrl));
    expect(after!.htmlHash).not.toBe(expected);
    await run(withStore.close());
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });
});
