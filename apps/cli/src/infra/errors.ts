// Tagged error types for SquirrelScan graph execution
// Uses Effect's Data.TaggedError for pattern matching and type-safe error handling

import { Data } from "effect";

// ============================================
// FETCH ERRORS
// ============================================

export class FetchError extends Data.TaggedError("FetchError")<{
  url: string;
  statusCode?: number;
  message: string;
  retryable: boolean;
}> {
  static network(url: string, message: string): FetchError {
    return new FetchError({ url, message, retryable: true });
  }

  static timeout(url: string): FetchError {
    return new FetchError({
      url,
      message: "Request timed out",
      retryable: true,
    });
  }

  static notFound(url: string): FetchError {
    return new FetchError({
      url,
      statusCode: 404,
      message: "Not found",
      retryable: false,
    });
  }

  static serverError(url: string, statusCode: number): FetchError {
    return new FetchError({
      url,
      statusCode,
      message: `Server error: ${statusCode}`,
      retryable: statusCode >= 500,
    });
  }
}

// ============================================
// CRAWL ERRORS
// ============================================

export type CrawlErrorType =
  | "timeout"
  | "network"
  | "parse"
  | "blocked"
  | "rate_limit"
  | "robots_disallowed"
  | "max_depth"
  | "max_pages";

export class CrawlError extends Data.TaggedError("CrawlError")<{
  url: string;
  type: CrawlErrorType;
  message: string;
  retryAfter?: number;
}> {
  static timeout(url: string): CrawlError {
    return new CrawlError({
      url,
      type: "timeout",
      message: "Crawl request timed out",
    });
  }

  static network(url: string, message: string): CrawlError {
    return new CrawlError({ url, type: "network", message });
  }

  static parse(url: string, message: string): CrawlError {
    return new CrawlError({ url, type: "parse", message });
  }

  static blocked(url: string): CrawlError {
    return new CrawlError({
      url,
      type: "blocked",
      message: "Request blocked by server",
    });
  }

  static rateLimit(url: string, retryAfter?: number): CrawlError {
    return new CrawlError({
      url,
      type: "rate_limit",
      message: "Rate limited",
      retryAfter,
    });
  }

  static robotsDisallowed(url: string): CrawlError {
    return new CrawlError({
      url,
      type: "robots_disallowed",
      message: "Disallowed by robots.txt",
    });
  }

  static maxDepth(url: string, depth: number): CrawlError {
    return new CrawlError({
      url,
      type: "max_depth",
      message: `Exceeded max depth: ${depth}`,
    });
  }

  static maxPages(url: string): CrawlError {
    return new CrawlError({
      url,
      type: "max_pages",
      message: "Exceeded max pages limit",
    });
  }

  get isRetryable(): boolean {
    return this.type === "timeout" || this.type === "rate_limit";
  }
}

// ============================================
// PARSE ERRORS
// ============================================

export class ParseError extends Data.TaggedError("ParseError")<{
  url: string;
  phase: "html" | "meta" | "links" | "images" | "schema" | "headings";
  message: string;
}> {
  static html(url: string, message: string): ParseError {
    return new ParseError({ url, phase: "html", message });
  }

  static meta(url: string, message: string): ParseError {
    return new ParseError({ url, phase: "meta", message });
  }

  static schema(url: string, message: string): ParseError {
    return new ParseError({ url, phase: "schema", message });
  }
}

// ============================================
// RULE ERRORS
// ============================================

export class RuleError extends Data.TaggedError("RuleError")<{
  ruleId: string;
  url?: string;
  message: string;
}> {
  static execution(ruleId: string, url: string, message: string): RuleError {
    return new RuleError({ ruleId, url, message });
  }

  static configuration(ruleId: string, message: string): RuleError {
    return new RuleError({ ruleId, message });
  }
}

// ============================================
// WORKFLOW ERRORS
// ============================================

export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  nodeId: string;
  message: string;
  cause?: unknown;
}> {}

// ============================================
// UNION TYPE
// ============================================

export type GraphError =
  | FetchError
  | CrawlError
  | ParseError
  | RuleError
  | WorkflowError;

// ============================================
// ERROR UTILITIES
// ============================================

export function isRetryable(error: GraphError): boolean {
  switch (error._tag) {
    case "FetchError":
      return error.retryable;
    case "CrawlError":
      return error.isRetryable;
    case "ParseError":
    case "RuleError":
    case "WorkflowError":
      return false;
  }
}

export function getRetryDelay(error: GraphError): number | undefined {
  if (error._tag === "CrawlError" && error.type === "rate_limit") {
    return error.retryAfter;
  }
  return undefined;
}
