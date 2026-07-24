// Global content-addressable storage
// Stores gzip-compressed content by SHA-256 hash for deduplication
// Location: ~/.squirrel/content-store.db
//
// Shared across all projects for:
// - HTML pages (dedup across incremental crawls)
// - JavaScript files (dedup CDN scripts across sites)

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  CONTENT_STORE_MAX_BYTES,
  CONTENT_STORE_PRUNE_THRESHOLD,
} from "@/constants";
import { getContentStorePath } from "@/self/paths";

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
`;

const SQLITE_BUSY_TIMEOUT_MS = 15000;

/**
 * Compute SHA-256 hash of content
 */
export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class ContentStore {
  private db: Database | null = null;
  private dbPath: string;
  private maxBytes: number;

  constructor(dbPath?: string, maxBytes?: number) {
    this.dbPath = dbPath ?? getContentStorePath();
    this.maxBytes = maxBytes ?? CONTENT_STORE_MAX_BYTES;
  }

  getPath(): string {
    return this.dbPath;
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
    const db = this.getDb();
    const hash = hashContent(content);
    const now = Date.now();

    // Check if already exists
    const existing = db
      .prepare("SELECT hash FROM content WHERE hash = ?")
      .get(hash) as { hash: string } | undefined;

    if (existing) {
      // Update access time and count
      db.prepare(
        "UPDATE content SET last_accessed = ?, access_count = access_count + 1 WHERE hash = ?"
      ).run(now, hash);
      return hash;
    }

    // Compress and store
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    const compressed = gzipSync(buffer, { level: 6 }); // Balance speed/size
    const originalSize = buffer.length;
    const compressedSize = compressed.length;

    db.prepare(
      `INSERT INTO content (hash, content, content_type, original_size, compressed_size, created_at, last_accessed, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      hash,
      compressed,
      contentType,
      originalSize,
      compressedSize,
      now,
      now
    );

    // Check if we need to prune
    this.maybePrune();

    return hash;
  }

  /**
   * Retrieve content by hash.
   * Returns null if not found.
   * Updates access time on retrieval.
   */
  get(hash: string): Buffer | null {
    const db = this.getDb();

    const row = db
      .prepare("SELECT content FROM content WHERE hash = ?")
      .get(hash) as { content: Buffer } | undefined;

    if (!row) return null;

    // Update access time (fire and forget)
    db.prepare(
      "UPDATE content SET last_accessed = ?, access_count = access_count + 1 WHERE hash = ?"
    ).run(Date.now(), hash);

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
   */
  private maybePrune(): void {
    const stats = this.getStats();
    const threshold = this.maxBytes * CONTENT_STORE_PRUNE_THRESHOLD;

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
    if (stats.totalBytes <= targetBytes) return 0;

    let currentBytes = stats.totalBytes;

    // Get oldest entries ordered by last_accessed
    const oldestEntries = db
      .prepare(
        "SELECT hash, compressed_size FROM content ORDER BY last_accessed ASC LIMIT 1000"
      )
      .all() as Array<{ hash: string; compressed_size: number }>;

    db.transaction(() => {
      for (const entry of oldestEntries) {
        if (currentBytes <= targetBytes) break;

        db.prepare("DELETE FROM content WHERE hash = ?").run(entry.hash);
        currentBytes -= entry.compressed_size;
        deleted++;
      }
    })();

    return deleted;
  }

  /**
   * Delete content by hash
   */
  delete(hash: string): boolean {
    const db = this.getDb();
    const result = db.prepare("DELETE FROM content WHERE hash = ?").run(hash);
    return result.changes > 0;
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
let globalContentStore: ContentStore | null = null;

export function getGlobalContentStore(): ContentStore {
  const desiredPath = process.env.SQUIRREL_CONTENT_STORE_PATH;

  if (
    globalContentStore &&
    desiredPath &&
    globalContentStore.getPath() !== desiredPath
  ) {
    globalContentStore.close();
    globalContentStore = null;
  }

  if (!globalContentStore) {
    globalContentStore = new ContentStore(desiredPath);
  }
  return globalContentStore;
}

export function closeGlobalContentStore(): void {
  if (globalContentStore) {
    globalContentStore.close();
    globalContentStore = null;
  }
}
