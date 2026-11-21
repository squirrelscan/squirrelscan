// The image entries of a sitemap URL have to survive the DB round trip, not merely be parsed (pub#2093).
// `parseSitemap` kept them, but `sitemap_urls` had no column for them, so images/sitemap-missing never
// saw one in a real audit and always skipped.
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
  const p = join(tmpdir(), `sq-sitemap-images-${randomUUID()}.db`);
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

const crawlMeta = {
  baseUrl: "https://example.com",
  startedAt: 1,
  status: "completed",
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
} as never;
const SITEMAP = "https://example.com/sitemap.xml";

describe("sitemap_urls image entries round trip (pub#2093)", () => {
  test("images and the truncation flag read back; an entry without images reads back without the keys", async () => {
    const store = new SQLiteStorage(tmpDbPath());
    await run(store.init());
    const crawlId = await run(store.createCrawl(crawlMeta));
    await run(
      store.addSitemapUrls(crawlId, [
        { sitemapUrl: SITEMAP, loc: "https://example.com/a", images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/a2.jpg"] },
        { sitemapUrl: SITEMAP, loc: "https://example.com/b", images: ["https://cdn.example.com/b.jpg"], imagesTruncated: true },
        { sitemapUrl: SITEMAP, loc: "https://example.com/c", lastmod: "2026-01-01" },
      ]),
    );
    const byLoc = new Map((await run(store.getSitemapUrls(crawlId, SITEMAP))).map((u) => [u.loc, u]));
    expect(byLoc.get("https://example.com/a")?.images).toEqual(["https://cdn.example.com/a.jpg", "https://cdn.example.com/a2.jpg"]);
    expect(byLoc.get("https://example.com/a")?.imagesTruncated).toBeUndefined();
    expect(byLoc.get("https://example.com/b")).toMatchObject({ images: ["https://cdn.example.com/b.jpg"], imagesTruncated: true });
    const c = byLoc.get("https://example.com/c");
    expect(c?.lastmod).toBe("2026-01-01");
    expect(c && "images" in c).toBe(false);
    expect(c && "imagesTruncated" in c).toBe(false);
    await run(store.close());
  });

  test("a pre-v49 row migrates and reads back with no image entries rather than throwing", async () => {
    const path = tmpDbPath();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE crawls (id TEXT PRIMARY KEY, base_url TEXT, started_at INTEGER);
      CREATE TABLE sitemap_urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, crawl_id TEXT NOT NULL, sitemap_url TEXT NOT NULL,
        loc TEXT NOT NULL, lastmod TEXT, changefreq TEXT, priority REAL
      );
      CREATE TABLE schema_version (version INTEGER);
      INSERT INTO crawls VALUES ('c1', 'https://example.com', 1);
      INSERT INTO sitemap_urls (crawl_id, sitemap_url, loc) VALUES ('c1', '${SITEMAP}', 'https://example.com/a');
      INSERT INTO schema_version VALUES (48);
    `);
    old.close();

    const store = new SQLiteStorage(path);
    await run(store.init());
    const got = await run(store.getSitemapUrls("c1", SITEMAP));
    expect(got).toHaveLength(1);
    expect(got[0]?.images).toBeUndefined();
    expect(got[0]?.imagesTruncated).toBeUndefined();
    // And the migrated table takes a write that names the new columns.
    await run(store.addSitemapUrls("c1", [{ sitemapUrl: SITEMAP, loc: "https://example.com/b", images: ["https://cdn.example.com/b.jpg"] }]));
    const after = await run(store.getSitemapUrls("c1", SITEMAP));
    expect(after.find((u) => u.loc === "https://example.com/b")?.images).toEqual(["https://cdn.example.com/b.jpg"]);
    await run(store.close());

    const check = new Database(path);
    const cols = (check.prepare("PRAGMA table_info(sitemap_urls)").all() as Array<{ name: string }>).map((col) => col.name);
    expect(cols).toEqual(expect.arrayContaining(["images", "images_truncated"]));
    const v = check.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    check.close();
  });

  test("a DB stamped at the current version without the columns self-heals on open", async () => {
    const path = tmpDbPath();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE crawls (id TEXT PRIMARY KEY, base_url TEXT, started_at INTEGER);
      CREATE TABLE sitemap_urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, crawl_id TEXT NOT NULL, sitemap_url TEXT NOT NULL,
        loc TEXT NOT NULL, lastmod TEXT, changefreq TEXT, priority REAL
      );
      CREATE TABLE schema_version (version INTEGER);
      INSERT INTO crawls VALUES ('c1', 'https://example.com', 1);
      INSERT INTO schema_version VALUES (${SCHEMA_VERSION});
    `);
    old.close();

    const store = new SQLiteStorage(path);
    await run(store.init());
    await run(store.addSitemapUrls("c1", [{ sitemapUrl: SITEMAP, loc: "https://example.com/a", images: ["https://cdn.example.com/a.jpg"] }]));
    expect((await run(store.getSitemapUrls("c1", SITEMAP)))[0]?.images).toEqual(["https://cdn.example.com/a.jpg"]);
    await run(store.close());
  });
});
