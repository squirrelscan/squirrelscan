// crawl/sitemap-lastmod-churn — lastmod values all collapsed onto one build date

import { describe, expect, test } from "bun:test";

import { sitemapLastmodChurnRule } from "../src/crawl/sitemap-lastmod-churn";
import type { ParsedPage, RuleContext } from "../src/types";

function urlsWithLastmod(count: number, lastmods: (string | undefined)[]): { loc: string; lastmod?: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    loc: `https://example.com/p${i}`,
    lastmod: lastmods[i % lastmods.length],
  }));
}

function ctx(urls: { loc: string; lastmod?: string }[]): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: {
        discovered: [
          {
            url: "https://example.com/sitemap.xml",
            type: "urlset",
            urls,
            childSitemaps: [],
            errors: [],
            urlCount: urls.length,
          },
        ],
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls: urls.length,
        orphanPages: [],
        missingPages: [],
        failed: [],
      },
    },
    options: {},
  } as unknown as RuleContext;
}

describe("crawl/sitemap-lastmod-churn", () => {
  test("no sitemap → skipped", () => {
    const site = ctx([]).site;
    const { checks } = sitemapLastmodChurnRule.run({
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: { ...site, sitemaps: null },
      options: {},
    } as unknown as RuleContext);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("fewer than 20 URLs with lastmod → skipped, not pass", () => {
    const urls = urlsWithLastmod(10, ["2024-01-01"]);
    const { checks } = sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.message).toContain("too small");
  });

  test("44 URLs all on one build date → warn, names date and counts", () => {
    const urls = urlsWithLastmod(44, ["2024-06-01T10:00:00Z"]);
    const { checks } = sitemapLastmodChurnRule.run(ctx(urls));
    const check = checks[0];
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("44");
    expect(check?.message).toContain("1 distinct day");
    expect(check?.message).toContain("2024-06-01");
  });

  test(">=20 URLs but only 3 distinct days → does not warn", () => {
    const urls = urlsWithLastmod(30, ["2024-01-01", "2024-02-01", "2024-03-01"]);
    const { checks } = sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("pass");
  });

  test("lastmod spread across many days → pass", () => {
    const lastmods = Array.from({ length: 25 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`);
    const urls = urlsWithLastmod(25, lastmods);
    const { checks } = sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("pass");
  });

  test("no lastmod on any URL → skipped, not warn", () => {
    const urls = Array.from({ length: 44 }, (_, i) => ({ loc: `https://example.com/p${i}` }));
    const { checks } = sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.status).not.toBe("warn");
  });

  test("6-page brochure site with only 6 lastmod URLs → skipped (below floor), not warn", () => {
    const urls = urlsWithLastmod(6, ["2024-06-01"]);
    const { checks } = sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("skipped");
  });
});
