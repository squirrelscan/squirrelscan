// Crawl lease WRITE (#946, PR1): migration 35 adds owner_pid / owner_host /
// heartbeat_at to `crawls`, and the process driving a crawl beats them on a
// second connection. Nothing reads the lease yet, so these cover the writer and
// the additive migration only.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import type { CrawlMetadata } from "../src/storage/types";
import { releaseActiveLeases, startCrawlLease } from "../src/storage/crawl-lease";
import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const paths: string[] = [];
function tempDbPath(): string {
  const p = join(tmpdir(), `sq-lease-${randomUUID()}.db`);
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
  status: "running",
  config: {} as CrawlMetadata["config"],
  stats: STATS,
};

interface LeaseRow {
  owner_pid: number | null;
  owner_host: string | null;
  heartbeat_at: number | null;
}

function leaseOf(path: string, id: string): LeaseRow {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query("SELECT owner_pid, owner_host, heartbeat_at FROM crawls WHERE id = ?")
      .get(id) as LeaseRow;
  } finally {
    db.close();
  }
}

function columnsOf(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("PRAGMA table_info(crawls)").all() as { name: string }[]).map(
      (c) => c.name
    );
  } finally {
    db.close();
  }
}

/** A crawls table as v0.0.115-era CLIs wrote it: no lease columns. */
function seedOldDb(path: string, version: number): string {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE crawls (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      config TEXT NOT NULL,
      stats TEXT NOT NULL,
      retired_at INTEGER,
      report_status TEXT
    );
    CREATE TABLE schema_version (version INTEGER NOT NULL);
  `);
  db.query("INSERT INTO schema_version (version) VALUES (?)").run(version);
  const id = randomUUID();
  db.query(
    "INSERT INTO crawls (id, base_url, started_at, status, config, stats) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "https://e.test", 1_000, "completed", "{}", JSON.stringify(STATS));
  db.close();
  return id;
}

async function openStore(path: string): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(path);
  await run(store.init());
  return store;
}

describe("migration 35: lease columns", () => {
  test("a fresh database has the three columns, all NULL", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));
    expect(columnsOf(path)).toEqual(
      expect.arrayContaining(["owner_pid", "owner_host", "heartbeat_at"])
    );
    expect(leaseOf(path, id)).toEqual({
      owner_pid: null,
      owner_host: null,
      heartbeat_at: null,
    });
    await run(store.close());
  });

  test("a v34-era database opens with no manual step and keeps its rows", async () => {
    const path = tempDbPath();
    const id = seedOldDb(path, 34);

    const store = await openStore(path);
    expect(columnsOf(path)).toEqual(
      expect.arrayContaining(["owner_pid", "owner_host", "heartbeat_at"])
    );
    const crawls = await run(store.listCrawls());
    expect(crawls.map((c) => c.id)).toEqual([id]);
    expect(crawls[0]?.status).toBe("completed");
    expect(leaseOf(path, id).heartbeat_at).toBeNull();
    const v = new Database(path, { readonly: true })
      .query("SELECT version FROM schema_version")
      .get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    await run(store.close());
  });

  test("the columns are on the reconcile list: stamped current without them is repaired", async () => {
    const path = tempDbPath();
    const id = seedOldDb(path, SCHEMA_VERSION);

    const store = await openStore(path);
    expect(columnsOf(path)).toEqual(
      expect.arrayContaining(["owner_pid", "owner_host", "heartbeat_at"])
    );
    // A WRITE proves it: a missing column reads as undefined, an UPDATE throws.
    const lease = startCrawlLease({ dbPath: path, getCrawlId: () => id });
    expect(lease.beat()).toBe(true);
    lease.release();
    await run(store.close());
  });

  test("rollback: a db with the lease columns still works for an INSERT that names none of them", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    await run(store.close());

    // What an older CLI does: names its own columns only, reads by key.
    const db = new Database(path);
    db.query(
      "INSERT INTO crawls (id, base_url, started_at, status, config, stats) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("old-cli", "https://e.test", 1, "running", "{}", JSON.stringify(STATS));
    db.query("UPDATE crawls SET status = 'completed' WHERE id = 'old-cli'").run();
    db.close();

    const again = await openStore(path);
    const crawl = await run(again.getCrawl("old-cli"));
    expect(crawl?.status).toBe("completed");
    expect(leaseOf(path, "old-cli").owner_pid).toBeNull();
    await run(again.close());
  });
});

describe("startCrawlLease", () => {
  test("writes pid, host and heartbeat immediately", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));

    const lease = startCrawlLease({
      dbPath: path,
      getCrawlId: () => id,
      pid: 4242,
      host: "box-a",
      now: () => 111,
    });
    expect(leaseOf(path, id)).toEqual({
      owner_pid: 4242,
      owner_host: "box-a",
      heartbeat_at: 111,
    });
    lease.release();
    await run(store.close());
  });

  test("the heartbeat refreshes on the interval", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));

    let clock = 1_000;
    const lease = startCrawlLease({
      dbPath: path,
      getCrawlId: () => id,
      heartbeatMs: 20,
      now: () => clock,
    });
    expect(leaseOf(path, id).heartbeat_at).toBe(1_000);
    clock = 2_000;
    await Bun.sleep(150);
    expect(leaseOf(path, id).heartbeat_at).toBe(2_000);
    lease.release();
    await run(store.close());
  });

  test("waits for the crawl row: no id yet is a skipped beat, then it lands", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    let id: string | null = null;

    const lease = startCrawlLease({
      dbPath: path,
      getCrawlId: () => id,
      heartbeatMs: 20,
    });
    expect(lease.beat()).toBe(false);
    id = await run(store.createCrawl(meta));
    await Bun.sleep(150);
    expect(leaseOf(path, id).owner_pid).toBe(process.pid);
    lease.release();
    await run(store.close());
  });

  test("release clears the owner, keeps the last heartbeat, and is idempotent", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));

    const lease = startCrawlLease({
      dbPath: path,
      getCrawlId: () => id,
      now: () => 555,
    });
    lease.release();
    lease.release();
    expect(leaseOf(path, id)).toEqual({
      owner_pid: null,
      owner_host: null,
      heartbeat_at: 555,
    });
    // No timer left behind: a beat after release writes nothing.
    expect(lease.beat()).toBe(false);
    await run(store.close());
  });

  test("released on the error path: a finally that releases clears the lease", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));

    const lease = startCrawlLease({ dbPath: path, getCrawlId: () => id });
    try {
      expect(leaseOf(path, id).owner_pid).toBe(process.pid);
      throw new Error("crawl failed");
    } catch {
      // the command reports the failure
    } finally {
      lease.release();
    }
    expect(leaseOf(path, id).owner_pid).toBeNull();
    await run(store.close());
  });

  test("release leaves a lease another process has since taken", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));

    const lease = startCrawlLease({
      dbPath: path,
      getCrawlId: () => id,
      pid: 1,
      host: "box-a",
    });
    const other = new Database(path);
    other
      .query("UPDATE crawls SET owner_pid = 2, owner_host = 'box-b' WHERE id = ?")
      .run(id);
    other.close();
    lease.release();
    expect(leaseOf(path, id).owner_pid).toBe(2);
    await run(store.close());
  });

  test("releaseActiveLeases (signal path) clears the lease and a later beat does not re-assert it", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));
    const lease = startCrawlLease({
      dbPath: path,
      getCrawlId: () => id,
      heartbeatMs: 10,
      pid: 7,
    });
    expect(leaseOf(path, id).owner_pid).toBe(7);

    releaseActiveLeases();
    expect(leaseOf(path, id).owner_pid).toBeNull();
    // The timer is gone and an explicit beat is a no-op.
    expect(lease.beat()).toBe(false);
    await Bun.sleep(80);
    expect(leaseOf(path, id).owner_pid).toBeNull();
    await run(store.close());
  });

  test("a live foreign owner is not stolen; a stale or free lease is taken", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));
    const set = (pid: number | null, hb: number | null) => {
      const db = new Database(path);
      db.query(
        "UPDATE crawls SET owner_pid = ?, owner_host = 'other', heartbeat_at = ? WHERE id = ?"
      ).run(pid, hb, id);
      db.close();
    };
    const mk = () =>
      startCrawlLease({
        dbPath: path,
        getCrawlId: () => id,
        pid: 1,
        host: "me",
        now: () => 10_000_000,
      });

    set(2, 10_000_000 - 1_000); // fresh foreign beat
    let lease = mk();
    expect(lease.beat()).toBe(false);
    expect(leaseOf(path, id).owner_pid).toBe(2);
    lease.release();

    set(2, 10_000_000 - 10 * 60_000); // stale: a resume takes over a dead owner
    lease = mk();
    expect(leaseOf(path, id).owner_pid).toBe(1);
    lease.release();

    set(null, 5); // released earlier
    lease = mk();
    expect(leaseOf(path, id).owner_pid).toBe(1);
    lease.release();
    await run(store.close());
  });

  test("a busy database skips the beat after about 1 s instead of throwing or waiting 15 s", async () => {
    const path = tempDbPath();
    const store = await openStore(path);
    const id = await run(store.createCrawl(meta));
    const lease = startCrawlLease({ dbPath: path, getCrawlId: () => id });

    // Another process holding the write lock (retirement's delete txn, say).
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    const t0 = performance.now();
    expect(lease.beat()).toBe(false);
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThan(500);
    expect(waited).toBeLessThan(5_000);
    holder.exec("COMMIT");
    holder.close();

    expect(lease.beat()).toBe(true);
    lease.release();
    await run(store.close());
  });

  test("a non-file or missing database is a no-op and creates nothing", () => {
    expect(startCrawlLease({ dbPath: ":memory:", getCrawlId: () => "x" }).beat()).toBe(
      false
    );
    const missing = tempDbPath();
    const lease = startCrawlLease({ dbPath: missing, getCrawlId: () => "x" });
    expect(lease.beat()).toBe(false);
    lease.release();
    expect(existsSync(missing)).toBe(false);
  });
});
