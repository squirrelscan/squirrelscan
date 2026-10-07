// crawl/sitemap-coverage — cap-aware orphan warning (#697). Before this fix,
// a crawl truncated by the coverage profile's page cap (e.g. "quick" capping
// at 10 pages against a 54-URL sitemap) produced the same "N sitemap URL(s)
// were not crawled" warning as a genuine coverage gap. Now the check reads
// `ctx.site.crawlLimits` to tell "budget ran out" from "couldn't reach these
// pages" and downgrades the former to informational, cap-aware messaging.

import { describe, expect, test } from "bun:test";

import { sitemapCoverageRule } from "../src/crawl/sitemap-coverage";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const samplePage = {
  url: "https://example.com/blog",
  statusCode: 200,
  parsed: { meta: {} } as unknown as ParsedPage,
};

function ctx(over: {
  orphanPages: string[];
  crawlLimits?: SiteData["crawlLimits"];
  totalUrls?: number;
}): RuleContext {
  const totalUrls = over.totalUrls ?? over.orphanPages.length + 1;
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [samplePage],
      robotsTxt: null,
      sitemaps: {
        discovered: [
          {
            url: "https://example.com/sitemap.xml",
            type: "urlset",
            urls: [],
            childSitemaps: [],
            errors: [],
            urlCount: totalUrls,
          },
        ],
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls,
        orphanPages: over.orphanPages,
        missingPages: [],
        failed: [],
      },
      crawlLimits: over.crawlLimits,
    },
    options: {},
  } as unknown as RuleContext;
}

describe("crawl/sitemap-coverage cap-aware orphan warning (#697)", () => {
  test("genuine gap (cap NOT hit) still warns", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({
        orphanPages: ["https://example.com/a", "https://example.com/b"],
        crawlLimits: { pagesCrawled: 15, maxPages: 100 },
      }),
    );
    const orphanCheck = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphanCheck?.status).toBe("warn");
    expect(orphanCheck?.message).toContain("were not crawled");
  });

  test("crawl truncated by the coverage profile's page cap → downgraded to info, cap-aware message", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({
        orphanPages: Array.from({ length: 44 }, (_, i) => `https://example.com/p${i}`),
        crawlLimits: { pagesCrawled: 10, maxPages: 10 },
      }),
    );
    const orphanCheck = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphanCheck?.status).toBe("info");
    expect(orphanCheck?.message).toContain("capped at 10 pages");
  });

  test("no crawlLimits threaded (legacy/offline caller) → preserves prior warn behavior", () => {
    const { checks } = sitemapCoverageRule.run(ctx({ orphanPages: ["https://example.com/a"] }));
    const orphanCheck = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphanCheck?.status).toBe("warn");
  });

  test("crawl stopped short of the cap (not truncated) → still warns despite the gap", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({
        orphanPages: ["https://example.com/a"],
        crawlLimits: { pagesCrawled: 8, maxPages: 10 },
      }),
    );
    const orphanCheck = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphanCheck?.status).toBe("warn");
  });

  test("sitemap small enough to fit under the cap → coincidental cap hit still warns (codex)", () => {
    // Crawl happened to stop exactly at maxPages, but the whole sitemap
    // (5 URLs) fits comfortably within that budget — the cap isn't why
    // this URL is missing, so it must NOT be downgraded to info.
    const { checks } = sitemapCoverageRule.run(
      ctx({
        orphanPages: ["https://example.com/a"],
        crawlLimits: { pagesCrawled: 5, maxPages: 5 },
        totalUrls: 5,
      }),
    );
    const orphanCheck = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphanCheck?.status).toBe("warn");
  });

  test("no orphan pages at all → no sitemap-orphans check emitted", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({ orphanPages: [], crawlLimits: { pagesCrawled: 10, maxPages: 10 } }),
    );
    expect(checks.find((c) => c.name === "sitemap-orphans")).toBeUndefined();
  });
});

