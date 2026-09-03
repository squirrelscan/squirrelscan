// Global link cache storage
// Stores external link check results across all site audits
// Location: ~/.squirrel/link-cache.db

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { getLinkCachePath } from "@/self/paths";

export interface LinkCacheEntry {
  href: string;
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  checkedAt: number;
  /** True if 403 appears to be WAF/bot protection rather than real forbidden */
  wafBlocked?: boolean;
  /** Detected WAF provider if wafBlocked is true */
  wafProvider?: string;
  /**
   * The target answered with rate limiting (429/430, or 503 + `Retry-After`),
   * so its status is unverified rather than broken (#1829). Cached alongside
   * the status because the 503 case cannot be recovered from the code alone.
   */
  rateLimited?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS link_cache (
  href TEXT PRIMARY KEY,
  status INTEGER,
  error TEXT,
  redirect_target TEXT,
  checked_at INTEGER NOT NULL,
  waf_blocked INTEGER,
  waf_provider TEXT,
  rate_limited INTEGER
);

CREATE INDEX IF NOT EXISTS idx_link_cache_checked_at ON link_cache(checked_at);
`;

// Additive column migrations for existing caches. Every ALTER here is
// idempotent (the runner swallows "duplicate column name"), so the list is the
// full history rather than a version-gated step.
const WAF_MIGRATION = [
  "ALTER TABLE link_cache ADD COLUMN waf_blocked INTEGER",
  "ALTER TABLE link_cache ADD COLUMN waf_provider TEXT",
  // #1829: a cached 429 is re-served for the whole 7-day TTL, so without this
  // column one throttled check keeps reporting a live link as broken for a week.
  "ALTER TABLE link_cache ADD COLUMN rate_limited INTEGER",
];

const SQLITE_BUSY_TIMEOUT_MS = 15000;

export class LinkCacheStorage {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getLinkCachePath();
  }

  private getDb(): Database {
    if (!this.db) {
      // Ensure directory exists
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      this.db.run(SCHEMA);

      // Run migrations for existing databases (ignore duplicate column errors)
      for (const sql of WAF_MIGRATION) {
        try {
          this.db.run(sql);
        } catch (e) {
          // Ignore "duplicate column name" errors (migration already applied)
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("duplicate column name")) {
            throw e;
          }
        }
      }
    }
    return this.db;
  }

  /**
   * Get cached link status if fresh (within TTL)
   */
  getCached(href: string, ttlSeconds: number): LinkCacheEntry | null {
    const db = this.getDb();
    const cutoff = Date.now() - ttlSeconds * 1000;

    const row = db
      .prepare(
        `SELECT href, status, error, redirect_target, checked_at, waf_blocked, waf_provider, rate_limited
         FROM link_cache
         WHERE href = ? AND checked_at > ?`
      )
      .get(href, cutoff) as
      | {
          href: string;
          status: number | null;
          error: string | null;
          redirect_target: string | null;
          checked_at: number;
          waf_blocked: number | null;
          waf_provider: string | null;
          rate_limited: number | null;
        }
      | undefined;

    if (!row) return null;

    return {
      href: row.href,
      status: row.status,
      error: row.error,
      redirectTarget: row.redirect_target,
      checkedAt: row.checked_at,
      wafBlocked: row.waf_blocked === 1 ? true : undefined,
      wafProvider: row.waf_provider ?? undefined,
      rateLimited: row.rate_limited === 1 ? true : undefined,
    };
  }

  /**
   * Store link check result in cache
   */
  setCached(entry: LinkCacheEntry): void {
    const db = this.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO link_cache (href, status, error, redirect_target, checked_at, waf_blocked, waf_provider, rate_limited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.href,
      entry.status,
      entry.error,
      entry.redirectTarget,
      entry.checkedAt,
      entry.wafBlocked ? 1 : null,
      entry.wafProvider ?? null,
      entry.rateLimited ? 1 : null
    );
  }

  /**
   * Bulk get cached entries for multiple URLs
   * Chunks into batches to avoid SQLite parameter limit (~999)
   */
  getCachedBulk(
    hrefs: string[],
    ttlSeconds: number
  ): Map<string, LinkCacheEntry> {
    if (hrefs.length === 0) return new Map();

    const db = this.getDb();
    const cutoff = Date.now() - ttlSeconds * 1000;
    const result = new Map<string, LinkCacheEntry>();

    // SQLite has parameter limit (~999 in older versions, higher in newer)
    // Use 900 to leave room for the cutoff parameter and safety margin
    const BATCH_SIZE = 900;

    for (let i = 0; i < hrefs.length; i += BATCH_SIZE) {
      const batch = hrefs.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");

      const rows = db
        .prepare(
          `SELECT href, status, error, redirect_target, checked_at, waf_blocked, waf_provider, rate_limited
           FROM link_cache
           WHERE href IN (${placeholders}) AND checked_at > ?`
        )
        .all(...batch, cutoff) as Array<{
        href: string;
        status: number | null;
        error: string | null;
        redirect_target: string | null;
        checked_at: number;
        waf_blocked: number | null;
        waf_provider: string | null;
        rate_limited: number | null;
      }>;

      for (const row of rows) {
        result.set(row.href, {
          href: row.href,
          status: row.status,
          error: row.error,
          redirectTarget: row.redirect_target,
          checkedAt: row.checked_at,
          wafBlocked: row.waf_blocked === 1 ? true : undefined,
          wafProvider: row.waf_provider ?? undefined,
          rateLimited: row.rate_limited === 1 ? true : undefined,
        });
      }
    }

    return result;
  }

  /**
   * Bulk store link check results
   */
  setCachedBulk(entries: LinkCacheEntry[]): void {
    if (entries.length === 0) return;

    const db = this.getDb();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO link_cache (href, status, error, redirect_target, checked_at, waf_blocked, waf_provider, rate_limited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    db.transaction(() => {
      for (const entry of entries) {
        stmt.run(
          entry.href,
          entry.status,
          entry.error,
          entry.redirectTarget,
          entry.checkedAt,
          entry.wafBlocked ? 1 : null,
          entry.wafProvider ?? null,
          entry.rateLimited ? 1 : null
        );
      }
    })();
  }

  /**
   * Prune old cache entries
   * Returns number of entries deleted
   */
  prune(olderThanSeconds: number): number {
    const db = this.getDb();
    const cutoff = Date.now() - olderThanSeconds * 1000;

    const result = db
      .prepare("DELETE FROM link_cache WHERE checked_at < ?")
      .run(cutoff);

    return result.changes;
  }

  /**
   * Get cache statistics
   */
  getStats(): { totalEntries: number; oldestEntry: number | null } {
    const db = this.getDb();

    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM link_cache")
      .get() as { count: number };

    const oldestRow = db
      .prepare("SELECT MIN(checked_at) as oldest FROM link_cache")
      .get() as { oldest: number | null };

    return {
      totalEntries: countRow.count,
      oldestEntry: oldestRow.oldest,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance for global use
let globalLinkCache: LinkCacheStorage | null = null;

export function getGlobalLinkCache(): LinkCacheStorage {
  if (!globalLinkCache) {
    globalLinkCache = new LinkCacheStorage();
  }
  return globalLinkCache;
}

export function closeGlobalLinkCache(): void {
  if (globalLinkCache) {
    globalLinkCache.close();
    globalLinkCache = null;
  }
}
