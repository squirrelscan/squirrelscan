// #758: the W3C Datetime format sitemaps use allows `YYYY` and `YYYY-MM`, which
// name a whole year or month. The lastmod rules read them as the first
// instant of that period, so a year-stamped sitemap looked months behind every
// page dated later that year, and churn reported a day nobody wrote.

import { describe, expect, test } from "bun:test";

import { w3cDatePeriod } from "@squirrelscan/utils/date-period";

import { sitemapLastmodChurnRule } from "../src/crawl/sitemap-lastmod-churn";
import { sitemapLastmodDriftRule } from "../src/crawl/sitemap-lastmod-drift";
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
  test("a year and a year-month are the whole period, in UTC; a datetime is an instant", () => {
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
      day: "2024-09-10",
    });
    // December rolls into the next year; a leap February ends on the 29th.
    expect(w3cDatePeriod("2024-12")?.end).toBe(Date.UTC(2025, 0, 1) - 1);
    expect(w3cDatePeriod("2024-02")?.end).toBe(Date.UTC(2024, 1, 29, 23, 59, 59, 999));
    // Years below 100 are not read as 19xx.
    const early = w3cDatePeriod("0099")!;
    expect(new Date(early.start).getUTCFullYear()).toBe(99);
    expect(early.end).toBeGreaterThan(early.start);
    expect(w3cDatePeriod("2024-00")).toBeNull();
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
      expect(checks[0]!.skipReason).toBe("Lastmod values name only a year or month");
      expect(checks[0]!.details).toMatchObject({ coarseLastmods: 30, urlsWithLastmod: 0 });
    }
  });

  test("too few lastmods in all is still too small, not too coarse", () => {
    const { checks } = sitemapLastmodChurnRule.run(
      siteWith([], [...urls(() => "2024-09-10T04:00:00Z", 3), ...urls(() => "2024", 2)]),
    );
    expect(checks[0]!.skipReason).toBe("Too few URLs with lastmod");
  });

  test("a news sitemap's year-month lastmods are counted as news, as before", () => {
    const context = siteWith(
      [],
      urls(() => "2024-09"),
    );
    (context.site!.sitemaps!.discovered[0] as { isNewsSitemap?: boolean }).isNewsSitemap = true;
    const { checks } = sitemapLastmodChurnRule.run(context);
    expect(checks[0]!.skipReason).toBe("Only news-sitemap lastmod values");
    expect(checks[0]!.details).toMatchObject({ newsUrlsWithLastmod: 30, coarseLastmods: 0 });
  });

  test("a few coarse lastmods beside a news sitemap count as lastmods in the too-small message", () => {
    const context = siteWith(
      [],
      urls(() => "2024-09", 5),
    );
    const discovered = context.site!.sitemaps!.discovered;
    discovered.push({
      ...discovered[0]!,
      url: "https://example.com/news-sitemap.xml",
      urls: urls(() => "2024-09-10T04:00:00Z", 30).map((u) => ({ ...u, loc: `${u.loc}-news` })),
      isNewsSitemap: true,
    } as (typeof discovered)[number]);
    const { checks } = sitemapLastmodChurnRule.run(context);
    expect(checks[0]!.skipReason).toBe("Too few URLs with lastmod");
    expect(checks[0]!.message).toBe(
      "Only 5 sitemap URL(s) carry a lastmod; sitemap is too small to judge lastmod churn",
    );
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

describe("crawl/sitemap-lastmod-drift: the page's date and a date-only lastmod are periods too (#772)", () => {
  test("a page dated with a bare year agrees with a lastmod inside it", () => {
    // Read as 1 January, `2024` warned 253 days ahead of `2024-09-10`.
    expect(drift("2024-09-10", "2024").map((c) => c.status)).toEqual(["pass"]);
    // Measured from the end of the page's year: 19 days ahead passes, 32 warns.
    expect(drift("2025-01-20", "2024").map((c) => c.status)).toEqual(["pass"]);
    expect(drift("2025-02-02", "2024")[0]!.name).toBe("sitemap-lastmod-ahead-of-page");
  });

  test("a date-only lastmod and a month lastmod agree about the same page", () => {
    // Against 2025-01-08T12:00Z, `2024-12-31` was 8 days behind and warned,
    // while `2024-12` was 7 and passed.
    expect(drift("2024-12-31", "2025-01-08T12:00:00Z").map((c) => c.status)).toEqual(["pass"]);
    expect(drift("2024-12", "2025-01-08T12:00:00Z").map((c) => c.status)).toEqual(["pass"]);
    const late = drift("2024-12-31", "2025-01-10T12:00:00Z");
    expect(late[0]!.name).toBe("sitemap-lastmod-behind-page");
    expect(late[0]!.items![0]!.meta).toMatchObject({ deltaDays: 9 });
  });

  test("a lastmod outside the W3C format with no zone is not compared, on any machine", () => {
    const prior = process.env.TZ;
    try {
      for (const zone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
        process.env.TZ = zone;
        for (const lastmod of ["2024/09/10", "2024-9", "2024-09-1"]) {
          expect(drift(lastmod, "2024-09-10T12:00:00Z")[0]!.skipReason).toBe("No comparable dates");
        }
      }
    } finally {
      if (prior === undefined) delete process.env.TZ;
      else process.env.TZ = prior;
    }
  });
});

describe("crawl/sitemap-lastmod-churn counts the day the sitemap wrote (#772)", () => {
  test("an offset datetime late in the evening is its own day, not the UTC one", () => {
    const urls = Array.from({ length: 30 }, (_, i) => ({
      loc: `https://example.com/p${i}`,
      lastmod: "2024-09-10T23:30:00-05:00",
    }));
    const { checks } = sitemapLastmodChurnRule.run(siteWith([], urls));
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks[0]!.details).toMatchObject({ dates: ["2024-09-10"] });
  });
});
