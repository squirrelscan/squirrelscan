import { describe, it, expect } from "bun:test";

import {
  matchesExcludePattern,
  COMMON_EXCLUDE_PATTERNS,
} from "@/utils/patterns";

describe("matchesExcludePattern", () => {
  describe("substring matching (backward compatible)", () => {
    it("matches substring in URL", () => {
      expect(
        matchesExcludePattern("https://example.com/thank-you", ["/thank-you"])
      ).toBe(true);
    });

    it("matches substring anywhere in URL", () => {
      expect(
        matchesExcludePattern("https://example.com/pages/thank-you-note", [
          "/thank-you",
        ])
      ).toBe(true);
    });

    it("does not match when substring not present", () => {
      expect(
        matchesExcludePattern("https://example.com/contact", ["/thank-you"])
      ).toBe(false);
    });

    it("matches any pattern in array", () => {
      expect(
        matchesExcludePattern("https://example.com/confirmation", [
          "/thank-you",
          "/confirmation",
        ])
      ).toBe(true);
    });

    it("returns false for empty patterns array", () => {
      expect(matchesExcludePattern("https://example.com/page", [])).toBe(false);
    });
  });

  describe("exact segment matching (trailing slash patterns)", () => {
    it("matches exact path with trailing slash pattern", () => {
      expect(
        matchesExcludePattern("https://example.com/thank-you", ["/thank-you/"])
      ).toBe(true);
    });

    it("matches path as directory prefix", () => {
      expect(
        matchesExcludePattern("https://example.com/thank-you/page", [
          "/thank-you/",
        ])
      ).toBe(true);
    });

    it("does not match different path with similar name", () => {
      expect(
        matchesExcludePattern("https://example.com/thank-you-note", [
          "/thank-you/",
        ])
      ).toBe(false);
    });

    it("does not match when path is substring but not segment", () => {
      expect(
        matchesExcludePattern("https://example.com/pages/thank-you-later", [
          "/thank-you/",
        ])
      ).toBe(false);
    });

    it("matches root path", () => {
      expect(
        matchesExcludePattern("https://example.com/blog/post", ["/blog/"])
      ).toBe(true);
    });

    it("handles trailing slash in URL", () => {
      expect(
        matchesExcludePattern("https://example.com/blog/", ["/blog/"])
      ).toBe(true);
    });

    it("distinguishes /blog from /blog-posts with exact matching", () => {
      expect(
        matchesExcludePattern("https://example.com/blog-posts/page", ["/blog/"])
      ).toBe(false);
    });
  });

  describe("regex pattern matching", () => {
    it("matches regex pattern with date format", () => {
      expect(
        matchesExcludePattern("https://example.com/blog/2024/01/post", [
          "regex:^/blog/\\d{4}/",
        ])
      ).toBe(true);
    });

    it("does not match when regex fails", () => {
      expect(
        matchesExcludePattern("https://example.com/blog/latest/post", [
          "regex:^/blog/\\d{4}/",
        ])
      ).toBe(false);
    });

    it("handles complex regex patterns", () => {
      expect(
        matchesExcludePattern("https://example.com/products/category-123", [
          "regex:/products/(category|item)-\\d+",
        ])
      ).toBe(true);
    });

    it("matches product item pattern", () => {
      expect(
        matchesExcludePattern("https://example.com/products/item-456", [
          "regex:/products/(category|item)-\\d+",
        ])
      ).toBe(true);
    });

    it("returns false for invalid regex", () => {
      // Invalid regex (unmatched parenthesis)
      expect(
        matchesExcludePattern("https://example.com/page", ["regex:[invalid("])
      ).toBe(false);
    });

    it("handles end-of-string anchor", () => {
      expect(
        matchesExcludePattern("https://example.com/page.html", [
          "regex:\\.html$",
        ])
      ).toBe(true);
    });

    it("case-sensitive regex by default", () => {
      expect(
        matchesExcludePattern("https://example.com/Blog/post", ["regex:^/blog"])
      ).toBe(false);
    });

    it("supports case-insensitive regex with flag", () => {
      expect(
        matchesExcludePattern("https://example.com/Blog/post", [
          "regex:^/blog:i",
        ])
      ).toBe(true);
    });
  });

  describe("mixed pattern types", () => {
    it("matches when any pattern matches", () => {
      expect(
        matchesExcludePattern("https://example.com/blog/2024/post", [
          "/admin/",
          "regex:^/blog/\\d{4}/",
          "/thank-you/",
        ])
      ).toBe(true);
    });

    it("distinguishes exact vs substring for same path", () => {
      // /thank-you (substring) matches /thank-you-note
      expect(
        matchesExcludePattern("https://example.com/thank-you-note", [
          "/thank-you",
        ])
      ).toBe(true);

      // /thank-you/ (exact) does NOT match /thank-you-note
      expect(
        matchesExcludePattern("https://example.com/thank-you-note", [
          "/thank-you/",
        ])
      ).toBe(false);
    });

    it("handles all three pattern types together", () => {
      const patterns = [
        "/admin/", // exact segment
        "/temp", // substring
        "regex:^/api/v\\d+/", // regex
      ];

      expect(
        matchesExcludePattern("https://example.com/admin/users", patterns)
      ).toBe(true);
      expect(
        matchesExcludePattern("https://example.com/temporary-page", patterns)
      ).toBe(true);
      expect(
        matchesExcludePattern("https://example.com/api/v2/endpoint", patterns)
      ).toBe(true);
      expect(
        matchesExcludePattern("https://example.com/public/page", patterns)
      ).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty pattern string", () => {
      expect(
        matchesExcludePattern("https://example.com/page", ["", "/admin"])
      ).toBe(false);
    });

    it("handles URL without protocol", () => {
      expect(matchesExcludePattern("/page/subpage", ["/page/"])).toBe(true);
    });

    it("handles invalid URL gracefully", () => {
      expect(matchesExcludePattern("not-a-url", ["/page"])).toBe(false);
    });

    it("handles single slash pattern", () => {
      expect(matchesExcludePattern("https://example.com/", ["/"])).toBe(true);
    });

    it("treats single slash as substring, not exact match", () => {
      // Single "/" should use substring logic (backward compatible)
      expect(matchesExcludePattern("https://example.com/page", ["/"])).toBe(
        true
      );
    });

    it("handles patterns with special regex characters as substring", () => {
      // Without regex: prefix, special chars should be treated literally
      expect(
        matchesExcludePattern("https://example.com/page?id=123", ["?id="])
      ).toBe(true);
    });
  });

  describe("COMMON_EXCLUDE_PATTERNS", () => {
    it("exports dead-end patterns", () => {
      expect(COMMON_EXCLUDE_PATTERNS.deadEnd).toBeArrayOfSize(5);
      expect(COMMON_EXCLUDE_PATTERNS.deadEnd).toContain("/thank-you");
    });

    it("exports orphan patterns", () => {
      expect(COMMON_EXCLUDE_PATTERNS.orphan).toBeArrayOfSize(3);
      expect(COMMON_EXCLUDE_PATTERNS.orphan).toContain("/landing-page");
    });
  });
});
