// Regression tests for #1908: the prune check must not scan the whole content
// store on every stored page.
//
// Before #1908 every put() that stored new content ended in getStats(), whose
// COUNT/SUM aggregate walks the entire table (or, since #246, the whole
// covering index). That made a crawl's speed a function of the user's lifetime
// cache size, and quadratic within one large crawl. The store now keeps a
// running total seeded by ONE authoritative scan per process and only re-reads
// the aggregate at the prune threshold.

import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "@/crawler/storage/content-store";

/** Random-ish bodies so gzip cannot collapse them and sizes stay predictable. */
function noise(bytes: number): string {
  let out = "";
  while (out.length < bytes) out += Math.random().toString(36).slice(2);
  return out.slice(0, bytes);
}

/**
 * Count executions of the prune check's aggregate, whoever issues them.
 *
 * Counting getStats() calls would pass a refactor that inlined the same SQL
 * somewhere else, so this hooks the statement instead: every aggregate over
 * compressed_size is a full walk of the store and is what #1908 is about.
 */
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

describe("content store prune check (#1908)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `content-store-scan-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (process.platform !== "win32" && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("storing many pages scans the aggregate once, not once per page", () => {
    const store = new ContentStore(join(testDir, "scan-count.db"), 8_000_000);
    try {
      const scans = countAggregateScans(store);
      for (let i = 0; i < 50; i++) {
        store.put(
          `<html><body>page ${i} ${noise(2_000)}</body></html>`,
          "text/html"
        );
      }

      // One seed scan for the whole process. 50 would mean the per-put scan is
      // back; anything above 1 without a prune in between is a regression.
      expect(scans()).toBe(1);
      expect(store.getStats().totalEntries).toBe(50);
    } finally {
      store.close();
    }
  });

  test("a dedupe hit still costs no scan at all", () => {
    const store = new ContentStore(join(testDir, "dedupe.db"), 8_000_000);
    try {
      const body = `<html>${noise(2_000)}</html>`;
      store.put(body, "text/html");
      const scans = countAggregateScans(store);
      for (let i = 0; i < 20; i++) store.put(body, "text/html");
      expect(scans()).toBe(0);
    } finally {
      store.close();
    }
  });

  test("the store is still pruned once the running total reaches the threshold", () => {
    // 100 KB cap -> prune at 90 KB, down to 80 KB.
    const store = new ContentStore(join(testDir, "threshold.db"), 100_000);
    try {
      for (let i = 0; i < 60; i++) store.put(noise(4_000), "text/html");

      const stats = store.getStats();
      expect(stats.totalBytes).toBeLessThan(100_000 * 0.9);
      expect(stats.totalEntries).toBeLessThan(60);
    } finally {
      store.close();
    }
  });

  test("pruning still evicts least-recently-accessed entries first", () => {
    const dbPath = join(testDir, "lru.db");
    const store = new ContentStore(dbPath, 100_000);
    try {
      const hashes: string[] = [];
      for (let i = 0; i < 15; i++) {
        hashes.push(store.put(noise(8_000), "text/html"));
      }

      // Date.now() can tie across puts in the same millisecond, which would
      // leave the eviction order undefined. Spread last_accessed explicitly.
      const side = new Database(dbPath);
      const touch = side.prepare(
        "UPDATE content SET last_accessed = ? WHERE hash = ?"
      );
      for (const [i, hash] of hashes.entries()) {
        touch.run(1_000_000 + i * 1_000, hash);
      }
      side.close();

      // Push past the threshold so a prune runs.
      for (let i = 0; i < 8; i++) store.put(noise(8_000), "text/html");

      expect(store.has(hashes[0]!)).toBe(false);
      expect(store.has(hashes[1]!)).toBe(false);
      expect(store.has(hashes[hashes.length - 1]!)).toBe(true);
      expect(store.getStats().totalBytes).toBeLessThan(100_000 * 0.9);
    } finally {
      store.close();
    }
  });

  test("prune() reaches the target even when one batch is not enough", () => {
    // A single 1000-row batch used to be the whole pass, so a store holding
    // many small entries stayed above the threshold after "pruning" and pruned
    // again on the very next stored page, forever. Seed the rows directly:
    // 1200 of them is more than one batch and far more than the target.
    const dbPath = join(testDir, "multi-batch.db");
    const store = new ContentStore(dbPath, 2_000_000);
    try {
      store.put(noise(1_000), "text/html"); // creates the schema

      const side = new Database(dbPath);
      const insert = side.prepare(
        `INSERT INTO content (hash, content, content_type, original_size, compressed_size, created_at, last_accessed, access_count)
         VALUES (?, ?, 'text/html', 2000, 1000, 1, ?, 1)`
      );
      side.transaction(() => {
        for (let i = 0; i < 1200; i++) {
          insert.run(
            `seed-${String(i).padStart(6, "0")}`.padEnd(64, "a"),
            Buffer.alloc(1000, i % 256),
            1_000 + i
          );
        }
      })();
      side.close();

      expect(store.getStats().totalEntries).toBe(1201);

      const deleted = store.prune(100_000);

      expect(deleted).toBeGreaterThan(1_000);
      expect(store.getStats().totalBytes).toBeLessThanOrEqual(100_000);
    } finally {
      store.close();
    }
  });

  test("prune() leaves no stale total behind", () => {
    const store = new ContentStore(join(testDir, "after-prune.db"), 8_000_000);
    try {
      store.put(noise(2_000), "text/html"); // seeds the running total
      const scans = countAggregateScans(store);

      store.put(noise(2_000), "text/html");
      expect(scans()).toBe(0); // served from the running total

      // prune() reads the aggregate itself (1) and must drop the cached total,
      // so the next prune check has to read it again (2).
      store.prune(1_000);
      expect(scans()).toBe(1);

      store.put(noise(2_000), "text/html");
      expect(scans()).toBe(2);

      // ...and the re-seeded total is the real one, not a pre-prune leftover.
      const tracked = store.getStats().totalBytes;
      store.put(noise(2_000), "text/html");
      expect(store.getStats().totalBytes).toBeGreaterThan(tracked);
    } finally {
      store.close();
    }
  });

  test("delete() leaves no stale total behind", () => {
    const store = new ContentStore(join(testDir, "after-delete.db"), 8_000_000);
    try {
      const hash = store.put(noise(2_000), "text/html");
      const scans = countAggregateScans(store);

      store.put(noise(2_000), "text/html");
      expect(scans()).toBe(0);

      store.delete(hash);
      store.put(noise(2_000), "text/html");
      expect(scans()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a keyed replacement counts the delta, not the whole new row", () => {
    const store = new ContentStore(join(testDir, "keyed.db"), 100_000);
    try {
      const url = "https://cdn.example.com/app.js";
      store.putForKey(url, noise(60_000), "application/javascript");
      const scans = countAggregateScans(store);

      // Overwriting one key leaves the store the same size, so the running
      // total must not grow. If a replacement added the new row's bytes while
      // leaving the old row's bytes counted, the total would cross the 90 KB
      // threshold here and force an authoritative re-read.
      for (let i = 0; i < 5; i++) {
        store.putForKey(url, noise(60_000), "application/javascript");
      }

      expect(scans()).toBe(0);
      expect(store.getStats().totalEntries).toBe(1);
    } finally {
      store.close();
    }
  });
});
