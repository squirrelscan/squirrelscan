// perf/cache-headers — Cache-Control header analysis.
//
// Locks in rule behaviour after migrating the local parser onto the shared
// @squirrelscan/utils/cache-control parser (#508 / #146 residue).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { cacheHeadersRule } from "../src/performance/cache-headers";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function pageCtx(url: string, headers: Record<string, string>): RuleContext {
  return {
    page: {
      url,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers,
    },
    parsed: {} as ParsedPage,
    options: {},
  };
}

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("perf/cache-headers", () => {
  test("warns when no caching headers present", () => {
    const checks = run(cacheHeadersRule, pageCtx("https://example.com/", {}));
    expect(check(checks, "cache-headers-missing")?.status).toBe("warn");
  });

  test("no-store reports info and short-circuits", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/app.js", { "cache-control": "no-store" }),
    );
    expect(check(checks, "cache-control")?.status).toBe("info");
    expect(check(checks, "cache-control")?.message).toContain("no-store");
    expect(checks).toHaveLength(1);
  });

  test("no-cache with validator passes", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/", {
        "cache-control": "no-cache",
        etag: '"abc"',
      }),
    );
    expect(check(checks, "cache-control")?.status).toBe("pass");
  });

  test("no-cache without validator warns", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/", { "cache-control": "no-cache" }),
    );
    expect(check(checks, "cache-control")?.status).toBe("warn");
  });

  test("static asset with long max-age passes", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/app.js", {
        "cache-control": "public, max-age=31536000",
      }),
    );
    expect(check(checks, "cache-control-static")?.status).toBe("pass");
  });

  test("static asset with short max-age warns", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/app.js", {
        "cache-control": "public, max-age=60",
      }),
    );
    expect(check(checks, "cache-control-static")?.status).toBe("warn");
  });

  test("HTML with long max-age reports info", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/page", {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "max-age=7200",
      }),
    );
    expect(check(checks, "cache-control-html")?.status).toBe("info");
  });

  test("HTML with short max-age passes", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/page", {
        "content-type": "text/html",
        "cache-control": "max-age=300",
      }),
    );
    expect(check(checks, "cache-control-html")?.status).toBe("pass");
  });

  test("immutable directive reported alongside max-age", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/app.js", {
        "cache-control": "public, max-age=31536000, immutable",
      }),
    );
    expect(check(checks, "cache-immutable")?.status).toBe("pass");
  });

  test("Cache-Control without max-age warns", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/app.js", { "cache-control": "public" }),
    );
    expect(check(checks, "cache-control")?.status).toBe("warn");
    expect(check(checks, "cache-control")?.message).toContain("without max-age");
  });

  test("Expires-only reports info", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/", {
        expires: "Wed, 21 Oct 2026 07:28:00 GMT",
      }),
    );
    expect(check(checks, "cache-expires")?.status).toBe("info");
  });

  test("directive matching is case-insensitive", () => {
    const checks = run(
      cacheHeadersRule,
      pageCtx("https://example.com/app.js", {
        "cache-control": "Public, Max-Age=31536000, Immutable",
      }),
    );
    expect(check(checks, "cache-control-static")?.status).toBe("pass");
    expect(check(checks, "cache-immutable")?.status).toBe("pass");
  });
});
