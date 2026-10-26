// Migration 36 stores the exact report scan scope on a crawl. These checks
// cover the normal v35 upgrade, the reconcile path for a database stamped at
// the current version without the column, and older-CLI writes after upgrade.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import type { CrawlMetadata } from "../src/storage/types";
import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";

function run<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never, never>);
}

const paths: string[] = [];

function tempDbPath(): string {
  const path = join(tmpdir(), `sq-scan-scope-${randomUUID()}.db`);
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch {
        // Already removed.
      }
    }
  }
});

const STATS = {
  pagesTotal: 1,
  pagesFetched: 1,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function seedWithoutScanScope(path: string, version: number): string {
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
  db.query("INSERT INTO schema_version (version) VALUES (?)").run(version);
  const id = randomUUID();
  db.query(
    "INSERT INTO crawls (id, base_url, started_at, status, config, stats) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "https://e.test", 1, "completed", "{}", JSON.stringify(STATS));
  db.close();
  return id;
}

function columnsOf(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("PRAGMA table_info(crawls)").all() as { name: string }[]).map(
      (column) => column.name
    );
  } finally {
    db.close();
  }
}

async function openStore(path: string): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(path);
  await run(store.init());
  return store;
}

describe("migration 36: stored scan scope", () => {
  test("a v35 database gains the column, keeps rows, and reads no invented scope", async () => {
    const path = tempDbPath();
    const id = seedWithoutScanScope(path, 35);

    const store = await openStore(path);
    expect(columnsOf(path)).toContain("scan_scope");
    const crawl = await run(store.getCrawl(id));
    expect(crawl?.id).toBe(id);
    expect(crawl?.scanScope).toBeUndefined();
    const db = new Database(path, { readonly: true });
    const version = db.query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    db.close();
    expect(version.version).toBe(SCHEMA_VERSION);
    await run(store.close());
  });

  test("the reconcile list repairs a current-version database missing the column", async () => {
    const path = tempDbPath();
    const id = seedWithoutScanScope(path, SCHEMA_VERSION);
    const store = await openStore(path);
    const scanScope: NonNullable<CrawlMetadata["scanScope"]> = {
      origin: "cli",
      maxPages: 10,
      pagesCrawled: 10,
      capped: true,
    };

    await run(store.updateCrawl(id, { scanScope }));
    expect((await run(store.getCrawl(id)))?.scanScope).toEqual(scanScope);
    await run(store.close());
  });

  test("an older CLI can still insert a crawl while omitting scan_scope", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    await run(store.close());

    const db = new Database(path);
    db.query(
      "INSERT INTO crawls (id, base_url, started_at, status, config, stats) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("old-cli", "https://e.test", 1, "completed", "{}", JSON.stringify(STATS));
    db.close();

    const reopened = await openStore(path);
    expect((await run(reopened.getCrawl("old-cli")))?.scanScope).toBeUndefined();
    await run(reopened.close());
  });
});
