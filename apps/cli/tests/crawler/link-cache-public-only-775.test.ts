// pub#775: the global link cache serves only rows written since the engine
// started keeping a private site's checks out of it. A row an older version
// wrote may be a verdict from the auditor's own network, or a cloud refusal of
// a private address cached as a broken link: reads skip it until the next
// check of the link replaces it.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinkCacheStorage } from "../../src/crawler/storage/link-cache";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratchDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-link-cache-"));
  dirs.push(dir);
  return join(dir, "link-cache.db");
}

const TTL = 7 * 24 * 60 * 60;

describe("link cache rows from before pub#775", () => {
  test("an older version's row is not served; a new write is", () => {
    const path = scratchDb();
    // The table as an older version created and filled it.
    const old = new Database(path);
    old.run(`CREATE TABLE link_cache (
      href TEXT PRIMARY KEY, status INTEGER, error TEXT, redirect_target TEXT,
      checked_at INTEGER NOT NULL, waf_blocked INTEGER, waf_provider TEXT
    )`);
    old
      .prepare(
        "INSERT INTO link_cache (href, status, error, redirect_target, checked_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        "https://intranet.example.com/",
        null,
        "blocked_non_public_host:private",
        null,
        Date.now()
      );
    old.close();

    const cache = new LinkCacheStorage(path);
    try {
      expect(
        cache.getCachedBulk(["https://intranet.example.com/"], TTL).size
      ).toBe(0);
      expect(cache.getCached("https://intranet.example.com/", TTL)).toBeNull();

      cache.setCachedBulk([
        {
          href: "https://intranet.example.com/",
          status: 200,
          error: null,
          redirectTarget: null,
          checkedAt: Date.now(),
        },
      ]);
      expect(
        cache
          .getCachedBulk(["https://intranet.example.com/"], TTL)
          .get("https://intranet.example.com/")?.status
      ).toBe(200);
    } finally {
      cache.close();
    }
  });

  test("a new database serves what it stores", () => {
    const cache = new LinkCacheStorage(scratchDb());
    try {
      cache.setCached({
        href: "https://example.com/",
        status: 404,
        error: null,
        redirectTarget: null,
        checkedAt: Date.now(),
      });
      expect(cache.getCached("https://example.com/", TTL)?.status).toBe(404);
    } finally {
      cache.close();
    }
  });
});
