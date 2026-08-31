// crawl/sitemap-lastmod-drift — sitemap lastmod vs the page's own dateModified

import { describe, expect, test } from "bun:test";

import { parseHTML } from "linkedom";

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
  /** Raw JSON-LD, for the multi-node shapes a single `schemaDateModified` cannot express. */
  schemaRaw?: string;
  visibleDateModified?: string;
  visibleDatePublished?: string;
}

/** A `@graph` document, in the order the nodes are written — the ordering is the fixture. */
function graph(...nodes: Record<string, unknown>[]): string {
  return JSON.stringify({ "@context": "https://schema.org", "@graph": nodes });
}

/** A bare top-level array of nodes: the other shape generators emit. */
function flatArray(...nodes: Record<string, unknown>[]): string {
  return JSON.stringify(nodes.map((node) => ({ "@context": "https://schema.org", ...node })));
}

function parsed(spec: PageSpec): ParsedPage {
  const raw =
    spec.schemaRaw ??
    (spec.schemaDateModified
      ? JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          dateModified: spec.schemaDateModified,
        })
      : null);
  return {
    schema: { types: [], valid: true, errors: [], raw },
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

  test("a gap between the threshold and the next whole day never warns", () => {
    // Rounding used to push the effective thresholds half a day out: a 7.5-day
    // gap warned and was reported as "8 day(s)" under a "more than 7 day(s)"
    // message, overstating both the verdict and the number.
    const lastmod = "2024-03-01T00:00:00Z";
    const behindBy = (hours: number) =>
      sitemapLastmodDriftRule.run(
        ctx(
          [
            {
              url: "https://example.com/a",
              schemaDateModified: new Date(
                new Date(lastmod).getTime() + hours * 3_600_000
              ).toISOString(),
            },
          ],
          [{ loc: "https://example.com/a", lastmod }]
        )
      );

    expect(behindBy(7 * 24).checks[0]?.status).toBe("pass"); // exactly 7 days
    expect(behindBy(7 * 24 + 12).checks[0]?.status).toBe("pass"); // 7.5 days
    expect(behindBy(8 * 24 - 1).checks[0]?.status).toBe("pass"); // just under 8
    const warned = behindBy(8 * 24);
    expect(warned.checks[0]?.status).toBe("warn");
    expect(warned.checks[0]?.items?.[0]?.meta?.deltaDays).toBe(8);
  });

  test("a same-day difference cannot warn even with the threshold at zero", () => {
    const { checks } = sitemapLastmodDriftRule.run(
      ctx(
        [{ url: "https://example.com/a", schemaDateModified: "2024-03-01T22:00:00Z" }],
        [{ loc: "https://example.com/a", lastmod: "2024-03-01T02:00:00Z" }],
        { behind_days: 0 }
      )
    );
    expect(checks[0]?.status).toBe("pass");
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

  // ==========================================================================
  // Only the node that describes the DOCUMENT carries the page's date (#1570).
  //
  // Yoast, Rank Math and most WordPress stacks emit a sitewide WebSite /
  // Organization node FIRST in `@graph`, ahead of the Article. Reading the first
  // dated node made the verdict depend on that ordering, so every fixture below
  // is asserted in both orders.
  // ==========================================================================
  describe("document-typed nodes only", () => {
    const AGREES = "2024-06-01T00:00:00.000Z";
    const LASTMOD = "2024-06-01";
    const SITEWIDE = { "@type": "WebSite", name: "Example", dateModified: "2020-01-01" };
    const ARTICLE = { "@type": "Article", headline: "Post", dateModified: AGREES };

    const URL = "https://example.com/post";

    /** One page whose only date signals are the given JSON-LD, against an agreeing lastmod. */
    function runOn(raw: string, spec: Partial<PageSpec> = {}) {
      return sitemapLastmodDriftRule.run(
        ctx([{ url: URL, schemaRaw: raw, ...spec }], [{ loc: URL, lastmod: LASTMOD }])
      );
    }

    /** Same nodes, both orders — the verdict must not move. */
    function bothOrders(sitewide: Record<string, unknown>, article: Record<string, unknown>) {
      return {
        sitewideFirst: runOn(graph(sitewide, article)),
        articleFirst: runOn(graph(article, sitewide)),
      };
    }

    test("sitewide WebSite dated 2020 ahead of an agreeing Article → pass, in either order", () => {
      const { sitewideFirst, articleFirst } = bothOrders(SITEWIDE, ARTICLE);

      expect(sitewideFirst.checks[0]?.status).toBe("pass");
      expect(articleFirst.checks[0]?.status).toBe("pass");
      // Not just the same status: the same finding, byte for byte.
      expect(JSON.stringify(sitewideFirst)).toBe(JSON.stringify(articleFirst));
    });

    test("real drift on the Article still warns, with the sitewide node present", () => {
      const drifted = { "@type": "Article", dateModified: "2011-04-02T00:00:00.000Z" };
      const { sitewideFirst, articleFirst } = bothOrders(SITEWIDE, drifted);

      for (const result of [sitewideFirst, articleFirst]) {
        expect(result.checks[0]?.status).toBe("warn");
        expect(result.checks[0]?.name).toBe("sitemap-lastmod-ahead-of-page");
        // The Article's 2011 date, never the WebSite's 2020 one.
        expect(result.checks[0]?.items?.[0]?.meta?.pageDate).toBe("2011-04-02T00:00:00.000Z");
      }
      expect(JSON.stringify(sitewideFirst)).toBe(JSON.stringify(articleFirst));
    });

    test("the same trap in a flat top-level array, not just @graph", () => {
      expect(runOn(flatArray(SITEWIDE, ARTICLE)).checks[0]?.status).toBe("pass");
      expect(runOn(flatArray(ARTICLE, SITEWIDE)).checks[0]?.status).toBe("pass");
    });

    test("sitewide nodes carrying dates raise no drift claim of their own", () => {
      // Every one of these describes a thing the page mentions, not the page.
      // With no document node and no visible date, there is nothing to compare.
      const { checks } = runOn(
        graph(
          SITEWIDE,
          { "@type": "Organization", dateModified: "2019-05-05" },
          { "@type": "SoftwareApplication", datePublished: "2026-01-01" },
          { "@type": "Person", name: "Author" }
        )
      );
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toBe("No comparable dates");
    });

    test("with no document-typed date the page's own visible date is used, not the sitewide one", () => {
      // The WebSite's 2020 date would have warned by 1,613 days.
      const { checks } = runOn(graph(SITEWIDE), { visibleDateModified: AGREES });
      expect(checks[0]?.status).toBe("pass");
    });

    test("a WebPage node speaks for the document when there is no Article", () => {
      const { checks } = runOn(graph(SITEWIDE, { "@type": "WebPage", dateModified: AGREES }));
      expect(checks[0]?.status).toBe("pass");
    });

    test("an Article wins over a dated WebPage regardless of position", () => {
      const webPage = { "@type": "WebPage", dateModified: "2011-04-02T00:00:00.000Z" };
      // The WebPage's 2011 date would warn; the Article agrees with lastmod.
      expect(runOn(graph(webPage, ARTICLE)).checks[0]?.status).toBe("pass");
      expect(runOn(graph(ARTICLE, webPage)).checks[0]?.status).toBe("pass");
    });

    test("array-wrapped @type and a {@value} date are still read", () => {
      const { checks } = runOn(
        graph(SITEWIDE, {
          "@type": ["WebPage", "BlogPosting"],
          dateModified: { "@value": "2011-04-02T00:00:00.000Z" },
        })
      );
      expect(checks[0]?.status).toBe("warn");
      expect(checks[0]?.items?.[0]?.meta?.pageDate).toBe("2011-04-02T00:00:00.000Z");
    });

    test("a node claiming both a page and an article type counts as the article", () => {
      // `["WebPage","BlogPosting"]` and its reverse are the same claim, so the
      // dated WebPage must lose to this node either way round.
      const stalePage = { "@type": "WebPage", dateModified: "2011-04-02T00:00:00.000Z" };
      for (const types of [["WebPage", "BlogPosting"], ["BlogPosting", "WebPage"]]) {
        const { checks } = runOn(graph(stalePage, { "@type": types, dateModified: AGREES }));
        expect(checks[0]?.status).toBe("pass");
      }
    });

    test("full-IRI and schema:-prefixed @types are recognised", () => {
      for (const type of ["https://schema.org/Article", "http://schema.org/Article", "schema:Article"]) {
        // Recognised as the document node, so its agreeing date beats the sitewide one.
        expect(runOn(graph(SITEWIDE, { "@type": type, dateModified: AGREES })).checks[0]?.status).toBe(
          "pass"
        );
      }
    });

    test("an unparseable date on one document node does not hide a later usable one", () => {
      const { checks } = runOn(
        graph(
          SITEWIDE,
          { "@type": "Article", dateModified: "last tuesday" },
          { "@type": "BlogPosting", dateModified: AGREES }
        )
      );
      // Returning "last tuesday" would have failed to parse and dropped the page
      // to "no comparable dates", losing a comparison the page could support.
      expect(checks[0]?.status).toBe("pass");
      expect(checks[0]?.details?.comparedPages).toBe(1);
    });

    test("an unparseable entry does not hide a later one in the same date list", () => {
      const { checks } = runOn(
        graph(SITEWIDE, { "@type": "Article", dateModified: ["last tuesday", AGREES] })
      );
      expect(checks[0]?.status).toBe("pass");
      expect(checks[0]?.details?.comparedPages).toBe(1);
    });

    test("a crafted IRI is not normalised twice into a type it does not name", () => {
      // Stripping the IRI and then the prefix in sequence would reduce this to
      // `Article`; it names no schema.org type, so the node is not the document.
      const { checks } = runOn(
        graph({ "@type": "https://schema.org/schema:Article", dateModified: AGREES })
      );
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toBe("No comparable dates");
    });
  });

  // The rule reads only parsed-page SCALARS — never `parsed.document` — so the
  // streaming site pass (every DOM dropped before site rules run) must reach the
  // same verdict as the legacy `site.pages` pass. Probed by feeding a DOM that
  // CONTRADICTS the scalars: if the rule ever started falling back to the
  // document's own JSON-LD, the two paths would diverge here.
  test("dropping the page DOM does not change the output (dual-path parity)", () => {
    const page = {
      url: "https://example.com/post",
      // Scalars say the page agrees with lastmod...
      schemaDateModified: "2026-08-01T00:00:00.000Z",
    };
    const urls = [{ loc: "https://example.com/post", lastmod: "2026-08-01T00:00:00.000Z" }];

    const streaming = sitemapLastmodDriftRule.run(ctx([page], urls));

    // ...while the DOM the legacy path still carries says it drifted by years.
    const legacyCtx = ctx([page], urls);
    const document = parseHTML(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        dateModified: "2011-04-02T00:00:00.000Z",
      })}</script></head><body><time datetime="2011-04-02">2 April 2011</time></body></html>`
    ).document;
    for (const sitePage of legacyCtx.site!.pages) {
      (sitePage.parsed as unknown as { document: unknown }).document = document;
    }
    const legacy = sitemapLastmodDriftRule.run(legacyCtx);

    expect(streaming.checks[0]?.status).toBe("pass");
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(streaming));
  });

  test("a siteQuery on the context does not change the output", () => {
    const base = ctx(
      [{ url: "https://example.com/post", schemaDateModified: "2011-04-02T00:00:00Z" }],
      [{ loc: "https://example.com/post", lastmod: "2026-08-01T00:00:00Z" }]
    );
    const legacy = sitemapLastmodDriftRule.run(base);
    const streaming = sitemapLastmodDriftRule.run({
      ...base,
      siteQuery: { pageCount: () => 1 },
    } as unknown as RuleContext);
    expect(JSON.stringify(streaming)).toBe(JSON.stringify(legacy));
  });
});