// pub#488: noindex pages are never listed as missing from the sitemap.
describe("crawl/sitemap-coverage noindex pages (pub#488)", () => {
  const BASE = "https://example.com";
  const SITEMAP_URLS = [`${BASE}/`, `${BASE}/p1.html`];

  interface PageSpec {
    path: string;
    robots?: string;
    headers?: Record<string, string>;
  }

  function noindexCtx(opts: {
    pages: PageSpec[];
    missingPages: string[];
    siteIndexable?: boolean;
  }): RuleContext {
    return {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: {
        baseUrl: BASE,
        pages: opts.pages.map((p) => ({
          url: `${BASE}${p.path}`,
          statusCode: 200,
          parsed: { meta: { robots: p.robots ?? null } } as unknown as ParsedPage,
          headers: p.headers ?? {},
        })),
        robotsTxt: null,
        siteIndexable: opts.siteIndexable,
        sitemaps: {
          discovered: [
            {
              url: `${BASE}/sitemap.xml`,
              type: "urlset",
              urls: SITEMAP_URLS.map((loc) => ({ loc })),
              childSitemaps: [],
              errors: [],
              urlCount: SITEMAP_URLS.length,
            },
          ],
          sources: { robotsTxt: [], commonLocations: [] },
          totalUrls: SITEMAP_URLS.length,
          orphanPages: [],
          missingPages: opts.missingPages,
          failed: [],
        },
      },
      options: {},
    } as unknown as RuleContext;
  }

  const coverage = (ctx: RuleContext) =>
    sitemapCoverageRule.run(ctx).checks.find((c) => c.name === "sitemap-coverage")!;
  const listed = (ctx: RuleContext) => coverage(ctx).items?.map((i) => i.id) ?? [];

  const INDEXED = [
    { path: "/" },
    { path: "/p1.html" },
    { path: "/campaign.html", robots: "noindex,follow" },
    { path: "/campaign-terms.html", headers: { "x-robots-tag": "noindex" } },
  ];

  test("precomputed missing pages: a meta-noindex page is not listed", () => {
    const ctx = noindexCtx({
      pages: INDEXED,
      missingPages: [`${BASE}/campaign.html`],
      siteIndexable: true,
    });
    expect(coverage(ctx).status).toBe("pass");
    expect(listed(ctx)).toEqual([]);
  });

  test("precomputed path does not fall back to recomputing once the list is filtered empty", () => {
    // /campaign-terms.html is the only page missing from the sitemap list; the
    // fallback would also see the indexable /about page, which is not in the list.
    const ctx = noindexCtx({
      pages: [...INDEXED, { path: "/about.html" }],
      missingPages: [`${BASE}/campaign.html`],
      siteIndexable: true,
    });
    expect(listed(ctx)).toEqual([]);
  });

  test("precomputed path: a header-noindex page, matched through its trailing slash, is not listed", () => {
    const ctx = noindexCtx({
      pages: INDEXED,
      missingPages: [`${BASE}/campaign-terms.html/`],
      siteIndexable: true,
    });
    expect(listed(ctx)).toEqual([]);
  });

  test("fallback path: a header-noindex page is not listed", () => {
    const ctx = noindexCtx({ pages: INDEXED, missingPages: [], siteIndexable: true });
    expect(coverage(ctx).status).toBe("pass");
    expect(listed(ctx)).toEqual([]);
  });

  test("an indexable page missing from the sitemap is still listed (both paths)", () => {
    const pages = [...INDEXED, { path: "/about.html" }];
    const fallback = noindexCtx({ pages, missingPages: [], siteIndexable: true });
    expect(listed(fallback)).toEqual([`${BASE}/about.html`]);

    const precomputed = noindexCtx({
      pages,
      missingPages: [`${BASE}/campaign.html`, `${BASE}/about.html`],
      siteIndexable: true,
    });
    expect(listed(precomputed)).toEqual([`${BASE}/about.html`]);
  });

  test("a site that is noindex everywhere is reported as before", () => {
    for (const siteIndexable of [false, undefined]) {
      const precomputed = noindexCtx({
        pages: INDEXED,
        missingPages: [`${BASE}/campaign.html`],
        siteIndexable,
      });
      expect(listed(precomputed)).toEqual([`${BASE}/campaign.html`]);

      const fallback = noindexCtx({ pages: INDEXED, missingPages: [], siteIndexable });
      // The fallback has always left meta-noindex pages out; header noindex is only
      // read once the site is known to be indexable.
      expect(listed(fallback)).toEqual([`${BASE}/campaign-terms.html`]);
    }
  });
});
