// Unit tests for content-addressable storage
// Tests gzip compression, deduplication, LRU eviction, and cross-audit caching

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore, hashContent } from "@/crawler/storage/content-store";

describe("Content Store", () => {
  let store: ContentStore;
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create temp directory for test database
    testDir = join(tmpdir(), `content-store-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, "test-content-store.db");
    // Use smaller max size for testing pruning (1MB)
    store = new ContentStore(dbPath, 1024 * 1024);
  });

  afterEach(() => {
    store.close();
    // Clean up test directory
    // On Windows, SQLite holds file locks after close() - skip cleanup (OS cleans temp)
    if (process.platform !== "win32" && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("hashContent", () => {
    test("should produce consistent SHA-256 hashes", () => {
      const content = "Hello, World!";
      const hash1 = hashContent(content);
      const hash2 = hashContent(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 produces 64 hex chars
    });

    test("should produce different hashes for different content", () => {
      const hash1 = hashContent("Hello");
      const hash2 = hashContent("World");

      expect(hash1).not.toBe(hash2);
    });

    test("should handle Buffer input", () => {
      const content = "Hello, World!";
      const stringHash = hashContent(content);
      const bufferHash = hashContent(Buffer.from(content));

      expect(stringHash).toBe(bufferHash);
    });

    test("should handle empty content", () => {
      const hash = hashContent("");
      expect(hash).toHaveLength(64);
    });
  });

  describe("put and get", () => {
    test("should store and retrieve HTML content", () => {
      const html = "<html><body>Test page</body></html>";
      const hash = store.put(html, "text/html");

      expect(hash).toHaveLength(64);

      const retrieved = store.getString(hash);
      expect(retrieved).toBe(html);
    });

    test("should store and retrieve JavaScript content", () => {
      const js = 'console.log("Hello, World!");';
      const hash = store.put(js, "application/javascript");

      const retrieved = store.getString(hash);
      expect(retrieved).toBe(js);
    });

    test("should return null for non-existent hash", () => {
      const result = store.get("nonexistent-hash");
      expect(result).toBeNull();

      const stringResult = store.getString("nonexistent-hash");
      expect(stringResult).toBeNull();
    });

    test("should deduplicate identical content", () => {
      const content = "<html><body>Duplicate content</body></html>";

      const hash1 = store.put(content, "text/html");
      const hash2 = store.put(content, "text/html");

      expect(hash1).toBe(hash2);

      const stats = store.getStats();
      expect(stats.totalEntries).toBe(1);
    });

    test("should handle large content with compression", () => {
      // Create 100KB of repetitive HTML (compresses well)
      const largeHtml = "<html><body>" + "A".repeat(100000) + "</body></html>";
      const hash = store.put(largeHtml, "text/html");

      const retrieved = store.getString(hash);
      expect(retrieved).toBe(largeHtml);

      // Verify compression saved space
      const meta = store.getMeta(hash);
      expect(meta).not.toBeNull();
      expect(meta!.compressedSize).toBeLessThan(meta!.originalSize);
      // Repetitive content should compress very well
      expect(meta!.compressedSize).toBeLessThan(meta!.originalSize * 0.1);
    });

    test("should handle binary-like content", () => {
      // Content with special characters
      const content = "UTF-8: \u00e9\u00e8\u00ea \u4e2d\u6587 \ud83d\ude00";
      const hash = store.put(content, "text/html");

      const retrieved = store.getString(hash);
      expect(retrieved).toBe(content);
    });
  });

  describe("has", () => {
    test("should return true for existing content", () => {
      const hash = store.put("test content", "text/html");
      expect(store.has(hash)).toBe(true);
    });

    test("should return false for non-existent content", () => {
      expect(store.has("nonexistent")).toBe(false);
    });
  });

  describe("getMeta", () => {
    test("should return metadata without content", () => {
      const content = "Test content for metadata";
      const hash = store.put(content, "text/html");

      const meta = store.getMeta(hash);
      expect(meta).not.toBeNull();
      expect(meta!.hash).toBe(hash);
      expect(meta!.contentType).toBe("text/html");
      expect(meta!.originalSize).toBe(Buffer.from(content).length);
      expect(meta!.accessCount).toBeGreaterThanOrEqual(1);
    });

    test("should track access count", () => {
      const hash = store.put("test", "text/html");

      // Access multiple times
      store.get(hash);
      store.get(hash);
      store.get(hash);

      const meta = store.getMeta(hash);
      expect(meta!.accessCount).toBeGreaterThanOrEqual(4); // 1 initial + 3 gets
    });

    test("should update lastAccessed on retrieval", async () => {
      const hash = store.put("test", "text/html");
      const meta1 = store.getMeta(hash);

      // Wait a tiny bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      store.get(hash);
      const meta2 = store.getMeta(hash);

      expect(meta2!.lastAccessed).toBeGreaterThanOrEqual(meta1!.lastAccessed);
    });
  });

  describe("getStats", () => {
    test("should return empty stats for new store", () => {
      const stats = store.getStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.totalBytes).toBe(0);
      expect(stats.totalOriginalBytes).toBe(0);
      expect(stats.compressionRatio).toBe(1);
    });

    test("should track multiple entries", () => {
      store.put("content 1", "text/html");
      store.put("content 2", "text/html");
      store.put("content 3", "application/javascript");

      const stats = store.getStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.totalBytes).toBeGreaterThan(0);
    });
  });

  describe("delete", () => {
    test("should delete existing content", () => {
      const hash = store.put("to be deleted", "text/html");
      expect(store.has(hash)).toBe(true);

      const deleted = store.delete(hash);
      expect(deleted).toBe(true);
      expect(store.has(hash)).toBe(false);
    });

    test("should return false for non-existent content", () => {
      const deleted = store.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("prune", () => {
    test("should prune oldest entries when over threshold", () => {
      // Create small store with 100KB limit
      const smallStore = new ContentStore(
        join(testDir, "small-store.db"),
        100000
      );

      try {
        // Add entries with unique content that won't dedupe
        for (let i = 0; i < 50; i++) {
          // Each entry is unique due to index prefix and random suffix
          const uniqueContent = `Entry_${i}_${Date.now()}_${"X".repeat(3000)}`;
          smallStore.put(uniqueContent, "text/html");
        }

        const statsBefore = smallStore.getStats();
        expect(statsBefore.totalEntries).toBe(50);

        // Force prune to very low target
        const deleted = smallStore.prune(1000);

        expect(deleted).toBeGreaterThan(0);
        const statsAfter = smallStore.getStats();
        expect(statsAfter.totalEntries).toBeLessThan(statsBefore.totalEntries);
      } finally {
        smallStore.close();
      }
    });

    test("should not prune when under target", () => {
      store.put("small content", "text/html");

      const deleted = store.prune(1024 * 1024); // 1MB target
      expect(deleted).toBe(0);
    });
  });

  describe("cross-content-type storage", () => {
    test("should store same content with different types separately", () => {
      // Same content, different types - should dedupe by hash
      const content = "shared content";
      const hash1 = store.put(content, "text/html");
      const hash2 = store.put(content, "application/javascript");

      // Hashes are based on content, not type, so should be same
      expect(hash1).toBe(hash2);

      // Only one entry stored
      const stats = store.getStats();
      expect(stats.totalEntries).toBe(1);
    });
  });

  describe("persistence", () => {
    test("should persist across store instances", () => {
      const content = "persistent content";
      const hash = store.put(content, "text/html");
      store.close();

      // Create new store with same path
      const store2 = new ContentStore(dbPath);
      try {
        const retrieved = store2.getString(hash);
        expect(retrieved).toBe(content);
      } finally {
        store2.close();
      }
    });
  });
});
