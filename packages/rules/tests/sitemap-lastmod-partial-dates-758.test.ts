// #758: the W3C Datetime format sitemaps use allows `YYYY` and `YYYY-MM`, which
// name a whole year or month. The lastmod rules read them as the first
// instant of that period, so a year-stamped sitemap looked months behind every
// page dated later that year, and churn reported a day nobody wrote.

import { describe, expect, test } from "bun:test";

import { sitemapLastmodChurnRule } from "../src/crawl/sitemap-lastmod-churn";
import { sitemapLastmodDriftRule } from "../src/crawl/sitemap-lastmod-drift";
import { w3cDatePeriod } from "../src/shared/w3c-date-period";
import type { ParsedPage, RuleContext } from "../src/types";

function siteWith(
  pages: Array<{ url: string; dateModified?: string }>,
  urls: Array<{ loc: string; lastmod?: string }>,
): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: pages.map((p) => ({
        url: p.url,
        statusCode: 200,
        parsed: {
          schema: {
            types: [],
            valid: true,
            errors: [],
            raw: p.dateModified
              ? JSON.stringify({
                  "@context": "https://schema.org",
                  "@type": "BlogPosting",
                  dateModified: p.dateModified,
                })
              : null,
          },
          visibleDateModified: null,
          visibleDatePublished: null,
        } as unknown as ParsedPage,
      })),
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

function drift(lastmod: string, dateModified: string) {
  return sitemapLastmodDriftRule.run(
    siteWith(
      [{ url: "https://example.com/a", dateModified }],
      [{ loc: "https://example.com/a", lastmod }],
    ),
  ).checks;
}

describe("w3cDatePeriod", () => {
  test("a year and a year-month are the whole period, in UTC; anything finer is an instant", () => {
    expect(w3cDatePeriod("2024")).toEqual({
      start: Date.UTC(2024, 0, 1),
      end: Date.UTC(2025, 0, 1) - 1,
      precision: "year",
    });
    expect(w3cDatePeriod("2024-02")).toEqual({
      start: Date.UTC(2024, 1, 1),
      end: Date.UTC(2024, 2, 1) - 1,
      precision: "month",
    });
    const instant = Date.parse("2024-09-10T08:00:00Z");
    expect(w3cDatePeriod("2024-09-10T08:00:00Z")).toEqual({
      start: instant,
      end: instant,
      precision: "instant",
    });
    expect(w3cDatePeriod("2024-13")).toBeNull();
    expect(w3cDatePeriod("not a date")).toBeNull();
  });
});

describe("crawl/sitemap-lastmod-drift with a year or year-month lastmod (#758)", () => {
  test("a page date inside the named year or month agrees with it", () => {
    expect(drift("2024", "2024-09-10T00:00:00Z").map((c) => c.status)).toEqual(["pass"]);
    expect(drift("2024-09", "2024-09-28T00:00:00Z").map((c) => c.status)).toEqual(["pass"]);
  });

  test("a page date after the period is behind, measured from the period's end", () => {
    const [year] = drift("2023", "2024-09-10T00:00:00Z");
    expect(year).toMatchObject({ status: "warn", name: "sitemap-lastmod-behind-page" });
    // From 2023-12-31T23:59:59.999Z: 253 days, not the 618 from 2023-01-01.
    expect(year!.items?.[0]?.meta).toMatchObject({ lastmod: "2023", deltaDays: 253 });

    const [month] = drift("2024-09", "2024-10-15T00:00:00Z");
    expect(month).toMatchObject({ status: "warn", name: "sitemap-lastmod-behind-page" });
    expect(month!.items?.[0]?.meta).toMatchObject({ deltaDays: 14 });
  });

  test("a page date before the period is ahead, measured from the period's start", () => {
    const [check] = drift("2025", "2024-09-10T00:00:00Z");
    expect(check).toMatchObject({ status: "warn", name: "sitemap-lastmod-ahead-of-page" });
    expect(check!.items?.[0]?.meta).toMatchObject({ deltaDays: 113 });
  });

  test("a full datetime is still one instant", () => {
    const [check] = drift("2024-09-01T00:00:00Z", "2024-09-20T00:00:00Z");
    expect(check).toMatchObject({ status: "warn", name: "sitemap-lastmod-behind-page" });
    expect(check!.items?.[0]?.meta).toMatchObject({ deltaDays: 19 });
  });
});

describe("crawl/sitemap-lastmod-churn with a year or year-month lastmod (#758)", () => {
  const urls = (lastmod: (i: number) => string, count = 30) =>
    Array.from({ length: count }, (_, i) => ({
      loc: `https://example.com/p${i}`,
      lastmod: lastmod(i),
    }));

  test("a sitemap stamped with a bare year or year-month is not reported as churn on a day it never wrote", () => {
    for (const stamp of ["2024", "2024-09"]) {
      const { checks } = sitemapLastmodChurnRule.run(
        siteWith(
          [],
          urls(() => stamp),
        ),
      );
      expect(checks.map((c) => c.status)).toEqual(["skipped"]);
      expect(checks[0]!.message).not.toContain("2024-01-01");
      expect(checks[0]!.message).not.toContain("2024-09-01");
      expect(checks[0]!.skipReason).toBe("Lastmod values name only a year or month");
      expect(checks[0]!.details).toMatchObject({ coarseLastmods: 30, urlsWithLastmod: 0 });
    }
  });

  test("full datetimes still count, with the coarse ones left out of the sample", () => {
    const { checks } = sitemapLastmodChurnRule.run(
      siteWith([], [...urls(() => "2024-09-10T04:00:00Z"), ...urls(() => "2024", 5)]),
    );
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks[0]!.message).toContain("2024-09-10");
    expect(checks[0]!.message).not.toContain("2024-01-01");
    expect(checks[0]!.details).toMatchObject({ urlsWithLastmod: 30, coarseLastmodsExcluded: 5 });
  });
});
