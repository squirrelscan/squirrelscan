// Unit tests for parallel crawl loop features
// Tests popNextUrls batch fetching and getAllIncomingLinkCounts optimization

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";

import type {
  CrawlStorage,
  LinkAppearanceRecord,
} from "@/crawler/storage/types";

import { createTestStorage } from "@/crawler/storage";

describe("Parallel Crawl Features", () => {
  let storage: CrawlStorage;
  let crawlId: string;

  beforeEach(async () => {
    storage = await Effect.runPromise(createTestStorage());

    crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: "https://example.com",
        seedUrl: "https://example.com",
        originalUrl: "https://example.com",
        startedAt: Date.now(),
        status: "running",
        config: {
          maxPages: 100,
          concurrency: 5,
          perHostConcurrency: 3,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 30000,
          userAgent: "test",
          followRedirects: true,
          respectRobots: false,
          incremental: false,
          include: [],
          exclude: [],
          allowQueryParams: [],
          dropQueryPrefixes: [],
          allowedDomains: [],
        },
        stats: {
          pagesTotal: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      })
    );
  });

  afterEach(async () => {
    await Effect.runPromise(storage.close());
  });

  describe("popNextUrls", () => {
    test("should return empty array when frontier is empty", async () => {
      const urls = await Effect.runPromise(storage.popNextUrls(crawlId, 5));
      expect(urls).toEqual([]);
    });

    test("should pop single URL when count is 1", async () => {
      // Add frontier entry
      await Effect.runPromise(
        storage.upsertFrontier(crawlId, {
          normalizedUrl: "https://example.com/page1",
          rawUrl: "https://example.com/page1",
          depth: 0,
          priority: 1,
          status: "pending",
          source: "seed",
          enqueuedAt: Date.now(),
          retryCount: 0,
        })
      );

      const urls = await Effect.runPromise(storage.popNextUrls(crawlId, 1));

      expect(urls).toHaveLength(1);
      expect(urls[0].normalizedUrl).toBe("https://example.com/page1");
      expect(urls[0].status).toBe("fetching");
    });

    test("should pop multiple URLs in batch", async () => {
      // Add 5 frontier entries
      for (let i = 0; i < 5; i++) {
        await Effect.runPromise(
          storage.upsertFrontier(crawlId, {
            normalizedUrl: `https://example.com/page${i}`,
            rawUrl: `https://example.com/page${i}`,
            depth: 0,
            priority: i, // Different priorities
            status: "pending",
            source: "discovered",
            enqueuedAt: Date.now() + i, // Different timestamps
            retryCount: 0,
          })
        );
      }

      const urls = await Effect.runPromise(storage.popNextUrls(crawlId, 3));

      expect(urls).toHaveLength(3);
      // Should be ordered by priority (lower = higher priority)
      expect(urls[0].priority).toBeLessThanOrEqual(urls[1].priority);
      expect(urls[1].priority).toBeLessThanOrEqual(urls[2].priority);

      // All should be marked as fetching
      for (const url of urls) {
        expect(url.status).toBe("fetching");
      }

      // Verify DB state - entries should be marked fetching
      const fetchingCount = await Effect.runPromise(
        storage.getFetchingCount(crawlId)
      );
      expect(fetchingCount).toBe(3);

      // Remaining entries should still be pending
      const pendingCount = await Effect.runPromise(
        storage.getPendingCount(crawlId)
      );
      expect(pendingCount).toBe(2);
    });

    test("should return fewer URLs if frontier has less than requested", async () => {
      // Add only 2 entries
      for (let i = 0; i < 2; i++) {
        await Effect.runPromise(
          storage.upsertFrontier(crawlId, {
            normalizedUrl: `https://example.com/page${i}`,
            rawUrl: `https://example.com/page${i}`,
            depth: 0,
            priority: 1,
            status: "pending",
            source: "seed",
            enqueuedAt: Date.now(),
            retryCount: 0,
          })
        );
      }

      const urls = await Effect.runPromise(storage.popNextUrls(crawlId, 10));

      expect(urls).toHaveLength(2);
    });

    test("should not pop URLs with non-pending status", async () => {
      // Add mixed status entries
      await Effect.runPromise(
        storage.upsertFrontier(crawlId, {
          normalizedUrl: "https://example.com/pending",
          rawUrl: "https://example.com/pending",
          depth: 0,
          priority: 1,
          status: "pending",
          source: "seed",
          enqueuedAt: Date.now(),
          retryCount: 0,
        })
      );

      await Effect.runPromise(
        storage.upsertFrontier(crawlId, {
          normalizedUrl: "https://example.com/done",
          rawUrl: "https://example.com/done",
          depth: 0,
          priority: 1,
          status: "done",
          source: "seed",
          enqueuedAt: Date.now(),
          retryCount: 0,
        })
      );

      await Effect.runPromise(
        storage.upsertFrontier(crawlId, {
          normalizedUrl: "https://example.com/fetching",
          rawUrl: "https://example.com/fetching",
          depth: 0,
          priority: 1,
          status: "fetching",
          source: "seed",
          enqueuedAt: Date.now(),
          retryCount: 0,
        })
      );

      const urls = await Effect.runPromise(storage.popNextUrls(crawlId, 10));

      expect(urls).toHaveLength(1);
      expect(urls[0].normalizedUrl).toBe("https://example.com/pending");
    });

    test("should respect priority ordering", async () => {
      // Add entries with explicit priorities (lower = higher priority)
      const entries = [
        { url: "low-priority", priority: 100 },
        { url: "high-priority", priority: 1 },
        { url: "medium-priority", priority: 50 },
      ];

      for (const entry of entries) {
        await Effect.runPromise(
          storage.upsertFrontier(crawlId, {
            normalizedUrl: `https://example.com/${entry.url}`,
            rawUrl: `https://example.com/${entry.url}`,
            depth: 0,
            priority: entry.priority,
            status: "pending",
            source: "discovered",
            enqueuedAt: Date.now(),
            retryCount: 0,
          })
        );
      }

      const urls = await Effect.runPromise(storage.popNextUrls(crawlId, 3));

      expect(urls[0].normalizedUrl).toContain("high-priority");
      expect(urls[1].normalizedUrl).toContain("medium-priority");
      expect(urls[2].normalizedUrl).toContain("low-priority");
    });
  });

  describe("getAllIncomingLinkCounts", () => {
    test("should return empty map when no links exist", async () => {
      const counts = await Effect.runPromise(
        storage.getAllIncomingLinkCounts(crawlId)
      );
      expect(counts.size).toBe(0);
    });

    test("should count incoming links for single target", async () => {
      // Add link appearances to same target from different pages
      const appearances: LinkAppearanceRecord[] = [
        {
          href: "https://example.com/target",
          pageUrl: "https://example.com/page1",
          anchorText: "Link 1",
          position: "content",
          isNofollow: false,
        },
        {
          href: "https://example.com/target",
          pageUrl: "https://example.com/page2",
          anchorText: "Link 2",
          position: "nav",
          isNofollow: false,
        },
        {
          href: "https://example.com/target",
          pageUrl: "https://example.com/page3",
          anchorText: "Link 3",
          position: "footer",
          isNofollow: false,
        },
      ];

      await Effect.runPromise(
        storage.addLinkAppearancesBatch(crawlId, appearances)
      );

      const counts = await Effect.runPromise(
        storage.getAllIncomingLinkCounts(crawlId)
      );

      expect(counts.get("https://example.com/target")).toBe(3);
    });

    test("should count incoming links for multiple targets", async () => {
      const appearances: LinkAppearanceRecord[] = [
        // 2 links to page A
        {
          href: "https://example.com/pageA",
          pageUrl: "https://example.com/1",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        {
          href: "https://example.com/pageA",
          pageUrl: "https://example.com/2",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        // 5 links to page B
        {
          href: "https://example.com/pageB",
          pageUrl: "https://example.com/1",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        {
          href: "https://example.com/pageB",
          pageUrl: "https://example.com/2",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        {
          href: "https://example.com/pageB",
          pageUrl: "https://example.com/3",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        {
          href: "https://example.com/pageB",
          pageUrl: "https://example.com/4",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        {
          href: "https://example.com/pageB",
          pageUrl: "https://example.com/5",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
        // 1 link to page C
        {
          href: "https://example.com/pageC",
          pageUrl: "https://example.com/1",
          anchorText: "",
          position: "content",
          isNofollow: false,
        },
      ];

      await Effect.runPromise(
        storage.addLinkAppearancesBatch(crawlId, appearances)
      );

      const counts = await Effect.runPromise(
        storage.getAllIncomingLinkCounts(crawlId)
      );

      expect(counts.get("https://example.com/pageA")).toBe(2);
      expect(counts.get("https://example.com/pageB")).toBe(5);
      expect(counts.get("https://example.com/pageC")).toBe(1);
      expect(counts.has("https://example.com/nonexistent")).toBe(false);
    });

    test("should handle large number of links efficiently", async () => {
      // Add 1000 link appearances
      const appearances: LinkAppearanceRecord[] = [];
      for (let i = 0; i < 1000; i++) {
        appearances.push({
          href: `https://example.com/target${i % 100}`, // 100 unique targets
          pageUrl: `https://example.com/page${i}`,
          anchorText: `Link ${i}`,
          position: "content",
          isNofollow: false,
        });
      }

      await Effect.runPromise(
        storage.addLinkAppearancesBatch(crawlId, appearances)
      );

      const startTime = Date.now();
      const counts = await Effect.runPromise(
        storage.getAllIncomingLinkCounts(crawlId)
      );
      const elapsed = Date.now() - startTime;

      // Should have 100 unique targets
      expect(counts.size).toBe(100);

      // Each target should have 10 links (1000 / 100)
      for (const [, count] of counts) {
        expect(count).toBe(10);
      }

      // Should be fast (single query vs N+1)
      expect(elapsed).toBeLessThan(500); // Should be well under 500ms
    });
  });

  describe("addLinkAppearancesBatch", () => {
    test("should insert multiple link appearances in single transaction", async () => {
      const appearances: LinkAppearanceRecord[] = [];
      for (let i = 0; i < 50; i++) {
        appearances.push({
          href: `https://example.com/link${i}`,
          pageUrl: "https://example.com/source",
          anchorText: `Link ${i}`,
          position: "content",
          isNofollow: i % 2 === 0,
        });
      }

      await Effect.runPromise(
        storage.addLinkAppearancesBatch(crawlId, appearances)
      );

      // Verify all were inserted
      for (let i = 0; i < 50; i++) {
        const linkAppearances = await Effect.runPromise(
          storage.getLinkAppearances(crawlId, `https://example.com/link${i}`)
        );
        expect(linkAppearances).toHaveLength(1);
        expect(linkAppearances[0].anchorText).toBe(`Link ${i}`);
      }
    });

    test("should handle empty array", async () => {
      // Should not throw
      await Effect.runPromise(storage.addLinkAppearancesBatch(crawlId, []));
    });
  });
});
