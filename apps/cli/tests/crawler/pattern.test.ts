import { describe, expect, test } from "bun:test";

import {
  getUrlPattern,
  createPatternStats,
  getPatternStats,
  isPatternSampled,
  markPatternCrawled,
  markPatternQueued,
  getPatternCount,
  clearPatternStats,
} from "@/crawler/pattern";

describe("getUrlPattern", () => {
  test("recognizes homepage", () => {
    expect(getUrlPattern("https://example.com/")).toBe("/");
    expect(getUrlPattern("https://example.com")).toBe("/");
  });

  test("recognizes numeric IDs", () => {
    expect(getUrlPattern("https://example.com/products/12345")).toBe(
      "/products/{id}"
    );
    expect(getUrlPattern("https://example.com/item/999")).toBe("/item/{id}");
    // Single digit numbers could be dates (day) or IDs - we treat as ID
    expect(getUrlPattern("https://example.com/post/1")).toBe("/post/{date}");
    // 5+ digits are definitely IDs
    expect(getUrlPattern("https://example.com/post/12345")).toBe("/post/{id}");
  });

  test("recognizes UUIDs", () => {
    expect(
      getUrlPattern(
        "https://example.com/doc/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
      )
    ).toBe("/doc/{id}");
  });

  test("recognizes hex hashes (12+ chars)", () => {
    // Pure hex characters only
    expect(getUrlPattern("https://example.com/commit/a1b2c3d4e5f6")).toBe(
      "/commit/{id}"
    );
    expect(getUrlPattern("https://example.com/files/abc123def456abc")).toBe(
      "/files/{id}"
    );
    // Mixed with non-hex stays static
    expect(getUrlPattern("https://example.com/files/abc123def456gh")).toBe(
      "/files/abc123def456gh"
    );
  });

  test("recognizes date segments", () => {
    expect(getUrlPattern("https://example.com/blog/2024/01/15/post")).toBe(
      "/blog/{date}/{date}/{date}/post"
    );
    expect(getUrlPattern("https://example.com/archive/2024")).toBe(
      "/archive/{date}"
    );
    expect(getUrlPattern("https://example.com/news/2024-01-15")).toBe(
      "/news/{date}"
    );
  });

  test("recognizes slug patterns (2+ hyphens, long)", () => {
    expect(
      getUrlPattern("https://example.com/blog/my-awesome-blog-post-title")
    ).toBe("/blog/{slug}");
    expect(
      getUrlPattern("https://example.com/articles/this-is-a-very-long-slug")
    ).toBe("/articles/{slug}");
  });

  test("preserves static segments", () => {
    expect(getUrlPattern("https://example.com/about")).toBe("/about");
    expect(getUrlPattern("https://example.com/contact/form")).toBe(
      "/contact/form"
    );
    expect(getUrlPattern("https://example.com/products")).toBe("/products");
  });

  test("handles mixed patterns", () => {
    expect(
      getUrlPattern("https://example.com/category/electronics/item/987")
    ).toBe("/category/electronics/item/{id}");
    expect(getUrlPattern("https://example.com/user/123/posts/456")).toBe(
      "/user/{id}/posts/{id}"
    );
    expect(
      getUrlPattern("https://example.com/2024/01/my-first-blog-post")
    ).toBe("/{date}/{date}/{slug}");
  });

  test("handles query strings by ignoring them", () => {
    expect(getUrlPattern("https://example.com/products/123?size=lg")).toBe(
      "/products/{id}"
    );
  });

  test("returns URL on parse failure", () => {
    expect(getUrlPattern("not-a-url")).toBe("not-a-url");
  });

  test("short slugs are treated as static", () => {
    // Too short to be a slug (< 15 chars with 2+ hyphens)
    expect(getUrlPattern("https://example.com/blog/my-post")).toBe(
      "/blog/my-post"
    );
  });
});

describe("PatternStats", () => {
  test("creates empty stats", () => {
    const stats = createPatternStats();
    expect(getPatternCount(stats)).toBe(0);
  });

  test("tracks queued count", () => {
    const stats = createPatternStats();
    const url = "https://example.com/blog/my-awesome-blog-post";

    markPatternQueued(stats, url);
    expect(getPatternCount(stats)).toBe(1);

    const entry = getPatternStats(stats, url);
    expect(entry).not.toBeNull();
    expect(entry?.queuedCount).toBe(1);
    expect(entry?.crawledCount).toBe(0);
  });

  test("tracks crawled count", () => {
    const stats = createPatternStats();
    const url = "https://example.com/blog/my-awesome-blog-post";

    expect(isPatternSampled(stats, url, 1)).toBe(false);
    markPatternCrawled(stats, url);
    expect(isPatternSampled(stats, url, 1)).toBe(true);

    const entry = getPatternStats(stats, url);
    expect(entry?.crawledCount).toBe(1);
  });

  test("groups similar URLs under same pattern", () => {
    const stats = createPatternStats();

    markPatternCrawled(stats, "https://example.com/blog/my-first-blog-post");
    expect(
      isPatternSampled(
        stats,
        "https://example.com/blog/another-great-article",
        1
      )
    ).toBe(true);
    expect(
      isPatternSampled(
        stats,
        "https://example.com/blog/yet-another-blog-post",
        1
      )
    ).toBe(true);

    // Different pattern should not be sampled
    expect(isPatternSampled(stats, "https://example.com/products/123", 1)).toBe(
      false
    );
  });

  test("respects sample limit", () => {
    const stats = createPatternStats();
    const url = "https://example.com/products/123";

    expect(isPatternSampled(stats, url, 2)).toBe(false);
    markPatternCrawled(stats, url);
    expect(isPatternSampled(stats, url, 2)).toBe(false);
    markPatternCrawled(stats, "https://example.com/products/456");
    expect(isPatternSampled(stats, url, 2)).toBe(true);
  });

  test("decrements queued count when crawled", () => {
    const stats = createPatternStats();
    const url = "https://example.com/products/123";

    markPatternQueued(stats, url);
    markPatternQueued(stats, "https://example.com/products/456");

    let entry = getPatternStats(stats, url);
    expect(entry?.queuedCount).toBe(2);

    markPatternCrawled(stats, url);
    entry = getPatternStats(stats, url);
    expect(entry?.queuedCount).toBe(1);
    expect(entry?.crawledCount).toBe(1);
  });

  test("clears all stats", () => {
    const stats = createPatternStats();

    markPatternCrawled(stats, "https://example.com/a");
    markPatternCrawled(stats, "https://example.com/b");
    expect(getPatternCount(stats)).toBe(2);

    clearPatternStats(stats);
    expect(getPatternCount(stats)).toBe(0);
  });

  test("returns null for unknown patterns", () => {
    const stats = createPatternStats();
    expect(getPatternStats(stats, "https://example.com/unknown")).toBeNull();
  });
});

describe("pattern detection edge cases", () => {
  test("handles deeply nested paths", () => {
    expect(getUrlPattern("https://example.com/a/b/c/d/e/f/123")).toBe(
      "/a/b/c/d/e/f/{id}"
    );
  });

  test("handles trailing slashes", () => {
    expect(getUrlPattern("https://example.com/about/")).toBe("/about");
    expect(getUrlPattern("https://example.com/products/123/")).toBe(
      "/products/{id}"
    );
  });

  test("handles mixed case URLs (pathname is case-sensitive)", () => {
    expect(getUrlPattern("https://example.com/Blog/Post")).toBe("/Blog/Post");
  });

  test("handles special characters in segments", () => {
    expect(getUrlPattern("https://example.com/products/item_123")).toBe(
      "/products/item_123"
    );
  });
});
