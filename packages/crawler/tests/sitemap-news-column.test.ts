// The news-sitemap flag has to survive the DB round trip, not merely be parsed (#115).
//
// This is where the bug actually lived. `parseSitemap` was setting `isNewsSitemap` correctly and the
// rule was reading it correctly, and the finding STILL fired on a live site — because the flag was
// dropped at the storage seam: the stored record had no such column, and the audit adapter rebuilds
// its sitemap list field-by-field from that record. A parse-only test passes while the whole feature
// does nothing.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";

const paths: string[] = [];
const tmpDbPath = () => {
  const p = join(tmpdir(), `sq-news-${randomUUID()}.db`);
  paths.push(p);
  return p;
};
afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        unlinkSync(p + suffix);
      } catch {}
    }
  }
});
const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

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
const crawlMeta = {
  baseUrl: "https://example.com",
  startedAt: 1,
  status: "completed",
  config: {},
  stats: STATS,
} as never;

describe("is_news_sitemap round trip", () => {
  test("a fresh DB stores and reads back the flag, both ways", async () => {
    const store = new SQLiteStorage(tmpDbPath());
    await run(store.init());
    const crawlId = await run(store.createCrawl(crawlMeta));
    const base = { type: "urlset" as const, urlCount: 3, childSitemaps: [], errors: [], fetchedAt: 1 };
    await run(store.addSitemap(crawlId, { ...base, url: "https://example.com/news.xml", isNewsSitemap: true }));
    await run(store.addSitemap(crawlId, { ...base, url: "https://example.com/sitemap.xml", isNewsSitemap: false }));

    const got = await run(store.getSitemaps(crawlId));
    const byUrl = new Map(got.map((s) => [s.url, s]));
    expect(byUrl.get("https://example.com/news.xml")?.isNewsSitemap).toBe(true);
    expect(byUrl.get("https://example.com/sitemap.xml")?.isNewsSitemap).toBe(false);
    await run(store.close());
  });

  test("an omitted flag reads back false, never undefined — the rule branches on it", async () => {
    const store = new SQLiteStorage(tmpDbPath());
    await run(store.init());
    const crawlId = await run(store.createCrawl(crawlMeta));
    await run(
      store.addSitemap(crawlId, {
        url: "https://example.com/sitemap.xml",
        type: "urlset",
        urlCount: 1,
        childSitemaps: [],
        errors: [],
        fetchedAt: 1,
      }),
    );
    expect((await run(store.getSitemaps(crawlId)))[0]?.isNewsSitemap).toBe(false);
    await run(store.close());
  });

  /**
   * Rows written before v21 have NULL in the new column. They must read back as "not a news sitemap",
   * which is exactly the behaviour those rows were stored under.
   */
  test("a pre-v21 row migrates and reads back false rather than throwing", async () => {
    const path = tmpDbPath();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE crawls (id TEXT PRIMARY KEY, base_url TEXT, started_at INTEGER);
      CREATE TABLE sitemaps (
        crawl_id TEXT NOT NULL, url TEXT NOT NULL, type TEXT NOT NULL, url_count INTEGER NOT NULL,
        child_sitemaps TEXT NOT NULL, errors TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (crawl_id, url)
      );
      CREATE TABLE schema_version (version INTEGER);
      INSERT INTO crawls VALUES ('c1', 'https://example.com', 1);
      INSERT INTO sitemaps VALUES ('c1', 'https://example.com/sitemap.xml', 'urlset', 5, '[]', '[]', 1);
      INSERT INTO schema_version VALUES (20);
    `);
    old.close();

    const store = new SQLiteStorage(path);
    await run(store.init());
    const got = await run(store.getSitemaps("c1"));
    expect(got).toHaveLength(1);
    expect(got[0]?.isNewsSitemap).toBe(false);
    expect(got[0]?.urlCount).toBe(5);
    await run(store.close());

    const check = new Database(path);
    const cols = (
      check.prepare("PRAGMA table_info(sitemaps)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("is_news_sitemap");
    const v = check.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    check.close();
  });
});
