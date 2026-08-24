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

/** Several discovered sitemaps, each optionally flagged as a Google News sitemap. */
function multi(
  maps: { url: string; urls: { loc: string; lastmod?: string }[]; news?: boolean }[],
): RuleContext {
  const base = ctx([]);
  const total = maps.reduce((n, m) => n + m.urls.length, 0);
  return {
    ...base,
    site: {
      ...base.site,
      sitemaps: {
        discovered: maps.map((m) => ({
          url: m.url,
          type: "urlset",
          urls: m.urls,
          childSitemaps: [],
          errors: [],
          urlCount: m.urls.length,
          isNewsSitemap: m.news ?? false,
        })),
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls: total,
        orphanPages: [],
        missingPages: [],
        failed: [],
      },
    },
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

  /**
   * News sitemaps hold ~48 hours of articles by specification, so their lastmod values ALWAYS collapse
   * onto one or two days. Counting them accused every publisher that has one of stamping lastmod at
   * build time — found in pre-release smoke on a live recipe site whose regular sitemap children were
   * bot-blocked, leaving its Google News sitemap as the entire sample: 38 URLs, 2 distinct days, warn.
   */
  describe("news sitemaps", () => {
    test("news-only sample → skipped naming the reason, never warn (the allrecipes.com shape)", () => {
      const { checks } = sitemapLastmodChurnRule.run(
        multi([
          // The regular sitemap is present but yielded nothing: its children were unreachable.
          { url: "https://example.com/sitemap.xml", urls: [] },
          {
            url: "https://example.com/google-news-sitemap.xml",
            news: true,
            urls: urlsWithLastmod(38, ["2026-08-18T04:00:00Z", "2026-08-19T04:00:00Z"]),
          },
        ]),
      );
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.status).not.toBe("warn");
      expect(checks[0]?.message).toContain("news");
      expect(checks[0]?.details?.newsUrlsWithLastmod).toBe(38);
    });

    test("news URLs are excluded from the count, so a well-spread regular sitemap still passes", () => {
      const spread = Array.from({ length: 25 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`);
      const { checks } = sitemapLastmodChurnRule.run(
        multi([
          { url: "https://example.com/sitemap.xml", urls: urlsWithLastmod(25, spread) },
          {
            url: "https://example.com/news.xml",
            news: true,
            urls: urlsWithLastmod(38, ["2026-08-18T04:00:00Z", "2026-08-19T04:00:00Z"]),
          },
        ]),
      );
      expect(checks[0]?.status).toBe("pass");
      // The pooled count must be the regular sitemap's 25, NOT 63 — the news URLs are not merely
      // out-voted, they are absent.
      expect(checks[0]?.details?.urlsWithLastmod).toBe(25);
      expect(checks[0]?.details?.newsUrlsExcluded).toBe(38);
    });

    test("a genuinely build-stamped regular sitemap still warns alongside a news sitemap", () => {
      const { checks } = sitemapLastmodChurnRule.run(
        multi([
          { url: "https://example.com/sitemap.xml", urls: urlsWithLastmod(40, ["2024-06-01T10:00:00Z"]) },
          {
            url: "https://example.com/news.xml",
            news: true,
            urls: urlsWithLastmod(38, ["2026-08-18T04:00:00Z"]),
          },
        ]),
      );
      expect(checks[0]?.status).toBe("warn");
      expect(checks[0]?.message).toContain("40");
      expect(checks[0]?.message).toContain("2024-06-01");
      // The finding names its source, so "which sitemap stamps at build time" is answered.
      expect(checks[0]?.message).toContain("https://example.com/sitemap.xml");
      expect(checks[0]?.message).not.toContain("news.xml");
    });
  });
});
