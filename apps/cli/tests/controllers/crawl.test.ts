// Tests for crawl controller

import { describe, expect, test } from "bun:test";

import { runCrawl, type CrawlResult } from "../../src/controllers/crawl";
import { domainToProjectName } from "../../src/crawler/storage";

describe("runCrawl", () => {
  test("returns error for empty URL", async () => {
    const result = await runCrawl({ url: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_URL");
    }
  });

  test("returns error for unsupported protocol", async () => {
    const result = await runCrawl({ url: "ftp://example.com" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_URL");
    }
  });

  test("returns error for malformed URL", async () => {
    const result = await runCrawl({ url: "http://" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_URL");
    }
  });

  // Integration test - requires network
  test.skip("crawls a real site", async () => {
    const result = await runCrawl({
      url: "https://example.com",
      onProgress: (progress) => {
        console.log(`Progress: ${progress.phase}`, progress.current);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.crawlId).toBeDefined();
      expect(result.data.pagesCount).toBeGreaterThan(0);
      expect(result.data.baseUrl).toBe("https://example.com");
    }
  });
});

describe("CrawlResult structure", () => {
  test("contains required fields", () => {
    const mockResult: CrawlResult = {
      crawlId: "test-123",
      pagesCount: 5,
      baseUrl: "https://example.com",
      durationMs: 1000,
      limitReached: false,
    };

    expect(mockResult.crawlId).toBe("test-123");
    expect(mockResult.pagesCount).toBe(5);
    expect(mockResult.baseUrl).toBe("https://example.com");
    expect(mockResult.durationMs).toBe(1000);
    expect(mockResult.limitReached).toBe(false);
  });
});

describe("domainToProjectName", () => {
  test("converts URL to project name", () => {
    expect(domainToProjectName("https://example.com")).toBe("example-com");
    expect(domainToProjectName("https://sub.example.com")).toBe(
      "sub-example-com"
    );
    expect(domainToProjectName("https://example.com/path")).toBe("example-com");
  });

  test("includes port for localhost projects", () => {
    expect(domainToProjectName("http://localhost:3000")).toBe("localhost-3000");
    expect(domainToProjectName("http://localhost")).toBe("localhost");
  });
});
