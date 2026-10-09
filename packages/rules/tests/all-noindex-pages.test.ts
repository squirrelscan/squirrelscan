// crawl/all-noindex-pages — options live in meta.optionsSchema so the runner validates them (#511).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { allNoindexPages } from "../src/crawl/all-noindex-pages";
import type { CheckResult, RuleContext } from "../src/types";

const ORIGIN = "https://example.com";
const NOINDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post</title><meta name="robots" content="noindex"></head><body><h1>Post</h1></body></html>`;

function noindexPage(path: string) {
  const url = `${ORIGIN}${path}`;
  return { url, statusCode: 200, headers: {}, parsed: parsePage(NOINDEX, url) };
}

function makeCtx(paths: string[], options: Record<string, unknown>): RuleContext {
  return {
    options,
    site: {
      baseUrl: ORIGIN,
      pages: paths.map(noindexPage),
      robotsTxt: null,
      sitemaps: null,
    },
  } as unknown as RuleContext;
}

function run(paths: string[], options: Record<string, unknown>): CheckResult[] {
  const result = allNoindexPages.run(makeCtx(paths, options)) as { checks: CheckResult[] };
  return result.checks;
}

describe("crawl/all-noindex-pages options", () => {
  test("optionsSchema is declared inside meta", () => {
    expect(allNoindexPages.meta.optionsSchema).toBeDefined();
  });

  test("defaults are applied when no options are set", () => {
    const parsed = allNoindexPages.meta.optionsSchema?.parse({}) as Record<string, unknown>;
    expect(parsed).toEqual({ warnOnPatterns: [], errorOnPatterns: [] });
  });

  test("a non-array pattern is rejected by the schema", () => {
    expect(() => allNoindexPages.meta.optionsSchema?.parse({ warnOnPatterns: "/blog/" })).toThrow();
    expect(() => allNoindexPages.meta.optionsSchema?.parse({ errorOnPatterns: "/blog/" })).toThrow();
  });

  test("errorOnPatterns still escalates a noindexed page to critical", () => {
    const checks = run(["/blog/post/"], { errorOnPatterns: ["/blog/"] });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("critical-noindex");
    expect(checks[0]?.status).toBe("fail");
  });

  test("warnOnPatterns still escalates a noindexed page to important", () => {
    const checks = run(["/products/shirt/"], { warnOnPatterns: ["/products/"] });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("important-noindex");
    expect(checks[0]?.status).toBe("warn");
  });
});
