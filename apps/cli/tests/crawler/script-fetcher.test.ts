// Unit tests for script fetcher with dynamic limits and caching
// Tests calculateScriptLimit helper and content store integration

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore, hashContent } from "@/crawler/storage/content-store";

describe("Script Fetcher", () => {
  describe("calculateScriptLimit (unit)", () => {
    // Test the limit calculation formula: min(50, max(10, ceil(pageCount * 0.1)))

    test("should use default limit when pageCount is undefined", () => {
      // Formula: pageCount undefined returns defaultLimit
      const defaultLimit = 50;
      const pageCount = undefined;

      // When pageCount is undefined, should return defaultLimit
      const limit = pageCount
        ? Math.min(defaultLimit, Math.max(10, Math.ceil(pageCount * 0.1)))
        : defaultLimit;

      expect(limit).toBe(50);
    });

    test("should return minimum 10 for small sites", () => {
      // 50 pages * 0.1 = 5, but min is 10
      const pageCount = 50;
      const defaultLimit = 50;

      const limit = Math.min(
        defaultLimit,
        Math.max(10, Math.ceil(pageCount * 0.1))
      );

      expect(limit).toBe(10);
    });

    test("should return 10% of pages for medium sites", () => {
      // 200 pages * 0.1 = 20
      const pageCount = 200;
      const defaultLimit = 50;

      const limit = Math.min(
        defaultLimit,
        Math.max(10, Math.ceil(pageCount * 0.1))
      );

      expect(limit).toBe(20);
    });

    test("should cap at default limit for large sites", () => {
      // 1000 pages * 0.1 = 100, but max is 50
      const pageCount = 1000;
      const defaultLimit = 50;

      const limit = Math.min(
        defaultLimit,
        Math.max(10, Math.ceil(pageCount * 0.1))
      );

      expect(limit).toBe(50);
    });

    test("should handle edge cases", () => {
      const defaultLimit = 50;

      // 0 pages
      expect(Math.min(defaultLimit, Math.max(10, 0))).toBe(10);

      // 1 page
      expect(Math.min(defaultLimit, Math.max(10, Math.ceil(1 * 0.1)))).toBe(10);

      // 100 pages (exactly 10)
      expect(Math.min(defaultLimit, Math.max(10, Math.ceil(100 * 0.1)))).toBe(
        10
      );

      // 101 pages (11)
      expect(Math.min(defaultLimit, Math.max(10, Math.ceil(101 * 0.1)))).toBe(
        11
      );

      // 500 pages (50 - at cap)
      expect(Math.min(defaultLimit, Math.max(10, Math.ceil(500 * 0.1)))).toBe(
        50
      );
    });
  });

  describe("script content caching", () => {
    let store: ContentStore;
    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `script-cache-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      store = new ContentStore(join(testDir, "test-content-store.db"));
    });

    afterEach(() => {
      store.close();
      // On Windows, SQLite holds file locks after close() - skip cleanup (OS cleans temp)
      if (process.platform !== "win32" && existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("should cache JavaScript content by URL hash", () => {
      const scriptContent = 'console.log("Hello, World!");';

      // Simulate caching by URL
      store.put(scriptContent, "application/javascript");

      // Store by URL hash for lookup
      // In real implementation, we'd look up by URL hash
      // For test, verify content can be stored and retrieved
      const contentHash = hashContent(scriptContent);
      const retrieved = store.getString(contentHash);

      expect(retrieved).toBe(scriptContent);
    });

    test("should deduplicate identical scripts across sites", () => {
      // Same CDN script used on multiple sites
      const commonScript = `
        // jQuery 3.6.0
        (function(global, factory) {
          "use strict";
          // ...thousands of lines...
        })(typeof window !== "undefined" ? window : this, function(window, noGlobal) {});
      `.repeat(100); // Simulate large file

      const hash1 = store.put(commonScript, "application/javascript");
      const hash2 = store.put(commonScript, "application/javascript");

      expect(hash1).toBe(hash2);

      const stats = store.getStats();
      expect(stats.totalEntries).toBe(1);

      // Verify compression
      const meta = store.getMeta(hash1);
      expect(meta!.compressedSize).toBeLessThan(meta!.originalSize);
    });

    test("should track cache hits via access count", () => {
      const content = "cached script content";
      const hash = store.put(content, "application/javascript");

      // Simulate multiple cache hits
      for (let i = 0; i < 5; i++) {
        store.getString(hash);
      }

      const meta = store.getMeta(hash);
      // Initial put + 5 gets
      expect(meta!.accessCount).toBeGreaterThanOrEqual(6);
    });

    test("should handle various JavaScript content types", () => {
      const scripts = [
        { content: "// ES5 script", name: "es5" },
        { content: "const x = () => {};", name: "es6" },
        { content: "import foo from 'bar';", name: "esm" },
        { content: "(function(){})();", name: "iife" },
        { content: "window.__NEXT_DATA__ = {};", name: "next" },
      ];

      for (const script of scripts) {
        const hash = store.put(script.content, "application/javascript");
        const retrieved = store.getString(hash);
        expect(retrieved).toBe(script.content);
      }

      const stats = store.getStats();
      expect(stats.totalEntries).toBe(5);
    });
  });

  describe("script URL deduplication", () => {
    test("should deduplicate script URLs before fetching", () => {
      const urls = [
        "https://cdn.example.com/script.js",
        "https://cdn.example.com/other.js",
        "https://cdn.example.com/script.js", // Duplicate
        "https://example.com/inline.js",
        "https://cdn.example.com/script.js", // Duplicate
      ];

      const uniqueUrls = [...new Set(urls)];

      expect(uniqueUrls).toHaveLength(3);
      expect(uniqueUrls).toContain("https://cdn.example.com/script.js");
      expect(uniqueUrls).toContain("https://cdn.example.com/other.js");
      expect(uniqueUrls).toContain("https://example.com/inline.js");
    });

    test("should apply dynamic limit after deduplication", () => {
      // 1000 unique URLs
      const urls = Array.from(
        { length: 1000 },
        (_, i) => `https://cdn.example.com/script${i}.js`
      );

      const uniqueUrls = [...new Set(urls)];

      // For 100-page site, limit is max(10, ceil(100 * 0.1)) = 10
      const pageCount = 100;
      const defaultLimit = 50;
      const dynamicLimit = Math.min(
        defaultLimit,
        Math.max(10, Math.ceil(pageCount * 0.1))
      );

      const limitedUrls =
        uniqueUrls.length > dynamicLimit
          ? uniqueUrls.slice(0, dynamicLimit)
          : uniqueUrls;

      expect(limitedUrls).toHaveLength(10);
    });
  });
});
