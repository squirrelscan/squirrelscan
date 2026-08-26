// Regression: the same migration renumbering gap that once dropped
// `pages.source_hash` (#839) also dropped `sitemaps.is_news_sitemap`. Migration
// 21 adds the column; a DB stamped past 21 by a build that numbered its own
// migration 21 never runs it, and `runMigrations` only runs when
// currentVersion < SCHEMA_VERSION. The first sitemap write then threw
// "table sitemaps has no column named is_news_sitemap" and the whole audit
// failed at the crawl's first step. The reconciler now covers `sitemaps` too.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { Effect } from "effect";

import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `squirrel-sitemaps-${randomUUID()}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore missing temp files
    }
  }
});

function sitemapColumns(path: string): string[] {
  const db = new Database(path);
  const cols = (db.prepare("PRAGMA table_info(sitemaps)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  db.close();
  return cols;
}

// The exact broken state seen on real DBs: `sitemaps` as it was before
// migration 21, and schema_version already at the current version, so the
// version-gated runner will never add the column.
function buildCollisionDb(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE crawls (
      id TEXT PRIMARY KEY, base_url TEXT NOT NULL, seed_url TEXT, original_url TEXT,
      started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL,
      config TEXT NOT NULL, stats TEXT NOT NULL
    );
    CREATE TABLE pages (
      crawl_id TEXT NOT NULL, url TEXT NOT NULL, normalized_url TEXT NOT NULL,
      final_url TEXT, depth INTEGER NOT NULL, parent_url TEXT, redirect_chain TEXT,
      status INTEGER NOT NULL, content_type TEXT, size_bytes INTEGER NOT NULL,
      load_time_ms INTEGER NOT NULL, ttfb INTEGER, download_time INTEGER,
      fetched_at INTEGER NOT NULL, etag TEXT, last_modified TEXT,
      content_hash TEXT NOT NULL, html TEXT, parsed_data TEXT, headers TEXT NOT NULL,
      security_headers TEXT NOT NULL, request_headers TEXT,
      fetcher_id TEXT, fallback_reason TEXT, source_hash TEXT,
      PRIMARY KEY (crawl_id, normalized_url)
    );
    CREATE TABLE sitemaps (
      crawl_id TEXT NOT NULL, url TEXT NOT NULL, type TEXT NOT NULL,
      url_count INTEGER NOT NULL, child_sitemaps TEXT NOT NULL, errors TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (crawl_id, url)
    );
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION});
  `);
  legacy.close();
}

describe("sitemaps.is_news_sitemap migration collision self-heal", () => {
  test("opening a current-version DB that skipped migration 21 adds the column", async () => {
    const path = tmpDbPath();
    buildCollisionDb(path);
    expect(sitemapColumns(path)).not.toContain("is_news_sitemap");

    const store = new SQLiteStorage(path);
    await run(store.init());
    await run(store.close());

    expect(sitemapColumns(path)).toContain("is_news_sitemap");
  });

  test("reconcile is idempotent: re-opening a healthy DB leaves sitemaps columns unchanged", async () => {
    const path = tmpDbPath();

    const store = new SQLiteStorage(path);
    await run(store.init());
    await run(store.close());
    const first = sitemapColumns(path);
    expect(first).toContain("is_news_sitemap");

    const store2 = new SQLiteStorage(path);
    await run(store2.init());
    await run(store2.close());

    expect(sitemapColumns(path)).toEqual(first);
  });
});
