// Migration 39 stores the report's JavaScript shipped block on a crawl
// (squirrelscan/repo#3397), so a later `squirrel report` shows the same line.
// Same three paths as migration 36: the upgrade, the reconcile list, and an
// older CLI's insert.

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
  const path = join(tmpdir(), `sq-javascript-${randomUUID()}.db`);
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

const JAVASCRIPT: NonNullable<CrawlMetadata["javascript"]> = {
  scripts: 2,
  bytes: 3000,
  thirdPartyBytes: 1000,
  unmeasured: 1,
  framework: { id: "nextjs", name: "Next.js", bytes: 2000 },
  heaviestPages: [{ url: "https://e.test/", bytes: 3000, scripts: 2 }],
};

function seedCrawl(path: string, version: number): string {
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

describe("migration 39: stored JavaScript shipped block", () => {
  test("a v38 database gains the column, keeps rows, and reads no invented block", async () => {
    const path = tempDbPath();
    const id = seedCrawl(path, 38);

    const store = await openStore(path);
    expect(columnsOf(path)).toContain("javascript_shipped");
    const crawl = await run(store.getCrawl(id));
    expect(crawl?.id).toBe(id);
    expect(crawl?.javascript).toBeUndefined();
    await run(store.close());
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
  });

  test("the block round-trips through updateCrawl, with the status beside it", async () => {
    const path = tempDbPath();
    const id = seedCrawl(path, SCHEMA_VERSION);
    const store = await openStore(path);

    await run(store.updateCrawl(id, { status: "analyzed", javascript: JAVASCRIPT }));
    const crawl = await run(store.getCrawl(id));
    expect(crawl?.status).toBe("analyzed");
    expect(crawl?.javascript).toEqual(JAVASCRIPT);
    await run(store.close());
  });

  test("an older CLI can still insert a crawl while omitting the column", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    await run(store.close());

    const db = new Database(path);
    db.query(
      "INSERT INTO crawls (id, base_url, started_at, status, config, stats) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("old-cli", "https://e.test", 1, "completed", "{}", JSON.stringify(STATS));
    db.close();

    const reopened = await openStore(path);
    expect((await run(reopened.getCrawl("old-cli")))?.javascript).toBeUndefined();
    await run(reopened.close());
  });
});
