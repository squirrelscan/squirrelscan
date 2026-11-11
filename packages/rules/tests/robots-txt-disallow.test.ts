import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import { robotsTxtRule } from "../src/crawl/robots-txt";
import type { ParsedPage, RuleContext } from "../src/types";
import { expectDeclaredChecks } from "./helpers/declared-checks";

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
  const checks = robotsTxtRule.run(ctx).checks;
  expectDeclaredChecks(robotsTxtRule, checks);
  return checks.filter((check) => check.name.startsWith("robots-txt-disallow"));
}

describe("crawl/robots-txt Disallow: /", () => {
  test("a wildcard-only block fails robots-txt-disallow", () => {
    const checks = run(`
User-agent: *
Disallow: /
`);

    expect(checks).toEqual([
      {
        name: "robots-txt-disallow",
        status: "fail",
        message: "robots.txt blocks all crawling",
        value: "Disallow: / with no Allow rules",
      },
    ]);
  });

  test("a wildcard block with a Googlebot group that allows / warns and names Googlebot", () => {
    const checks = run(`
User-agent: *
Disallow: /

User-agent: Googlebot
Allow: /
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "robots-txt-disallow-wildcard",
      status: "warn",
      message: "robots.txt blocks crawlers without a group of their own",
      value: "User-agent: * has Disallow: /; still allowed: Googlebot",
      items: [{ id: "Googlebot", label: "User-agent: Googlebot may crawl /" }],
    });
  });

  test("a named group that does not disallow / re-allows the site, matched without case", () => {
    const checks = run(`
User-agent: *
Disallow: /

User-agent: bingbot
Disallow: /private/

User-agent: GOOGLEBOT
Disallow:
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "robots-txt-disallow-wildcard",
      value: "User-agent: * has Disallow: /; still allowed: Googlebot, Bingbot",
    });
  });

  test("a wildcard block with a named Disallow for another bot still blocks all crawling", () => {
    const checks = run(`
User-agent: *
Disallow: /

User-agent: Googlebot
Disallow: /

User-agent: SomeOtherBot
Allow: /
`);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "robots-txt-disallow", status: "fail" });
  });

  test("a site that is not blocked passes robots-txt-disallow", () => {
    const checks = run(`
User-agent: *
Disallow: /admin/
`);

    expect(checks).toEqual([
      { name: "robots-txt-disallow", status: "pass", message: "robots.txt does not block all crawling" },
    ]);
  });
});
