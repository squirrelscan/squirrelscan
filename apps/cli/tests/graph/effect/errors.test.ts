// Tests for effect/errors.ts - Tagged error types

import { describe, it, expect } from "bun:test";

import {
  FetchError,
  CrawlError,
  ParseError,
  RuleError,
  WorkflowError,
  isRetryable,
  getRetryDelay,
} from "../../../src/infra/errors";

describe("FetchError", () => {
  it("creates network error", () => {
    const error = FetchError.network(
      "https://example.com",
      "Connection refused"
    );
    expect(error._tag).toBe("FetchError");
    expect(error.url).toBe("https://example.com");
    expect(error.message).toContain("Connection refused");
    expect(error.retryable).toBe(true);
  });

  it("creates timeout error", () => {
    const error = FetchError.timeout("https://example.com");
    expect(error._tag).toBe("FetchError");
    expect(error.message).toBe("Request timed out");
    expect(error.retryable).toBe(true);
  });

  it("creates not found error", () => {
    const error = FetchError.notFound("https://example.com");
    expect(error._tag).toBe("FetchError");
    expect(error.statusCode).toBe(404);
    expect(error.retryable).toBe(false);
  });

  it("creates server error", () => {
    const error = FetchError.serverError("https://example.com", 500);
    expect(error._tag).toBe("FetchError");
    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it("creates non-retryable server error for 4xx", () => {
    const error = FetchError.serverError("https://example.com", 403);
    expect(error.retryable).toBe(false);
  });
});

describe("CrawlError", () => {
  it("creates network crawl error", () => {
    const error = CrawlError.network("https://example.com", "DNS failed");
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("network");
    expect(error.message).toBe("DNS failed");
  });

  it("creates timeout crawl error", () => {
    const error = CrawlError.timeout("https://example.com");
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("timeout");
  });

  it("creates blocked crawl error", () => {
    const error = CrawlError.blocked("https://example.com");
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("blocked");
  });

  it("creates rate limit error with retry delay", () => {
    const error = CrawlError.rateLimit("https://example.com", 60);
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("rate_limit");
    expect(error.retryAfter).toBe(60);
  });

  it("creates parse error", () => {
    const error = CrawlError.parse("https://example.com", "Invalid HTML");
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("parse");
  });

  it("creates robots disallowed error", () => {
    const error = CrawlError.robotsDisallowed("https://example.com/admin");
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("robots_disallowed");
  });

  it("creates max depth error", () => {
    const error = CrawlError.maxDepth("https://example.com/deep/path", 5);
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("max_depth");
    expect(error.message).toContain("5");
  });

  it("creates max pages error", () => {
    const error = CrawlError.maxPages("https://example.com/page100");
    expect(error._tag).toBe("CrawlError");
    expect(error.type).toBe("max_pages");
  });

  it("has isRetryable getter for timeout", () => {
    const error = CrawlError.timeout("https://example.com");
    expect(error.isRetryable).toBe(true);
  });

  it("has isRetryable getter for rate_limit", () => {
    const error = CrawlError.rateLimit("https://example.com", 30);
    expect(error.isRetryable).toBe(true);
  });

  it("has isRetryable false for blocked", () => {
    const error = CrawlError.blocked("https://example.com");
    expect(error.isRetryable).toBe(false);
  });
});

describe("ParseError", () => {
  it("creates HTML parse error", () => {
    const error = ParseError.html("https://example.com", "Malformed document");
    expect(error._tag).toBe("ParseError");
    expect(error.phase).toBe("html");
    expect(error.message).toBe("Malformed document");
  });

  it("creates meta parse error", () => {
    const error = ParseError.meta("https://example.com", "Invalid meta tags");
    expect(error._tag).toBe("ParseError");
    expect(error.phase).toBe("meta");
  });

  it("creates schema parse error", () => {
    const error = ParseError.schema("https://example.com", "Invalid JSON-LD");
    expect(error._tag).toBe("ParseError");
    expect(error.phase).toBe("schema");
  });
});

describe("RuleError", () => {
  it("creates execution error", () => {
    const error = RuleError.execution(
      "core/meta-title",
      "https://example.com",
      "Rule threw exception"
    );
    expect(error._tag).toBe("RuleError");
    expect(error.ruleId).toBe("core/meta-title");
    expect(error.url).toBe("https://example.com");
    expect(error.message).toBe("Rule threw exception");
  });

  it("creates configuration error", () => {
    const error = RuleError.configuration(
      "core/meta-title",
      "Invalid rule config"
    );
    expect(error._tag).toBe("RuleError");
    expect(error.ruleId).toBe("core/meta-title");
    expect(error.url).toBeUndefined();
  });
});

describe("WorkflowError", () => {
  it("creates workflow error", () => {
    const error = new WorkflowError({
      nodeId: "fetchRobots",
      message: "Node execution failed",
    });
    expect(error._tag).toBe("WorkflowError");
    expect(error.nodeId).toBe("fetchRobots");
    expect(error.message).toBe("Node execution failed");
  });

  it("creates workflow error with cause", () => {
    const cause = new Error("Original error");
    const error = new WorkflowError({
      nodeId: "crawlLoop",
      message: "Crawl failed",
      cause,
    });
    expect(error.cause).toBe(cause);
  });
});

describe("isRetryable", () => {
  it("returns true for retryable FetchError", () => {
    const error = FetchError.network("https://example.com", "Connection reset");
    expect(isRetryable(error)).toBe(true);
  });

  it("returns false for non-retryable FetchError", () => {
    const error = FetchError.notFound("https://example.com");
    expect(isRetryable(error)).toBe(false);
  });

  it("returns true for timeout CrawlError", () => {
    const error = CrawlError.timeout("https://example.com");
    expect(isRetryable(error)).toBe(true);
  });

  it("returns true for rate limit CrawlError", () => {
    const error = CrawlError.rateLimit("https://example.com", 30);
    expect(isRetryable(error)).toBe(true);
  });

  it("returns false for blocked CrawlError", () => {
    const error = CrawlError.blocked("https://example.com");
    expect(isRetryable(error)).toBe(false);
  });

  it("returns false for parse CrawlError", () => {
    const error = CrawlError.parse("https://example.com", "Bad HTML");
    expect(isRetryable(error)).toBe(false);
  });

  it("returns false for ParseError", () => {
    const error = ParseError.html("https://example.com", "Parse failed");
    expect(isRetryable(error)).toBe(false);
  });

  it("returns false for RuleError", () => {
    const error = RuleError.execution(
      "test-rule",
      "https://example.com",
      "Failed"
    );
    expect(isRetryable(error)).toBe(false);
  });

  it("returns false for WorkflowError", () => {
    const error = new WorkflowError({ nodeId: "test", message: "Failed" });
    expect(isRetryable(error)).toBe(false);
  });
});

describe("getRetryDelay", () => {
  it("returns retry-after for rate limit errors", () => {
    const error = CrawlError.rateLimit("https://example.com", 120);
    expect(getRetryDelay(error)).toBe(120);
  });

  it("returns undefined for rate limit without retry-after", () => {
    const error = CrawlError.rateLimit("https://example.com");
    expect(getRetryDelay(error)).toBeUndefined();
  });

  it("returns undefined for network errors", () => {
    const error = CrawlError.network("https://example.com", "Timeout");
    expect(getRetryDelay(error)).toBeUndefined();
  });

  it("returns undefined for FetchError", () => {
    const error = FetchError.timeout("https://example.com");
    expect(getRetryDelay(error)).toBeUndefined();
  });
});
