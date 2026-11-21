// crawl/sitemap-lastmod-churn — lastmod values all collapsed onto one build date

import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { sitemapLastmodChurnRule } from "../src/crawl/sitemap-lastmod-churn";

function urlsWithLastmod(
  count: number,
  lastmods: (string | undefined)[]
): { loc: string; lastmod?: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    loc: `https://example.com/p${i}`,
    lastmod: lastmods[i % lastmods.length],
  }));
}

function ctx(urls: { loc: string; lastmod?: string }[]): RuleContext {
  return {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
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
  maps: {
    url: string;
    urls: { loc: string; lastmod?: string }[];
    news?: boolean;
  }[]
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
  test("no sitemap → skipped", async () => {
    const site = ctx([]).site;
    const { checks } = await sitemapLastmodChurnRule.run({
      page: {
        url: "https://example.com/",
        html: "",
        statusCode: 200,
        loadTime: 0,
        headers: {},
      },
      parsed: {} as ParsedPage,
      site: { ...site, sitemaps: null },
      options: {},
    } as unknown as RuleContext);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("fewer than 20 URLs with lastmod → skipped, not pass", async () => {
    const urls = urlsWithLastmod(10, ["2024-01-01"]);
    const { checks } = await sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.message).toContain("too small");
  });

  test("44 URLs all on one build date → warn, names date and counts", async () => {
    const urls = urlsWithLastmod(44, ["2024-06-01T10:00:00Z"]);
    const { checks } = await sitemapLastmodChurnRule.run(ctx(urls));
    const check = checks[0];
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("44");
    expect(check?.message).toContain("1 distinct day");
    expect(check?.message).toContain("2024-06-01");
  });

  test(">=20 URLs but only 3 distinct days → does not warn", async () => {
    const urls = urlsWithLastmod(30, [
      "2024-01-01",
      "2024-02-01",
      "2024-03-01",
    ]);
    const { checks } = await sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("pass");
  });

  test("lastmod spread across many days → pass", async () => {
    const lastmods = Array.from(
      { length: 25 },
      (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`
    );
    const urls = urlsWithLastmod(25, lastmods);
    const { checks } = await sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("pass");
  });

  test("no lastmod on any URL → skipped, not warn", async () => {
    const urls = Array.from({ length: 44 }, (_, i) => ({
      loc: `https://example.com/p${i}`,
    }));
    const { checks } = await sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.status).not.toBe("warn");
  });

  test("6-page brochure site with only 6 lastmod URLs → skipped (below floor), not warn", async () => {
    const urls = urlsWithLastmod(6, ["2024-06-01"]);
    const { checks } = await sitemapLastmodChurnRule.run(ctx(urls));
    expect(checks[0]?.status).toBe("skipped");
  });

  /**
   * News sitemaps hold ~48 hours of articles by specification, so their lastmod values ALWAYS collapse
   * onto one or two days. Counting them accused every publisher that has one of stamping lastmod at
   * build time — found in pre-release smoke on a live recipe site whose regular sitemap children were
   * bot-blocked, leaving its Google News sitemap as the entire sample: 38 URLs, 2 distinct days, warn.
   */
  describe("news sitemaps", () => {
    test("news-only sample → skipped naming the reason, never warn (the allrecipes.com shape)", async () => {
      const { checks } = await sitemapLastmodChurnRule.run(
        multi([
          // The regular sitemap is present but yielded nothing: its children were unreachable.
          { url: "https://example.com/sitemap.xml", urls: [] },
          {
            url: "https://example.com/google-news-sitemap.xml",
            news: true,
            urls: urlsWithLastmod(38, [
              "2026-08-18T04:00:00Z",
              "2026-08-19T04:00:00Z",
            ]),
          },
        ])
      );
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.status).not.toBe("warn");
      expect(checks[0]?.message).toContain("news");
      expect(checks[0]?.details?.newsUrlsExcluded).toBe(38);
    });

    test("news URLs are excluded from the count, so a well-spread regular sitemap still passes", async () => {
      const spread = Array.from(
        { length: 25 },
        (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`
      );
      const { checks } = await sitemapLastmodChurnRule.run(
        multi([
          {
            url: "https://example.com/sitemap.xml",
            urls: urlsWithLastmod(25, spread),
          },
          {
            url: "https://example.com/news.xml",
            news: true,
            urls: urlsWithLastmod(38, [
              "2026-08-18T04:00:00Z",
              "2026-08-19T04:00:00Z",
            ]),
          },
        ])
      );
      expect(checks[0]?.status).toBe("pass");
      // The pooled count must be the regular sitemap's 25, NOT 63 — the news URLs are not merely
      // out-voted, they are absent.
      expect(checks[0]?.details?.urlsWithLastmod).toBe(25);
      expect(checks[0]?.details?.newsUrlsExcluded).toBe(38);
    });

    test("a genuinely build-stamped regular sitemap still warns alongside a news sitemap", async () => {
      const { checks } = await sitemapLastmodChurnRule.run(
        multi([
          {
            url: "https://example.com/sitemap.xml",
            urls: urlsWithLastmod(40, ["2024-06-01T10:00:00Z"]),
          },
          {
            url: "https://example.com/news.xml",
            news: true,
            urls: urlsWithLastmod(38, ["2026-08-18T04:00:00Z"]),
          },
        ])
      );
      expect(checks[0]?.status).toBe("warn");
      expect(checks[0]?.message).toContain("40");
      expect(checks[0]?.message).toContain("2024-06-01");
      // The finding names its source, so "which sitemap stamps at build time" is answered.
      expect(checks[0]?.message).toContain("https://example.com/sitemap.xml");
      expect(checks[0]?.message).not.toContain("news.xml");
    });
  });

  describe("boundaries and bucketing (#1668)", () => {
    const run = async (c: RuleContext) =>
      (await sitemapLastmodChurnRule.run(c)).checks[0]!;

    test("19 URLs with lastmod on one day → skipped", async () => {
      expect((await run(ctx(urlsWithLastmod(19, ["2024-06-01"])))).status).toBe(
        "skipped"
      );
    });

    test("20 URLs with lastmod on one day → judged (warn)", async () => {
      expect((await run(ctx(urlsWithLastmod(20, ["2024-06-01"])))).status).toBe(
        "warn"
      );
    });

    test("20 URLs on exactly 2 distinct days → warn", async () => {
      const check = await run(
        ctx(urlsWithLastmod(20, ["2024-06-01", "2024-06-02"]))
      );
      expect(check.status).toBe("warn");
      expect(check.details?.distinctDays).toBe(2);
    });

    test("20 URLs on exactly 3 distinct days → pass", async () => {
      const check = await run(
        ctx(urlsWithLastmod(20, ["2024-06-01", "2024-06-02", "2024-06-03"]))
      );
      expect(check.status).toBe("pass");
      expect(check.details?.distinctDays).toBe(3);
    });

    test("500 URLs with no lastmod → skip says the sitemap omits lastmod, not 'too small'", async () => {
      const urls = Array.from({ length: 500 }, (_, i) => ({
        loc: `https://example.com/p${i}`,
      }));
      const check = await run(ctx(urls));
      expect(check.status).toBe("skipped");
      expect(check.message).toContain("omits lastmod");
      expect(check.message).toContain("500");
      expect(check.message).not.toContain("too small");
      expect(check.skipReason).toBe("Sitemap omits lastmod");
    });

    test("19 URLs with no lastmod → still the 'too small' message", async () => {
      const urls = Array.from({ length: 19 }, (_, i) => ({
        loc: `https://example.com/p${i}`,
      }));
      const check = await run(ctx(urls));
      expect(check.status).toBe("skipped");
      expect(check.message).toContain("too small");
    });

    test("offset collapse: three local days that are two UTC days stay three days → pass-count 3", async () => {
      const lastmods = [
        "2024-06-01T23:30:00+00:00",
        "2024-06-02T00:30:00+02:00",
        "2024-06-03T01:00:00+03:00",
      ];
      const check = await run(ctx(urlsWithLastmod(30, lastmods)));
      expect(check.status).toBe("pass");
      expect(check.details?.distinctDays).toBe(3);
    });

    test("offset split: one local build day with wide offsets stays one day → warn", async () => {
      const lastmods = [
        "2024-06-01T00:30:00+14:00",
        "2024-06-01T12:00:00+00:00",
        "2024-06-01T23:30:00-12:00",
      ];
      const check = await run(ctx(urlsWithLastmod(30, lastmods)));
      expect(check.status).toBe("warn");
      expect(check.details?.distinctDays).toBe(1);
      expect(check.details?.dates).toEqual(["2024-06-01"]);
    });

    test("one details key for the excluded news count on every branch", async () => {
      const news = Array.from({ length: 5 }, (_, i) => ({
        loc: `https://example.com/n${i}`,
        lastmod: "2024-06-01",
      }));
      const regular = (n: number, lastmods: string[]) =>
        urlsWithLastmod(n, lastmods);
      const skip = await run(
        multi([{ url: "https://example.com/n.xml", urls: news, news: true }])
      );
      const warn = await run(
        multi([
          { url: "https://example.com/n.xml", urls: news, news: true },
          {
            url: "https://example.com/s.xml",
            urls: regular(20, ["2024-06-01"]),
          },
        ])
      );
      const pass = await run(
        multi([
          { url: "https://example.com/n.xml", urls: news, news: true },
          {
            url: "https://example.com/s.xml",
            urls: regular(20, ["2024-06-01", "2024-06-02", "2024-06-03"]),
          },
        ])
      );
      for (const c of [skip, warn, pass]) {
        expect(c.details?.newsUrlsExcluded).toBe(5);
        expect(c.details).not.toHaveProperty("newsUrlsWithLastmod");
      }
      expect([skip.status, warn.status, pass.status]).toEqual([
        "skipped",
        "warn",
        "pass",
      ]);
    });

    test("isNewsSitemap undefined (pre-migration-21 row) fails open: treated as a regular sitemap and warns", async () => {
      const urls = urlsWithLastmod(38, ["2024-06-01", "2024-06-02"]);
      const check = await run(ctx(urls)); // ctx() leaves isNewsSitemap unset
      expect(check.status).toBe("warn");
    });
  });
});
