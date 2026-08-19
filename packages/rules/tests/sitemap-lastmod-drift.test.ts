// crawl/sitemap-lastmod-drift — sitemap lastmod vs the page's own dateModified

import { describe, expect, test } from "bun:test";

import { sitemapLastmodDriftRule } from "../src/crawl/sitemap-lastmod-drift";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const MS_PER_DAY = 86_400_000;

/** `base` shifted by whole days — keeps expected deltas exact without hand arithmetic. */
function plusDays(base: string, days: number): string {
  return new Date(new Date(base).getTime() + days * MS_PER_DAY).toISOString();
}

interface PageSpec {
  url: string;
  schemaDateModified?: string;
  visibleDateModified?: string;
  visibleDatePublished?: string;
}

function parsed(spec: PageSpec): ParsedPage {
  return {
    schema: {
      types: [],
      valid: true,
      errors: [],
      raw: spec.schemaDateModified
        ? JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            dateModified: spec.schemaDateModified,
          })
        : null,
    },
    visibleDateModified: spec.visibleDateModified ?? null,
    visibleDatePublished: spec.visibleDatePublished ?? null,
  } as unknown as ParsedPage;
}

function site(pages: PageSpec[], sitemapUrls: { loc: string; lastmod?: string }[]): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: pages.map((spec) => ({
      url: spec.url,
      statusCode: 200,
      parsed: parsed(spec),
    })),
    robotsTxt: null,
    sitemaps: {
      discovered: [
        {
          url: "https://example.com/sitemap.xml",
          type: "urlset",
          urls: sitemapUrls,
          childSitemaps: [],
          errors: [],
          urlCount: sitemapUrls.length,
        },
      ],
      sources: { robotsTxt: [], commonLocations: [] },
      totalUrls: sitemapUrls.length,
      orphanPages: [],
      missingPages: [],
      failed: [],
    },
  } as unknown as SiteData;
}

function ctx(
  pages: PageSpec[],
  sitemapUrls: { loc: string; lastmod?: string }[],
  options: Record<string, unknown> = {}
): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: site(pages, sitemapUrls),
    options,
  } as unknown as RuleContext;
}

