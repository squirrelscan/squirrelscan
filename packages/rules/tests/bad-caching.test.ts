// perf/bad-caching — site-wide weak-caching detection (#109).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { badCachingRule } from "../src/performance/bad-caching";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

function siteCtx(
  pages: { url: string; headers: Record<string, string> }[]
): RuleContext {
  const html = "<html><head><title>t</title></head><body></body></html>";
  const sitePages: SiteData["pages"] = pages.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(html, p.url),
    headers: { "content-type": "text/html", ...p.headers },
  }));
  return {
    page: {
      url: sitePages[0]?.url ?? "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: sitePages[0]?.parsed ?? ({} as ParsedPage),
    site: {
      baseUrl: "https://example.com",
      pages: sitePages,
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  };
}

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

const goodHeaders = {
  "cache-control": "public, max-age=3600",
  etag: '"abc123"',
  "content-encoding": "br",
};

describe("perf/bad-caching", () => {
  test("skips when no HTML pages with headers", () => {
    const checks = run(badCachingRule, siteCtx([]));
    expect(check(checks, "bad-caching")?.status).toBe("skipped");
  });

  test("passes a well-cached, compressed site", () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: goodHeaders,
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    expect(check(checks, "bad-caching-compression")?.status).toBe("pass");
  });

  test("flags missing freshness across the site", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { etag: '"x"', "content-encoding": "gzip" }, // no cache-control/expires
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("fail");
    expect(freshness?.pages?.length).toBeGreaterThan(0);
  });

  test("no-store does not count as freshness", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-store, max-age=3600",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  test("no-cache does not count as freshness (matches crawler)", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-cache, max-age=3600",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  test("s-maxage=0 overrides max-age (no freshness, matches crawler)", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "max-age=3600, s-maxage=0",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  test("flags missing validators", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", "content-encoding": "br" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-validators")?.status).toBe("fail");
  });

  test("flags uncompressed compressible responses", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", etag: '"x"' }, // no content-encoding
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-compression")?.status).toBe("fail");
  });

  test("Expires header satisfies freshness", () => {
    const expires = new Date(Date.now() + 3600 * 1000).toUTCString();
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires, "last-modified": "x", "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
  });
});
