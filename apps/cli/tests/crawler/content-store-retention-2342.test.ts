// repo#2342: the content store's LRU cap used to apply mid-audit, so a crawl
// whose pages outgrew it evicted its own earliest pages before the rules phase
// read them back, and they dropped out of the audit without a word. A run now
// holds a retention lease: prune() never evicts a row stored or read since the
// oldest live lease began, in this process or any other sharing the store.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_STORE_MAX_BYTES_ENV,
  ContentStore,
  resolveContentStoreCap,
} from "@/crawler/storage/content-store";

/** Incompressible bodies, so the cap binds after a predictable number of puts. */
function noise(bytes: number): string {
  let out = "";
  while (out.length < bytes) out += Math.random().toString(36).slice(2);
  return out.slice(0, bytes);
}

/** Counts full-store aggregate scans (see content-store-prune-scan.test.ts). */
function countAggregateScans(store: ContentStore): () => number {
  const db = (store as unknown as { getDb: () => Database }).getDb();
  const realPrepare = db.prepare.bind(db);
  let scans = 0;
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (
    sql: string
  ) => {
    if (sql.includes("SUM(compressed_size)")) scans++;
    return realPrepare(sql);
  };
  return () => scans;
}

function leaseCount(path: string): number {
  const side = new Database(path);
  try {
    return (
      side.prepare("SELECT COUNT(*) AS n FROM retention_leases").get() as {
        n: number;
      }
    ).n;
  } finally {
    side.close();
  }
}

/** Push every row's last_accessed into the past, as an earlier audit left it. */
function ageAllRows(path: string, at = 1_000_000): void {
  const side = new Database(path);
  side.prepare("UPDATE content SET last_accessed = ?").run(at);
  side.close();
}

const CAP = 100_000; // prune at 90 KB, down to 80 KB
const PAGE = 8_000;