describe("crawl/sitemap-lastmod-drift", () => {
  test("no sitemap → skipped", () => {
    const base = ctx([{ url: "https://example.com/a" }], []);
    const { checks } = sitemapLastmodDriftRule.run({
      ...base,
      site: { ...base.site!, sitemaps: null },
    } as RuleContext) as { checks: { status: string }[] };
    expect(checks[0]?.status).toBe("skipped");
  });

  test("no pages → skipped", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx([], [{ loc: "https://example.com/a", lastmod: "2024-01-01" }])
    ) as { checks: { status: string }[] };
    expect(checks[0]?.status).toBe("skipped");
  });

  test("page with no date signal at all → skipped, not warned (content/freshness territory)", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx([{ url: "https://example.com/a" }], [{ loc: "https://example.com/a", lastmod: "2011-04-02" }])
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe("No comparable dates");
  });

  test("lastmod tracks dateModified per page → pass", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [
          { url: "https://example.com/a", schemaDateModified: "2024-03-01T00:00:00Z" },
          { url: "https://example.com/b", schemaDateModified: "2024-06-14T09:30:00Z" },
          { url: "https://example.com/c", schemaDateModified: "2023-11-02T00:00:00Z" },
        ],
        [
          { loc: "https://example.com/a", lastmod: "2024-03-01" },
          { loc: "https://example.com/b", lastmod: "2024-06-14" },
          { loc: "https://example.com/c", lastmod: "2023-11-02" },
        ]
      )
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.details?.comparedPages).toBe(3);
  });

  test("same-day difference does not warn", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", schemaDateModified: "2024-03-01T22:00:00Z" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-01T06:00:00Z" }]
      )
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("within-threshold difference (20 days ahead, default 30) does not warn", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", schemaDateModified: "2024-03-01T00:00:00Z" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-21" }]
      )
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("build-stamped lastmod years ahead of the page's date → ahead warning with both dates + delta", () => {
    // The personal-blog case from #107: lastmod is the build date, the page
    // renders the post's real 2011 date.
    const pageDate = "2011-04-02T00:00:00.000Z";
    const lastmod = plusDays(pageDate, 5589);
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/post", schemaDateModified: pageDate }],
        [{ loc: "https://example.com/post", lastmod }]
      )
    );
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.status).toBe("warn");
    expect(check.name).toBe("sitemap-lastmod-ahead-of-page");
    expect(check.message).toContain("newer");
    const item = check.items?.[0];
    expect(item?.id).toBe("https://example.com/post");
    expect(item?.meta).toMatchObject({
      lastmod,
      pageDate,
      pageDateSource: "schema",
      deltaDays: 5589,
    });
  });

  test("inverted date precedence (lastmod 433 days behind) → behind warning, distinct check name", () => {
    // The consultancy case from #107: the generator resolved
    // `publishedAt ?? updatedAt` while the page rendered `updatedAt ?? publishedAt`.
    const pageDate = "2025-06-01T00:00:00.000Z";
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/guide", schemaDateModified: pageDate }],
        [{ loc: "https://example.com/guide", lastmod: plusDays(pageDate, -433) }]
      )
    );
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.status).toBe("warn");
    expect(check.name).toBe("sitemap-lastmod-behind-page");
    expect(check.name).not.toBe("sitemap-lastmod-ahead-of-page");
    expect(check.message).toContain("older");
    expect(check.items?.[0]?.meta).toMatchObject({ deltaDays: 433 });
  });

  test("behind by 5 days does not warn; behind by 8 does (7-day floor)", () => {
    const ok = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", schemaDateModified: "2024-03-06T00:00:00Z" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-01" }]
      )
    );
    expect(ok.checks[0]?.status).toBe("pass");

    const warned = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", schemaDateModified: "2024-03-09T00:00:00Z" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-01" }]
      )
    );
    expect(warned.checks[0]?.status).toBe("warn");
    expect(warned.checks[0]?.name).toBe("sitemap-lastmod-behind-page");
  });

  test("both directions on one site → two separate checks", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [
          { url: "https://example.com/old", schemaDateModified: "2012-01-01T00:00:00Z" },
          { url: "https://example.com/revised", schemaDateModified: "2025-06-01T00:00:00Z" },
        ],
        [
          { loc: "https://example.com/old", lastmod: "2026-08-01" },
          { loc: "https://example.com/revised", lastmod: "2024-03-25" },
        ]
      )
    );
    expect(checks.map((c) => c.name).sort()).toEqual([
      "sitemap-lastmod-ahead-of-page",
      "sitemap-lastmod-behind-page",
    ]);
    expect(checks.every((c) => c.status === "warn")).toBe(true);
  });

  test("ahead threshold is configurable", () => {
    const pages: PageSpec[] = [{ url: "https://example.com/a", schemaDateModified: "2024-03-01T00:00:00Z" }];
    const urls = [{ loc: "https://example.com/a", lastmod: "2024-03-21" }];
    expect(sitemapLastmodDriftRule.run(ctx(pages, urls)).checks[0]?.status).toBe("pass");
    const tightened = sitemapLastmodDriftRule.run(ctx(pages, urls, { ahead_days: 10 }));
    expect(tightened.checks[0]?.status).toBe("warn");
    expect(tightened.checks[0]?.name).toBe("sitemap-lastmod-ahead-of-page");
  });

  test("falls back to the dateModified-equivalent meta, then the visible date", () => {
    const viaMeta = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", visibleDateModified: "2025-06-01" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-25" }]
      )
    );
    expect(viaMeta.checks[0]?.items?.[0]?.meta?.pageDateSource).toBe("meta");

    const viaVisible = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", visibleDatePublished: "2025-06-01" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-25" }]
      )
    );
    expect(viaVisible.checks[0]?.items?.[0]?.meta?.pageDateSource).toBe("visible");
  });

  test("schema dateModified wins over the weaker signals", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [
          {
            url: "https://example.com/a",
            schemaDateModified: "2024-03-01T00:00:00Z",
            visibleDateModified: "2025-06-01",
            visibleDatePublished: "2011-04-02",
          },
        ],
        [{ loc: "https://example.com/a", lastmod: "2024-03-01" }]
      )
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("unparseable dates on either side are ignored, not warned", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [
          { url: "https://example.com/a", schemaDateModified: "last tuesday" },
          { url: "https://example.com/b", schemaDateModified: "2024-03-01T00:00:00Z" },
        ],
        [
          { loc: "https://example.com/a", lastmod: "2024-03-01" },
          { loc: "https://example.com/b", lastmod: "not-a-date" },
        ]
      )
    );
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe("No comparable dates");
  });

  test("pages absent from the sitemap are ignored", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [
          { url: "https://example.com/a", schemaDateModified: "2011-04-02T00:00:00Z" },
          { url: "https://example.com/b", schemaDateModified: "2024-03-01T00:00:00Z" },
        ],
        [{ loc: "https://example.com/b", lastmod: "2024-03-01" }]
      )
    );
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.details?.comparedPages).toBe(1);
  });

  test("worst drift is reported first", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [
          { url: "https://example.com/a", schemaDateModified: "2024-06-01T00:00:00Z" },
          { url: "https://example.com/b", schemaDateModified: "2011-04-02T00:00:00Z" },
        ],
        [
          { loc: "https://example.com/a", lastmod: "2025-01-01" },
          { loc: "https://example.com/b", lastmod: "2026-08-01" },
        ]
      )
    );
    expect(checks[0]?.items?.map((i) => i.id)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
  });

  test("a siteQuery on the context does not change the output (dual-path parity)", () => {
    const base = ctx(
      [{ url: "https://example.com/post", schemaDateModified: "2011-04-02T00:00:00Z" }],
      [{ loc: "https://example.com/post", lastmod: "2026-08-01T00:00:00Z" }]
    );
    const legacy = sitemapLastmodDriftRule.run(base);
    const streaming = sitemapLastmodDriftRule.run({
      ...base,
      // The rule reads only parsed-page scalars, never a DOM — so the streaming
      // site pass (documents dropped, siteQuery threaded) sees identical input.
      siteQuery: { pageCount: () => 1 },
    } as unknown as RuleContext);
    expect(JSON.stringify(streaming)).toBe(JSON.stringify(legacy));
  });
});
