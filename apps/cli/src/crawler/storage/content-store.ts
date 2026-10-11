// Global content-addressable storage
// Stores gzip-compressed content by SHA-256 hash for deduplication
// Location: ~/.squirrel/content-store.db
//
// Shared across all projects for:
// - HTML pages (dedup across incremental crawls)
// - JavaScript files (dedup CDN scripts across sites)

import { parseByteSize } from "@squirrelscan/config";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  CONTENT_STORE_MAX_BYTES,
  CONTENT_STORE_PRUNE_THRESHOLD,
} from "@/constants";
import { getContentStorePath } from "@/self/paths";
import { logger } from "@/utils/logger";

export type ContentType = "text/html" | "application/javascript" | "text/css";

export interface ContentEntry {
  hash: string;
  content: Buffer;
  contentType: ContentType;
  originalSize: number;
  compressedSize: number;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
}

export interface ContentStats {
  totalEntries: number;
  totalBytes: number;
  totalOriginalBytes: number;
  compressionRatio: number;
  oldestAccess: number | null;
}

/** The most recent prune that deleted anything (#2342). */
export interface EvictionRecord {
  /** Epoch ms. */
  at: number;
  entries: number;
  /** Compressed bytes freed. */
  bytes: number;
}

/** Where the size cap in force came from, for `self doctor` (#2342). */
export type ContentStoreCapSource = "default" | "config" | "env";

