import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import { robotsTxtRule } from "../src/crawl/robots-txt";
import type { ParsedPage, RuleContext } from "../src/types";

const ROBOTS_URL = "https://example.com/robots.txt";

function run(content: string): CheckResult[] {
  const robotsTxt = parseRobotsTxt(content, ROBOTS_URL);
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt,
      sitemaps: null,
    },
    options: {},
  } as RuleContext;
  return robotsTxtRule.run(ctx).checks.filter((check) => check.name === "robots-txt-crawl-delay");
}

describe("crawl/robots-txt crawl delay", () => {
  test("warns for a 10-second wildcard delay and states the daily cap", () => {
    const checks = run(`
User-agent: *
Crawl-delay: 10
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "warn",
      message: "Crawl-delay 10s slows Bing crawling for User-agent: *",
      items: [{ id: "*", label: "User-agent: *; Crawl-delay: 10" }],
    });
    expect(checks[0]?.value).toContain("8,640 URLs/day");
    expect(checks[0]?.value).toContain("Google ignores Crawl-delay");
  });

  test("explains Google and Bing behavior for a slow Bing-specific group", () => {
    const checks = run(`
User-agent: BingBot
Crawl-delay: 12
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "warn",
      message: "Crawl-delay 12s slows Bing crawling for User-agent: BingBot",
    });
    expect(checks[0]?.value).toContain("Google ignores Crawl-delay");
    expect(checks[0]?.value).toContain("Bing obeys it");
    expect(checks[0]?.value).toContain("7,200 URLs/day");
  });

  test("reports a short wildcard delay as information", () => {
    const checks = run(`
User-agent: *
Crawl-delay: 2
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "info",
      message: "Crawl-delay 2s applies to User-agent: *",
    });
  });

  test("does not report a delay limited to a non-search bot", () => {
    expect(
      run(`
User-agent: AhrefsBot
Crawl-delay: 10
`),
    ).toEqual([]);
  });

  test("reports a search crawler in a stacked user-agent group", () => {
    const checks = run(`
User-agent: BingBot
User-agent: AhrefsBot
Crawl-delay: 10
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "warn",
      message: "Crawl-delay 10s slows Bing crawling for User-agent: BingBot",
    });
  });

  test("ignores a zero crawl delay", () => {
    expect(
      run(`
User-agent: *
Crawl-delay: 0
`),
    ).toEqual([]);
  });

  test("adds no finding when robots.txt has no crawl delay", () => {
    expect(
      run(`
User-agent: *
Disallow: /private/
`),
    ).toEqual([]);
  });
});
