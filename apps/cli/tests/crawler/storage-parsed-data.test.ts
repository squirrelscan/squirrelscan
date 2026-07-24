// Unit tests for storage layer parsed_data functionality
// Tests schema migration, storage, and retrieval of parsed page data

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";

import type { PageRecord, CrawlStorage } from "@/crawler/storage/types";

import { createTestStorage } from "@/crawler/storage";

describe("Storage - Parsed Data", () => {
  let storage: CrawlStorage;
  let crawlId: string;

  beforeEach(async () => {
    // Create in-memory storage for testing
    storage = await Effect.runPromise(createTestStorage());

    // Create a test crawl with proper metadata
    crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: "https://example.com",
        seedUrl: "https://example.com",
        originalUrl: "https://example.com",
        startedAt: Date.now(),
        status: "running",
        config: {
          maxPages: 10,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 100,
          perHostDelayMs: 100,
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
    // Close storage
    await Effect.runPromise(storage.close());
  });

  test("should store page with null parsed_data", async () => {
    const pageRecord: PageRecord = {
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      finalUrl: "https://example.com",
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 1024,
      loadTimeMs: 100,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: "abc123",
      html: "<html><body>test</body></html>",
      parsedData: null,
      headers: {
        contentType: "text/html",
        contentEncoding: null,
        cacheControl: null,
        vary: null,
        etag: null,
        server: null,
        lastModified: null,
        link: null,
        serverTiming: null,
        age: null,
        xCache: null,
        cfCacheStatus: null,
        xVercelCache: null,
        altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null,
        csp: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
        permissionsPolicy: null,
        xRobotsTag: null,
      },
    };

    await Effect.runPromise(storage.upsertPage(crawlId, pageRecord));

    const retrieved = await Effect.runPromise(
      storage.getPage(crawlId, "https://example.com")
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved?.parsedData).toBeNull();
    expect(retrieved?.html).toBe("<html><body>test</body></html>");
  });

  test("should store and retrieve page with parsed_data JSON", async () => {
    const parsedData = {
      meta: {
        title: "Test Page",
        description: "A test page",
        canonical: "https://example.com",
        robots: null,
      },
      h1: {
        count: 1,
        texts: ["Test Heading"],
      },
      og: {
        title: "Test Page",
        description: "A test page",
        url: "https://example.com",
        type: "website",
        image: null,
        siteName: "Example",
      },
      twitter: {
        card: "summary",
        title: null,
        description: null,
        image: null,
      },
      links: [
        { url: "https://example.com/about", text: "About", isInternal: true },
      ],
      images: [
        {
          src: "https://example.com/logo.png",
          alt: "Logo",
          width: null,
          height: null,
        },
      ],
      headings: {
        headings: [{ level: 1, text: "Test Heading", order: 0 }],
        h1Count: 1,
        h1Texts: ["Test Heading"],
        hasSkippedLevels: false,
        skippedLevels: [],
        emptyHeadings: [],
        longHeadings: [],
        duplicateHeadings: [],
        outline: "H1: Test Heading",
      },
      content: {
        wordCount: 100,
        textLength: 500,
        htmlLength: 1024,
        textToHtmlRatio: 0.49,
        isThinContent: true,
        contentHash: "hash123",
        textContent: "Test content",
      },
    };

    const pageRecord: PageRecord = {
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      finalUrl: "https://example.com",
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 1024,
      loadTimeMs: 100,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: "abc123",
      html: "<html><body>test</body></html>",
      parsedData: JSON.stringify(parsedData),
      headers: {
        contentType: "text/html",
        contentEncoding: null,
        cacheControl: null,
        vary: null,
        etag: null,
        server: null,
        lastModified: null,
        link: null,
        serverTiming: null,
        age: null,
        xCache: null,
        cfCacheStatus: null,
        xVercelCache: null,
        altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null,
        csp: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
        permissionsPolicy: null,
        xRobotsTag: null,
      },
    };

    await Effect.runPromise(storage.upsertPage(crawlId, pageRecord));

    const retrieved = await Effect.runPromise(
      storage.getPage(crawlId, "https://example.com")
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved?.parsedData).not.toBeNull();

    const retrievedParsed = JSON.parse(retrieved!.parsedData!);
    expect(retrievedParsed.meta.title).toBe("Test Page");
    expect(retrievedParsed.h1.count).toBe(1);
    expect(retrievedParsed.links).toHaveLength(1);
    expect(retrievedParsed.images).toHaveLength(1);
    expect(retrievedParsed.content.wordCount).toBe(100);
  });

  test("should update page parsed_data on upsert", async () => {
    const initialPage: PageRecord = {
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      finalUrl: "https://example.com",
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 1024,
      loadTimeMs: 100,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: "abc123",
      html: "<html><body>test</body></html>",
      parsedData: null,
      headers: {
        contentType: "text/html",
        contentEncoding: null,
        cacheControl: null,
        vary: null,
        etag: null,
        server: null,
        lastModified: null,
        link: null,
        serverTiming: null,
        age: null,
        xCache: null,
        cfCacheStatus: null,
        xVercelCache: null,
        altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null,
        csp: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
        permissionsPolicy: null,
        xRobotsTag: null,
      },
    };

    await Effect.runPromise(storage.upsertPage(crawlId, initialPage));

    const retrieved1 = await Effect.runPromise(
      storage.getPage(crawlId, "https://example.com")
    );
    expect(retrieved1?.parsedData).toBeNull();

    // Update with parsed data
    const updatedPage: PageRecord = {
      ...initialPage,
      parsedData: JSON.stringify({ meta: { title: "Updated" } }),
    };

    await Effect.runPromise(storage.upsertPage(crawlId, updatedPage));

    const retrieved2 = await Effect.runPromise(
      storage.getPage(crawlId, "https://example.com")
    );
    expect(retrieved2?.parsedData).not.toBeNull();
    const parsed = JSON.parse(retrieved2!.parsedData!);
    expect(parsed.meta.title).toBe("Updated");
  });

  test("should retrieve multiple pages with parsed_data", async () => {
    const pages: PageRecord[] = [];
    for (let i = 0; i < 3; i++) {
      pages.push({
        url: `https://example.com/page${i}`,
        normalizedUrl: `https://example.com/page${i}`,
        finalUrl: `https://example.com/page${i}`,
        depth: i,
        status: 200,
        contentType: "text/html",
        sizeBytes: 1024,
        loadTimeMs: 100,
        fetchedAt: Date.now(),
        etag: null,
        lastModified: null,
        contentHash: `hash${i}`,
        html: `<html><body>page ${i}</body></html>`,
        parsedData: JSON.stringify({
          meta: { title: `Page ${i}` },
          h1: { count: 1, texts: [`Heading ${i}`] },
        }),
        headers: {
          contentType: "text/html",
          contentEncoding: null,
          cacheControl: null,
          vary: null,
          etag: null,
          server: null,
          lastModified: null,
          link: null,
          serverTiming: null,
          age: null,
          xCache: null,
          cfCacheStatus: null,
          xVercelCache: null,
          altSvc: null,
          acceptRanges: null,
        },
        securityHeaders: {
          hsts: null,
          csp: null,
          xFrameOptions: null,
          xContentTypeOptions: null,
          referrerPolicy: null,
          permissionsPolicy: null,
          xRobotsTag: null,
        },
      });
    }

    for (const page of pages) {
      await Effect.runPromise(storage.upsertPage(crawlId, page));
    }

    const allPages = await Effect.runPromise(storage.getPages(crawlId));
    expect(allPages).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      const page = allPages.find(
        (p) => p.url === `https://example.com/page${i}`
      );
      expect(page).not.toBeUndefined();
      expect(page?.parsedData).not.toBeNull();
      const parsed = JSON.parse(page!.parsedData!);
      expect(parsed.meta.title).toBe(`Page ${i}`);
      expect(parsed.h1.texts[0]).toBe(`Heading ${i}`);
    }
  });

  test("should handle empty parsed_data gracefully", async () => {
    const pageRecord: PageRecord = {
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      finalUrl: "https://example.com",
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 1024,
      loadTimeMs: 100,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: "abc123",
      html: "<html><body>test</body></html>",
      parsedData: JSON.stringify({}), // Empty object
      headers: {
        contentType: "text/html",
        contentEncoding: null,
        cacheControl: null,
        vary: null,
        etag: null,
        server: null,
        lastModified: null,
        link: null,
        serverTiming: null,
        age: null,
        xCache: null,
        cfCacheStatus: null,
        xVercelCache: null,
        altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null,
        csp: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
        permissionsPolicy: null,
        xRobotsTag: null,
      },
    };

    await Effect.runPromise(storage.upsertPage(crawlId, pageRecord));

    const retrieved = await Effect.runPromise(
      storage.getPage(crawlId, "https://example.com")
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved?.parsedData).not.toBeNull();
    const parsed = JSON.parse(retrieved!.parsedData!);
    expect(parsed).toEqual({});
  });

  test("should handle corrupted state (parsedData exists but html is null)", async () => {
    const pageRecord: PageRecord = {
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      finalUrl: "https://example.com",
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 1024,
      loadTimeMs: 100,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: "abc123",
      html: null, // Corrupted: null HTML
      parsedData: JSON.stringify({ meta: { title: "Test" } }), // But has parsedData
      headers: {
        contentType: "text/html",
        contentEncoding: null,
        cacheControl: null,
        vary: null,
        etag: null,
        server: null,
        lastModified: null,
        link: null,
        serverTiming: null,
        age: null,
        xCache: null,
        cfCacheStatus: null,
        xVercelCache: null,
        altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null,
        csp: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
        permissionsPolicy: null,
        xRobotsTag: null,
      },
    };

    await Effect.runPromise(storage.upsertPage(crawlId, pageRecord));

    const retrieved = await Effect.runPromise(
      storage.getPage(crawlId, "https://example.com")
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved?.html).toBeNull();
    expect(retrieved?.parsedData).not.toBeNull();
    // This represents a corrupted state that adapter should handle gracefully
  });
});
