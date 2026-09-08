// Migration 25 adds `crawls.retired_at` (#1912), and the column has to survive
// the failure mode that has now bitten `pages`, `sitemaps`, `robots_txt`,
// `links` and `sitemap_url_statuses` in turn: a DB stamped at or past the
// version by a build that numbered its own migration differently skips the ALTER
// forever. `reconcileColumns` re-adds it on open regardless of the counter.
//
// Getting this wrong is not a missing field. Every `listCrawls` SELECT is
// `SELECT *` mapped through `rowToCrawlMetadata`, so a DB without the column
// throws on `report`, on `report --list`, and on the prune itself.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import type { CrawlMetadata } from "../src/storage/types";
import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const paths: string[] = [];
function tempDbPath(): string {
  const p = join(tmpdir(), `sq-retired-${randomUUID()}.db`);
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        /* already gone */
      }
    }
  }
});

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

const meta: Omit<CrawlMetadata, "id"> = {
  baseUrl: "https://e.test",
  startedAt: 1_000,
  status: "completed",
  config: {} as CrawlMetadata["config"],
  stats: STATS,
};

/** A pre-migration store: the crawls table as it was, stamped at the CURRENT
 *  version so `runMigrations` will not touch it. This is the collision. */
function seedWithoutColumn(path: string): string {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE crawls (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      config TEXT NOT NULL,
      stats TEXT NOT NULL
    );
    CREATE TABLE schema_version (version INTEGER NOT NULL);
  `);
  db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  const id = randomUUID();
  db.query(
    "INSERT INTO crawls (id, base_url, started_at, status, config, stats) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "https://e.test", 1_000, "completed", "{}", JSON.stringify(STATS));
  db.close();
  return id;
}

describe("crawls.retired_at (#1912)", () => {
  test("a fresh database has the column and reads null as absent", async () => {
    const store = new SQLiteStorage(tempDbPath());
    await run(store.init());
    const id = await run(store.createCrawl(meta));

    const crawl = await run(store.getCrawl(id));
    // Not 0, not null: absent. Every existing audit is un-retired.
    expect(crawl?.retiredAt).toBeUndefined();
    await run(store.close());
  });

  test("an existing database gains the column on open", async () => {
    const path = tempDbPath();
    const id = seedWithoutColumn(path);

    const store = new SQLiteStorage(path);
    await run(store.init());

    // The read that would throw "no such column: retired_at" if the reconcile
    // had not run — and it is the read `report --list` makes.
    const crawls = await run(store.listCrawls());
    expect(crawls.map((c) => c.id)).toEqual([id]);
    expect(crawls[0]?.retiredAt).toBeUndefined();
    await run(store.close());
  });

  test("a pre-existing audit survives the migration and can then be retired", async () => {
    const path = tempDbPath();
    const id = seedWithoutColumn(path);

    const store = new SQLiteStorage(path);
    await run(store.init());
    await run(store.retireCrawls([id], 1_700_000_000_000));

    const crawl = await run(store.getCrawl(id));
    expect(crawl?.retiredAt).toBe(1_700_000_000_000);
    // The row itself is untouched otherwise: the audit is still listed.
    expect(crawl?.baseUrl).toBe("https://e.test");
    expect(crawl?.status).toBe("completed");
    await run(store.close());
  });

  test("the column is on the reconcile list, not only in a migration", () => {
    // The migration alone is not enough — that is the whole lesson of the four
    // tables this has already broken. Asserted by seeding a DB already stamped
    // at the current version, which the migration runner skips entirely.
    const path = tempDbPath();
    seedWithoutColumn(path);
    const before = new Database(path, { readonly: true });
    const had = (before.query("PRAGMA table_info(crawls)").all() as Array<{
      name: string;
    }>).some((c) => c.name === "retired_at");
    before.close();
    expect(had).toBe(false);

    const store = new SQLiteStorage(path);
    Effect.runSync(Effect.orDie(store.init()));
    const after = new Database(path, { readonly: true });
    const now = (after.query("PRAGMA table_info(crawls)").all() as Array<{
      name: string;
    }>).some((c) => c.name === "retired_at");
    after.close();
    expect(now).toBe(true);
    Effect.runSync(Effect.orDie(store.close()));
  });
});