let dir: string;
const stores: ContentStore[] = [];
const open = (name = "store.db", cap = CAP) => {
  const store = new ContentStore(join(dir, name), cap);
  stores.push(store);
  return store;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "content-store-retention-"));
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("content store retention lease (#2342)", () => {
  test("a run that outgrows the cap keeps every page it stored", () => {
    const store = open();
    const release = store.beginRetention();
    const hashes = Array.from({ length: 30 }, (_, i) =>
      store.put(`<html>${i} ${noise(PAGE)}</html>`, "text/html")
    );
    // 30 x 8 KB is well past a 100 KB cap, and nothing this run stored went.
    expect(hashes.every((h) => store.has(h))).toBe(true);
    expect(store.getStats().totalBytes).toBeGreaterThan(CAP);
    expect(store.getLastEviction()).toBeNull();
    release();
  });

  test("the control: without a lease the same run evicts its own first pages", () => {
    const store = open();
    const hashes = Array.from({ length: 30 }, (_, i) =>
      store.put(`<html>${i} ${noise(PAGE)}</html>`, "text/html")
    );
    expect(store.has(hashes[0]!)).toBe(false);
    expect(store.getLastEviction()?.entries).toBeGreaterThan(0);
  });

  test("pages from an earlier run are still evictable, oldest first", () => {
    const path = join(dir, "store.db");
    const earlier = open();
    const old = Array.from({ length: 10 }, () =>
      earlier.put(noise(PAGE), "text/html")
    );
    earlier.close();
    ageAllRows(path);

    const store = open();
    const release = store.beginRetention();
    const mine = Array.from({ length: 10 }, () =>
      store.put(noise(PAGE), "text/html")
    );
    expect(mine.every((h) => store.has(h))).toBe(true);
    // The earlier run's pages paid for this one's.
    expect(old.filter((h) => store.has(h)).length).toBeLessThan(old.length);
    release();
  });

  test("a page the run READS is protected too, an untouched one is not", () => {
    const path = join(dir, "store.db");
    const earlier = open();
    const read = earlier.put(noise(PAGE), "text/html");
    const untouched = earlier.put(noise(PAGE), "text/html");
    earlier.close();
    ageAllRows(path);

    const store = open();
    const release = store.beginRetention();
    expect(store.get(read)).not.toBeNull();
    for (let i = 0; i < 20; i++) store.put(noise(PAGE), "text/html");
    expect(store.has(read)).toBe(true);
    expect(store.has(untouched)).toBe(false);
    release();
  });

  test("touch() protects pages stored before the lease, as a resume needs", () => {
    // A resumed crawl skips the pages it stored before the interruption and
    // reads them again only in the rules phase; touch() is what keeps its own
    // puts from evicting them first.
    const path = join(dir, "store.db");
    const earlier = open();
    const kept = Array.from({ length: 4 }, () =>
      earlier.put(noise(PAGE), "text/html")
    );
    const other = Array.from({ length: 4 }, () =>
      earlier.put(noise(PAGE), "text/html")
    );
    earlier.close();
    ageAllRows(path);

    const store = open();
    const release = store.beginRetention();
    expect(store.touch([...kept, "no-such-hash"])).toBe(kept.length);
    for (let i = 0; i < 12; i++) store.put(noise(PAGE), "text/html");
    expect(kept.every((h) => store.has(h))).toBe(true);
    expect(other.every((h) => store.has(h))).toBe(false);
    release();
  });

  test("another process's live lease protects its pages from this one's prune", () => {
    const other = open();
    const releaseOther = other.beginRetention();
    const theirs = Array.from({ length: 10 }, () =>
      other.put(noise(PAGE), "text/html")
    );

    // A second instance on the same file stands in for a second CLI process.
    const store = open();
    for (let i = 0; i < 10; i++) store.put(noise(PAGE), "text/html");
    expect(theirs.every((h) => store.has(h))).toBe(true);
    releaseOther();
  });

  test("a lease whose holder died lapses and stops protecting", () => {
    const path = join(dir, "store.db");
    const store = open();
    const theirs = Array.from({ length: 10 }, () =>
      store.put(noise(PAGE), "text/html")
    );
    // A lease left by a killed process: its heartbeat stopped three hours ago.
    const side = new Database(path);
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    side
      .prepare(
        "INSERT INTO retention_leases (id, since, heartbeat, pid) VALUES ('dead', ?, ?, 1)"
      )
      .run(threeHoursAgo - 1, threeHoursAgo);
    side.close();
    ageAllRows(path, threeHoursAgo + 1);

    for (let i = 0; i < 10; i++) store.put(noise(PAGE), "text/html");
    expect(theirs.filter((h) => store.has(h)).length).toBeLessThan(
      theirs.length
    );
    expect(leaseCount(path)).toBe(0);
  });

  test("after release the next put prunes back under the cap and records it", () => {
    const store = open();
    const release = store.beginRetention();
    for (let i = 0; i < 30; i++) store.put(noise(PAGE), "text/html");
    release();

    const before = Date.now();
    store.put(noise(PAGE), "text/html");
    expect(store.getStats().totalBytes).toBeLessThan(CAP * 0.9);
    const eviction = store.getLastEviction();
    expect(eviction?.entries).toBeGreaterThan(0);
    expect(eviction?.bytes).toBeGreaterThan(0);
    expect(eviction?.at).toBeGreaterThanOrEqual(before);
  });

  test("closing the store releases its lease", () => {
    const path = join(dir, "store.db");
    const store = open();
    store.beginRetention();
    expect(leaseCount(path)).toBe(1);
    store.close();
    expect(leaseCount(path)).toBe(0);
  });

  test("a prune the lease blocked does not rescan the store on every put", () => {
    // #1908's quadratic, reintroduced by protection: past the threshold with
    // nothing evictable, each put would re-read the aggregate and find the same
    // protected rows.
    const store = open("scan.db", 1_000_000);
    const release = store.beginRetention();
    // Past the prune threshold (900 KB), so the first blocked prune has run.
    while (store.getStats().totalBytes < 950_000) {
      store.put(noise(PAGE), "text/html");
    }
    expect(store.getLastEviction()).toBeNull();
    const scans = countAggregateScans(store);
    for (let i = 0; i < 40; i++) store.put(noise(PAGE), "text/html");
    // 40 puts of 8 KB grow the store by 320 KB, far inside the retry window
    // (16 MB at least), so after one re-seed of the running total nothing
    // rescans. One per put would be 40.
    expect(scans()).toBeLessThanOrEqual(1);
    release();
  });
});

describe("resolveContentStoreCap (#2342)", () => {
  const saved = process.env[CONTENT_STORE_MAX_BYTES_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[CONTENT_STORE_MAX_BYTES_ENV];
    else process.env[CONTENT_STORE_MAX_BYTES_ENV] = saved;
  });

  test("env beats config beats the 1 GB default", () => {
    delete process.env[CONTENT_STORE_MAX_BYTES_ENV];
    expect(resolveContentStoreCap()).toEqual({
      bytes: 1024 ** 3,
      source: "default",
    });
    expect(resolveContentStoreCap(5_000)).toEqual({
      bytes: 5_000,
      source: "config",
    });
    process.env[CONTENT_STORE_MAX_BYTES_ENV] = "2GB";
    expect(resolveContentStoreCap(5_000)).toEqual({
      bytes: 2 * 1024 ** 3,
      source: "env",
    });
  });

  test("an unparseable env value is ignored, not fatal", () => {
    process.env[CONTENT_STORE_MAX_BYTES_ENV] = "plenty";
    expect(resolveContentStoreCap(5_000)).toEqual({
      bytes: 5_000,
      source: "config",
    });
  });

  test("a store opened with no explicit cap takes the env value", () => {
    process.env[CONTENT_STORE_MAX_BYTES_ENV] = "64KB";
    const store = new ContentStore(join(dir, "env.db"));
    stores.push(store);
    expect(store.getMaxBytes()).toBe(64 * 1024);
    expect(store.getCapSource()).toBe("env");
  });
});