export const CONTENT_STORE_MAX_BYTES_ENV = "SQUIRREL_CONTENT_STORE_MAX_BYTES";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS content (
  hash TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  content_type TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_content_last_accessed ON content(last_accessed);
CREATE INDEX IF NOT EXISTS idx_content_type ON content(content_type);

-- Covering index for getStats(), which aggregates COUNT + SUM(compressed_size)
-- + SUM(original_size) + MIN(last_accessed) over this table. Without an index
-- holding all four values, SQLite scans the table itself and therefore pages in
-- every gzipped BLOB just to add up their sizes -- on a filled ~1GB store that
-- is ~300ms per call. Listing the columns in this order lets one covering-index
-- scan answer the whole query without touching the table.
--
-- The index bounds the cost of a single aggregate; it cannot make it free, and
-- the scan is still O(rows). put() therefore no longer runs one per stored page
-- (#1908) -- see maybePrune().
CREATE INDEX IF NOT EXISTS idx_content_sizes ON content(compressed_size, original_size, last_accessed);

-- Retention leases (#2342). A running audit holds one, and prune() never evicts a
-- row accessed since the oldest live lease began: what an audit has fetched or
-- touched is what it is about to read back. A table rather than process state
-- because the store is shared, and two audits running at once must not evict
-- each other's pages either. A lease whose heartbeat stops (a killed process)
-- lapses after LEASE_STALE_MS.
CREATE TABLE IF NOT EXISTS retention_leases (
  id TEXT PRIMARY KEY,
  since INTEGER NOT NULL,
  heartbeat INTEGER NOT NULL,
  pid INTEGER NOT NULL
);

-- Facts about the store itself, currently the last eviction (#2342).
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SQLITE_BUSY_TIMEOUT_MS = 15000;

/**
 * Compute SHA-256 hash of content
 */
export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Rows one prune pass deletes per batch (and per transaction). */
const PRUNE_BATCH_ROWS = 1000;

/** Safety stop so a prune can never run away on a pathological store. */
const PRUNE_MAX_BATCHES = 100;

/** How often a held lease refreshes its heartbeat, at most. */
const LEASE_HEARTBEAT_MS = 60_000;

/**
 * How long a lease survives without a heartbeat. Generous on purpose: a stale
 * lease only defers pruning, while a lapsed live one lets another audit evict
 * pages this one has yet to read. The rules phase reads every page and so beats
 * throughout; the longest silent stretch is the site-rules pass, minutes at most.
 */
const LEASE_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * After a prune the leases blocked, how much the store has to grow, or how long
 * has to pass, before the next one is worth its getStats() scan. Without it
 * every put past the threshold would re-scan the store and find the same
 * protected rows (#1908's quadratic). The time bound is for a lease another
 * process releases: its rows become evictable without this one growing at all.
 */
const PRUNE_RETRY_MIN_BYTES = 16 * 1024 * 1024;
const PRUNE_RETRY_CAP_FRACTION = 0.1;
const PRUNE_RETRY_MS = 60_000;

const EVICTION_META_KEY = "last_eviction";

let warnedInvalidCapEnv = false;

/**
 * The content-store cap in force: `SQUIRREL_CONTENT_STORE_MAX_BYTES`, else the
 * project's `[storage] content_store_max_bytes`, else 1 GB (#2342).
 *
 * The env var wins because it is the per-run override, the same precedence the
 * other SQUIRREL_* variables have over config. An unparseable one is ignored
 * with a warning rather than failing: every command opens the store.
 */
export function resolveContentStoreCap(configBytes?: number): {
  bytes: number;
  source: ContentStoreCapSource;
} {
  const raw = process.env[CONTENT_STORE_MAX_BYTES_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const bytes = parseByteSize(raw);
    if (bytes !== null) return { bytes, source: "env" };
    if (!warnedInvalidCapEnv) {
      warnedInvalidCapEnv = true;
      logger.warn(
        `Ignoring ${CONTENT_STORE_MAX_BYTES_ENV}="${raw}": expected a positive size such as 4294967296 or 4GB`
      );
    }
  }
  if (configBytes !== undefined)
    return { bytes: configBytes, source: "config" };
  return { bytes: CONTENT_STORE_MAX_BYTES, source: "default" };
}

export class ContentStore {
  private db: Database | null = null;
  private dbPath: string;
  private maxBytes: number;
  private capSource: ContentStoreCapSource;
  /** This process's lease, while an audit holds one (#2342). */
  private lease: {
    id: string;
    since: number;
    lastBeat: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  /**
   * When a prune the leases blocked is worth retrying: once the running total
   * passes `bytes` or the clock passes `at`. Null when the last prune was not
   * blocked.
   */
  private pruneRetry: { bytes: number; at: number } | null = null;
  /**
   * Running total of compressed_size, so the prune check does not aggregate the
   * whole table on every stored page (#1908). Seeded by one authoritative scan
   * the first time this process stores something and kept up to date by the
   * bytes each put adds; null means "unknown, read it again".
   *
   * It is a hint, never an authority: another process can store or prune behind
   * our back, so anything that deletes re-reads first. An over-count only
   * causes an early check that finds nothing to do.
   *
   * An under-count delays a prune, and with two CLIs writing at once it can
   * delay it past the cap: neither sees the other's bytes, so the store can
   * overshoot by whatever a sibling writes while we hold a seeded total. That
   * is bounded and self-healing rather than permanent — the seed is taken per
   * process, so the next audit to store anything reads the real total and
   * prunes the whole overshoot down to target on its first page.
   */
  private totalBytesCache: number | null = null;

  constructor(dbPath?: string, maxBytes?: number) {
    this.dbPath = dbPath ?? getContentStorePath();
    if (maxBytes !== undefined) {
      this.maxBytes = maxBytes;
      this.capSource = "config";
    } else {
      const cap = resolveContentStoreCap();
      this.maxBytes = cap.bytes;
      this.capSource = cap.source;
    }
  }

  getPath(): string {
    return this.dbPath;
  }

  getMaxBytes(): number {
    return this.maxBytes;
  }

  getCapSource(): ContentStoreCapSource {
    return this.capSource;
  }

  /** Apply a cap resolved from config/env (#2342). */
  setMaxBytes(bytes: number, source: ContentStoreCapSource): void {
    this.maxBytes = bytes;
    this.capSource = source;
    this.pruneRetry = null;
  }

  /**
   * Protect every row this process stores or reads from now until the returned
   * release runs: prune() will not evict them, here or in any other process
   * sharing the store (#2342).
   *
   * The cap used to apply mid-audit, so a crawl whose pages outgrew it evicted
   * its own earliest pages before the rules phase read them back, and those
   * pages silently dropped out of the audit. With a lease the store may exceed
   * the cap while an audit that needs more is running; the next audit's first
   * prune brings it back down.
   *
   * One lease per process. A second call while one is held returns a no-op
   * release, so only the outermost holder ends it.
   */
  beginRetention(): () => void {
    if (this.lease) return () => {};
    const now = Date.now();
    const id = randomUUID();
    this.getDb()
      .prepare(
        "INSERT OR REPLACE INTO retention_leases (id, since, heartbeat, pid) VALUES (?, ?, ?, ?)"
      )
      .run(id, now, now, process.pid);
    // Beat on a timer as well as on every store access: a phase that touches
    // no page (the site rules) must not let the lease lapse. Unref'd so it
    // never holds the process open.
    const timer = setInterval(() => {
      try {
        this.heartbeat(Date.now());
      } catch {
        // A store busy past its timeout beats on the next tick or access.
      }
    }, LEASE_HEARTBEAT_MS);
    timer.unref?.();
    this.lease = { id, since: now, lastBeat: now, timer };
    return () => this.endRetention(id);
  }

  private endRetention(id: string): void {
    if (this.lease?.id !== id) return;
    clearInterval(this.lease.timer);
    this.lease = null;
    // A prune the lease blocked can run again on the next put.
    this.pruneRetry = null;
    try {
      this.db?.prepare("DELETE FROM retention_leases WHERE id = ?").run(id);
    } catch {
      // A row left behind lapses after LEASE_STALE_MS; never fail an audit here.
    }
  }

  /** Keep this process's lease live, at most once per LEASE_HEARTBEAT_MS. */
  private heartbeat(now: number): void {
    const lease = this.lease;
    if (!lease || now - lease.lastBeat < LEASE_HEARTBEAT_MS) return;
    lease.lastBeat = now;
    // Upsert, not UPDATE: if another process swept the row as stale (this one
    // was suspended past LEASE_STALE_MS), re-registering restores protection.
    this.getDb()
      .prepare(
        "INSERT OR REPLACE INTO retention_leases (id, since, heartbeat, pid) VALUES (?, ?, ?, ?)"
      )
      .run(lease.id, lease.since, now, process.pid);
  }

  /**
   * The earliest `last_accessed` a prune must leave alone, or null when no audit
   * holds a lease. Sweeps lapsed leases first. Called inside the prune's write
   * transaction, so no lease can begin between this read and the deletes.
   */
  private protectedSince(now: number): number | null {
    const db = this.getDb();
    db.prepare("DELETE FROM retention_leases WHERE heartbeat < ?").run(
      now - LEASE_STALE_MS
    );
    const row = db
      .prepare("SELECT MIN(since) AS since FROM retention_leases")
      .get() as { since: number | null };
    let since = row.since;
    if (this.lease && (since === null || this.lease.since < since)) {
      since = this.lease.since;
    }
    return since;
  }

  /**
   * Bump these rows into the current lease window without reading them, so a
   * run that will read them later keeps them (#2342). A resumed crawl calls it
   * for the pages stored before the interruption, which it skips as done and
   * would otherwise only read again in the rules phase, after its own puts may
   * have evicted them. Returns how many rows were still there to protect.
   */
  touch(hashes: readonly string[]): number {
    const db = this.getDb();
    const now = Date.now();
    this.heartbeat(now);
    const stmt = db.prepare(
      "UPDATE content SET last_accessed = ? WHERE hash = ?"
    );
    let touched = 0;
    db.transaction(() => {
      for (const hash of hashes) touched += stmt.run(now, hash).changes;
    })();
    return touched;
  }

  /** The last prune that evicted anything, or null if this store never has. */
  getLastEviction(): EvictionRecord | null {
    const row = this.getDb()
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(EVICTION_META_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as EvictionRecord;
      return typeof parsed.at === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  private getDb(): Database {
    if (!this.db) {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA wal_autocheckpoint = 1000");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.db.run("PRAGMA cache_size = -32000"); // 32MB cache
      this.db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      this.db.run(SCHEMA);
    }
    return this.db;
  }

  /**
   * Store content and return its hash.
   * Content is gzip compressed before storage.
   * Deduplication is automatic - if hash exists, just updates access time.
   */
  put(content: string | Buffer, contentType: ContentType): string {
    return this.putAtHash(hashContent(content), content, contentType, false);
  }

  /**
   * Store content under the SHA-256 hash of a caller-defined cache key.
   *
   * Unlike put(), the key says nothing about the content, so an existing row
   * is REPLACED (content, sizes and created_at), not merely touched: a
   * URL-keyed cache that kept the first body forever would never see a
   * deploy. created_at therefore means "when this key was last refreshed",
   * which is what a max-age check on the read side needs.
   */
  putForKey(
    key: string | Buffer,
    content: string | Buffer,
    contentType: ContentType
  ): string {
    return this.putAtHash(hashContent(key), content, contentType, true);
  }

  private putAtHash(
    hash: string,
    content: string | Buffer,
    contentType: ContentType,
    replace: boolean
  ): string {
    const db = this.getDb();
    const now = Date.now();
    this.heartbeat(now);

    let existing: { compressed_size: number } | undefined;
    if (!replace) {
      // Content-addressed: same hash is the same bytes, so an existing row is
      // only touched. Touch FIRST rather than check-then-touch: a prune in
      // another process could delete the row between the two, and this would
      // then hand back the hash of a row that no longer exists (#2342).
      const touched = db
        .prepare(
          "UPDATE content SET last_accessed = ?, access_count = access_count + 1 WHERE hash = ?"
        )
        .run(now, hash);
      if (touched.changes > 0) return hash;
    } else {
      // A keyed replacement bills the running total for the size delta rather
      // than the whole new row, so it needs the old size.
      existing = db
        .prepare("SELECT compressed_size FROM content WHERE hash = ?")
        .get(hash) as { compressed_size: number } | undefined;
    }

    // Compress and store. One UPSERT covers both the fresh insert and the
    // keyed replacement: a prune in another process can delete the row between
    // the SELECT above and this write, and a plain UPDATE would then report
    // success while storing nothing.
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    const compressed = gzipSync(buffer, { level: 6 }); // Balance speed/size
    const originalSize = buffer.length;
    const compressedSize = compressed.length;

    db.prepare(
      `INSERT INTO content (hash, content, content_type, original_size, compressed_size, created_at, last_accessed, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(hash) DO UPDATE SET
         content = excluded.content,
         content_type = excluded.content_type,
         original_size = excluded.original_size,
         compressed_size = excluded.compressed_size,
         created_at = excluded.created_at,
         last_accessed = excluded.last_accessed,
         access_count = content.access_count + 1`
    ).run(
      hash,
      compressed,
      contentType,
      originalSize,
      compressedSize,
      now,
      now
    );

    // Check if we need to prune. The delta is measured against what this
    // process last counted, so a row another process wrote between the SELECT
    // and the UPSERT is still one row's worth of growth from here.
    this.maybePrune(compressedSize - (existing?.compressed_size ?? 0));

    return hash;
  }

  /**
   * Retrieve content by hash.
   * Returns null if not found.
   * Updates access time on retrieval.
   */
  get(hash: string): Buffer | null {
    const db = this.getDb();
    const now = Date.now();
    this.heartbeat(now);

    // Touch BEFORE reading. A read bumps the row into the lease window, so a
    // page an audit reads back stays protected (#2342), but only if the touch
    // lands: read-then-touch let another process's prune delete the row in
    // between, and the audit would hold a body the store no longer has.
    const touched = db
      .prepare(
        "UPDATE content SET last_accessed = ?, access_count = access_count + 1 WHERE hash = ?"
      )
      .run(now, hash);
    if (touched.changes === 0) return null;

    const row = db
      .prepare("SELECT content FROM content WHERE hash = ?")
      .get(hash) as { content: Buffer } | undefined;
    if (!row) return null;

    // Decompress
    return gunzipSync(row.content);
  }

  /**
   * Get content as string (convenience method for text content)
   */
  getString(hash: string): string | null {
    const buffer = this.get(hash);
    return buffer ? buffer.toString("utf-8") : null;
  }

  /**
   * Check if content exists without retrieving it
   */
  has(hash: string): boolean {
    const db = this.getDb();
    const row = db.prepare("SELECT 1 FROM content WHERE hash = ?").get(hash) as
      | { 1: number }
      | undefined;
    return !!row;
  }

  /**
   * Get metadata for content without retrieving it
   */
  getMeta(hash: string): {
    hash: string;
    contentType: ContentType;
    originalSize: number;
    compressedSize: number;
    createdAt: number;
    lastAccessed: number;
    accessCount: number;
  } | null {
    const db = this.getDb();
    const row = db
      .prepare(
        `SELECT hash, content_type, original_size, compressed_size, created_at, last_accessed, access_count
         FROM content WHERE hash = ?`
      )
      .get(hash) as
      | {
          hash: string;
          content_type: string;
          original_size: number;
          compressed_size: number;
          created_at: number;
          last_accessed: number;
          access_count: number;
        }
      | undefined;

    if (!row) return null;

    return {
      hash: row.hash,
      contentType: row.content_type as ContentType,
      originalSize: row.original_size,
      compressedSize: row.compressed_size,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
    };
  }

  /**
   * Get storage statistics
   */
  getStats(): ContentStats {
    const db = this.getDb();

    const countRow = db
      .prepare(
        "SELECT COUNT(*) as count, SUM(compressed_size) as total_compressed, SUM(original_size) as total_original, MIN(last_accessed) as oldest FROM content"
      )
      .get() as {
      count: number;
      total_compressed: number | null;
      total_original: number | null;
      oldest: number | null;
    };

    const totalBytes = countRow.total_compressed ?? 0;
    const totalOriginalBytes = countRow.total_original ?? 0;

    return {
      totalEntries: countRow.count,
      totalBytes,
      totalOriginalBytes,
      compressionRatio:
        totalOriginalBytes > 0 ? totalBytes / totalOriginalBytes : 1,
      oldestAccess: countRow.oldest,
    };
  }

  /**
   * Prune old entries if over threshold
   * Uses LRU eviction based on last_accessed
   *
   * The running total answers this check; the aggregate is only read to seed
   * that total once and to confirm a prune before anything is deleted (#1908).
   * Reading it here on every stored page made a crawl's speed a function of the
   * size of the user's lifetime cache, and quadratic in its own page count.
   *
   * @param deltaBytes compressed bytes the caller just added, negative when a
   *   keyed replacement shrank the row.
   */
  private maybePrune(deltaBytes: number): void {
    const threshold = this.maxBytes * CONTENT_STORE_PRUNE_THRESHOLD;

    if (this.totalBytesCache === null) {
      this.totalBytesCache = this.getStats().totalBytes;
    } else {
      this.totalBytesCache += deltaBytes;
    }

    if (this.totalBytesCache < threshold) return;
    // The last prune could not get under the cap because live leases protect
    // what is left. Nothing new is evictable until the store grows enough to be
    // worth another look, or enough time passes for another run to finish.
    if (
      this.pruneRetry !== null &&
      this.totalBytesCache < this.pruneRetry.bytes &&
      Date.now() < this.pruneRetry.at
    ) {
      return;
    }

    // At the threshold the hint stops being good enough: eviction is
    // destructive, so take the authoritative reading before deleting anything.
    const stats = this.getStats();
    this.totalBytesCache = stats.totalBytes;
    if (stats.totalBytes < threshold) return;

    this.prune(this.maxBytes * 0.8); // Prune to 80% capacity
  }

  /**
   * Prune entries until total size is under target bytes.
   * Deletes least recently accessed entries first.
   * Returns number of entries deleted.
   */
  prune(targetBytes: number): number {
    const db = this.getDb();
    let deleted = 0;

    const stats = this.getStats();
    if (stats.totalBytes <= targetBytes) {
      this.totalBytesCache = stats.totalBytes;
      this.pruneRetry = null;
      return 0;
    }

    let currentBytes = stats.totalBytes;

    // Get oldest entries ordered by last_accessed, outside every live lease.
    const oldest = db.prepare(
      "SELECT hash, compressed_size FROM content WHERE last_accessed < ? ORDER BY last_accessed ASC LIMIT ?"
    );
    const deleteOne = db.prepare(
      "DELETE FROM content WHERE hash = ? AND last_accessed < ?"
    );
    // One batch per IMMEDIATE transaction, which takes the write lock before
    // reading anything. A lease begins and a row is touched only under that
    // same lock, so the leases read here are the ones in force for every
    // delete that follows (#2342): a cutoff read outside it could miss a lease
    // that began mid-pass and delete the row its holder had just touched.
    // Returns how many rows the batch considered; zero ends the pass.
    const deleteBatch = db.transaction((): number => {
      // Rows accessed inside a live lease belong to a run still going.
      // MAX_SAFE_INTEGER rather than a second statement keeps one query shape.
      const protectSince =
        this.protectedSince(Date.now()) ?? Number.MAX_SAFE_INTEGER;
      const entries = oldest.all(protectSince, PRUNE_BATCH_ROWS) as Array<{
        hash: string;
        compressed_size: number;
      }>;
      for (const entry of entries) {
        if (currentBytes <= targetBytes) break;

        // A row another process already deleted frees nothing here. Counting
        // it would walk currentBytes down past the real total and stop the
        // pass early, leaving the store above target.
        if (deleteOne.run(entry.hash, protectSince).changes === 0) continue;
        currentBytes -= entry.compressed_size;
        deleted++;
      }
      return entries.length;
    });

    // Delete in batches until the target is met. A single batch used to be the
    // whole pass, so a store whose 1000 oldest entries were not worth the
    // overage stayed above the threshold and pruned again on the very next
    // stored page, forever (#1908).
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      if (currentBytes <= targetBytes) break;
      if (deleteBatch.immediate() === 0) break;
    }

    if (deleted > 0) {
      const record: EvictionRecord = {
        at: Date.now(),
        entries: deleted,
        bytes: stats.totalBytes - currentBytes,
      };
      db.prepare(
        "INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)"
      ).run(EVICTION_META_KEY, JSON.stringify(record));
      logger.debug(
        "content store evicted",
        `${deleted} entries, ${record.bytes} bytes (cap ${this.maxBytes})`
      );
    }

    // Still over target means the leases protect the rest: back off until the
    // store has grown, or time has passed, enough for another pass to find
    // something.
    this.pruneRetry =
      currentBytes > targetBytes
        ? {
            bytes:
              currentBytes +
              Math.max(
                PRUNE_RETRY_MIN_BYTES,
                this.maxBytes * PRUNE_RETRY_CAP_FRACTION
              ),
            at: Date.now() + PRUNE_RETRY_MS,
          }
        : null;

    // Deleting invalidates the hint; the next check re-reads rather than
    // trusting a total that counted rows this just removed.
    this.totalBytesCache = null;

    return deleted;
  }

  /**
   * Delete content by hash
   */
  delete(hash: string): boolean {
    const db = this.getDb();
    const result = db.prepare("DELETE FROM content WHERE hash = ?").run(hash);
    // Same reason as prune(): a removed row must not stay in the running total.
    this.totalBytesCache = null;
    return result.changes > 0;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.lease) this.endRetention(this.lease.id);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    // Anything may touch the file while this instance is closed.
    this.totalBytesCache = null;
  }
}

// Singleton instance for global use
let globalContentStore: ContentStore | null = null;

export function getGlobalContentStore(): ContentStore {
  // Through the paths module (SQUIRREL_CONTENT_STORE_PATH, else the default), so
  // it is the one place the store's location is decided: a test that redirects
  // the paths module cannot be bypassed by an env var it inherited (#626).
  const desiredPath = getContentStorePath();

  if (globalContentStore && globalContentStore.getPath() !== desiredPath) {
    globalContentStore.close();
    globalContentStore = null;
  }

  if (!globalContentStore) {
    globalContentStore = new ContentStore(desiredPath);
    if (configuredCapBytes !== undefined) {
      const cap = resolveContentStoreCap(configuredCapBytes);
      globalContentStore.setMaxBytes(cap.bytes, cap.source);
    }
  }
  return globalContentStore;
}

/** The project's `[storage] content_store_max_bytes`, once a run has applied it. */
let configuredCapBytes: number | undefined;

/**
 * Apply the run's cap and hold a retention lease on the global store for the
 * length of an audit or crawl (#2342). Returns the release; call it once the
 * run has read back everything it stored. Never throws: a store that cannot
 * take a lease behaves as it did before leases existed.
 */
export function retainGlobalContentStore(opts: {
  configMaxBytes?: number;
}): () => void {
  configuredCapBytes = opts.configMaxBytes;
  try {
    const store = getGlobalContentStore();
    const cap = resolveContentStoreCap(opts.configMaxBytes);
    store.setMaxBytes(cap.bytes, cap.source);
    return store.beginRetention();
  } catch (error) {
    logger.debug("content store retention unavailable", error);
    return () => {};
  }
}

export function closeGlobalContentStore(): void {
  if (globalContentStore) {
    globalContentStore.close();
    globalContentStore = null;
  }
}
