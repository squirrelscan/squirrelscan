// The sitemap, hreflang and E-E-A-T site rules read page views, not `site.pages` (#2309).
//
// Each migrated rule runs twice over one fixture: the legacy way (`site.pages` only, views derived
// from it) and the engine's way (`site.pages` empty, views supplied by `ctx.siteQuery.pageViews()`).
// The findings must be identical, so the engine can stop holding parsed pages for these rules.

import type { SiteQuery } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

import { sitemapCoverageRule } from "../src/crawl/sitemap-coverage";
import { sitemapLastmodDriftRule } from "../src/crawl/sitemap-lastmod-drift";
import { aboutPageRule } from "../src/eeat/about-page";
import { affiliateDisclosureRule } from "../src/eeat/affiliate-disclosure";
import { authorBylineRule } from "../src/eeat/author-byline";
import { authorExpertiseRule } from "../src/eeat/author-expertise";
import { citationsRule } from "../src/eeat/citations";
import { contactPageRule } from "../src/eeat/contact-page";
import { contentDatesRule } from "../src/eeat/content-dates";
import { disclaimersRule } from "../src/eeat/disclaimers";
import { editorialPolicyRule } from "../src/eeat/editorial-policy";
import { physicalAddressRule } from "../src/eeat/physical-address";
import { privacyPolicyRule } from "../src/eeat/privacy-policy";
import { termsOfServiceRule } from "../src/eeat/terms-of-service";
import { trustSignalsRule } from "../src/eeat/trust-signals";
import { ymylDetectionRule } from "../src/eeat/ymyl-detection";
import { hreflangTargetsRule } from "../src/i18n/hreflang-targets";
import { REDIRECT_AWARE_SITE_RULE_IDS } from "../src/runner";
import { buildSitePageView } from "../src/shared/site-page-view";

const B = "https://example.com";

interface Spec {
  path: string;
  head?: string;
  body?: string;
  status?: number;
  headers?: Record<string, string>;
  redirectSource?: boolean;
  finalPath?: string;
}

const article = (author: boolean, modified: boolean): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: "A post",
        datePublished: "2024-03-10",
        ...(modified ? { dateModified: "2024-04-01" } : {}),
        ...(author ? { author: { "@type": "Person", name: "Jane" } } : {}),
      },
    ],
  })}</script>`;

const SPECS: Spec[] = [
  { path: "/", head: "<title>Home</title>" },
  {
    path: "/about",
    head: "<title>About us</title>",
    body: "<p>" + "word ".repeat(250) + "</p>",
  },
  {
    path: "/contact",
    head: "<title>Contact</title>",
    body: '<a href="mailto:hi@example.com">mail</a><a href="tel:+15551234567">call</a>',
  },
  {
    path: "/policy",
    head: "<title>Privacy Policy | Example</title>",
    body: '<a href="/privacy-policy">Privacy</a>',
  },
  {
    path: "/blog/post-1",
    head: `<title>Post one</title>${article(true, true)}`,
    body: '<a href="https://www.cdc.gov/x">cdc</a><a href="https://www.cdc.gov/x">cdc</a><a href="https://shop.example.net/p?ref=abc">buy</a><a href="/privacy-policy">Privacy</a>',
  },
  {
    path: "/blog/post-2",
    head: `<title>Post two</title>${article(false, false)}`,
  },
  {
    path: "/blog/post-3",
    head: `<title>Post three</title>${article(true, false)}`,
  },
  { path: "/terms", head: "<title>Terms</title>" },
  { path: "/disclaimer", head: "<title>Disclaimer</title>" },
  { path: "/editorial-policy", head: "<title>Editorial</title>" },
  {
    path: "/health/diabetes",
    head: '<title>Diabetes treatment guide</title><meta name="description" content="medical advice">',
  },
  {
    path: "/author/jane",
    head: `<title>Jane</title><script type="application/ld+json">${JSON.stringify(
      {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "Jane",
      }
    )}</script>`,
  },
  {
    path: "/testimonials",
    head: `<title>Reviews</title><script type="application/ld+json">${JSON.stringify(
      {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        address: { "@type": "PostalAddress", streetAddress: "1 Main St" },
        aggregateRating: { "@type": "AggregateRating", ratingValue: 5 },
      }
    )}</script>`,
  },
  {
    path: "/hidden",
    head: '<title>Hidden</title><meta name="robots" content="noindex">',
  },
  {
    path: "/en/",
    head: `<title>En</title><link rel="alternate" hreflang="en" href="${B}/en/"><link rel="alternate" hreflang="de" href="${B}/de/"><link rel="alternate" hreflang="fr" href="${B}/fr/">`,
  },
  {
    path: "/de/",
    head: `<title>De</title><link rel="alternate" hreflang="en" href="${B}/en/"><link rel="alternate" hreflang="de" href="${B}/de/">`,
  },
  { path: "/fr/", head: "<title>Fr</title>", status: 404 },
  ...["a", "b", "c"].map(
    (slug): Spec => ({
      path: `/products/${slug}`,
      head: `<title>Product ${slug}</title><script type="application/ld+json">${JSON.stringify(
        {
          "@context": "https://schema.org",
          "@type": "Product",
          name: slug,
        }
      )}</script>`,
      body: '<a href="/cart">Cart</a>',
    })
  ),
  { path: "/old", redirectSource: true, status: 301, finalPath: "/en/" },
  {
    path: "/dated",
    head: '<title>Dated</title><meta itemprop="dateModified" content="2020-01-01">',
  },
];

function pages(): SiteData["pages"] {
  return SPECS.map((s) => {
    const url = `${B}${s.path}`;
    const html = `<!doctype html><html lang="en"><head>${s.head ?? ""}</head><body><h1>${s.path}</h1>${s.body ?? ""}</body></html>`;
    return {
      url,
      statusCode: s.status ?? 200,
      parsed: parsePage(html, url),
      headers: s.headers ?? {},
      ...(s.finalPath ? { finalUrl: `${B}${s.finalPath}` } : {}),
      ...(s.redirectSource ? { redirectSource: true } : {}),
    };
  });
}

function site(sitePages: SiteData["pages"]): SiteData {
  const urls = ["/", "/about", "/blog/post-1", "/dated", "/hidden", "/en/"];
  return {
    baseUrl: B,
    pages: sitePages,
    robotsTxt: null,
    sitemaps: {
      discovered: [
        {
          url: `${B}/sitemap.xml`,
          type: "urlset",
          urls: urls.map((u) => ({ loc: `${B}${u}`, lastmod: "2024-06-01" })),
          childSitemaps: [],
          errors: [],
          urlCount: urls.length,
        },
      ],
      sources: { robotsTxt: [], commonLocations: [] },
      readState: "complete",
      totalUrls: urls.length,
    },
    siteIndexable: true,
  } as unknown as SiteData;
}

function ctxFor(
  sitePages: SiteData["pages"],
  siteQuery?: SiteQuery
): RuleContext {
  return {
    page: { url: `${B}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: site(sitePages),
    ...(siteQuery ? { siteQuery } : {}),
    options: {},
  };
}

const RULES: Rule[] = [
  aboutPageRule,
  affiliateDisclosureRule,
  authorBylineRule,
  authorExpertiseRule,
  citationsRule,
  contactPageRule,
  contentDatesRule,
  disclaimersRule,
  editorialPolicyRule,
  physicalAddressRule,
  privacyPolicyRule,
  termsOfServiceRule,
  trustSignalsRule,
  ymylDetectionRule,
  hreflangTargetsRule,
  sitemapCoverageRule,
  sitemapLastmodDriftRule,
];

describe("page views: legacy site.pages vs ctx.siteQuery.pageViews() (#2309)", () => {
  const legacy = pages();
  const views = legacy.map(buildSitePageView);
  const viewOnlyQuery = { pageViews: () => views } as unknown as SiteQuery;

  for (const rule of RULES) {
    test(`${rule.meta.id} reports the same findings on both paths`, async () => {
      // The runner hands a rule that is not redirect-aware the pages without redirect sources.
      const visible = REDIRECT_AWARE_SITE_RULE_IDS.has(rule.meta.id)
        ? legacy
        : legacy.filter((p) => !p.redirectSource);
      const fromPages = await rule.run(ctxFor(visible));
      // `site.pages` is empty here: a rule that still read it would skip.
      const fromViews = await rule.run(ctxFor([], viewOnlyQuery));
      expect(fromViews.checks).toEqual(fromPages.checks);
    });
  }

  test("the fixture exercises the rules, not their skip branches", async () => {
    for (const rule of RULES) {
      const { checks } = await rule.run(ctxFor(legacy));
      expect(
        checks.some((c) => c.status !== "skipped"),
        rule.meta.id
      ).toBe(true);
    }
  });

  test("crawl/sitemap-coverage reports product discovery from the views", async () => {
    const { checks } = await sitemapCoverageRule.run(ctxFor([], viewOnlyQuery));
    expect(checks.some((c) => c.name === "product-discovery")).toBe(true);
  });

  test("a redirect source reaches only the redirect-aware rules on the view path", async () => {
    const withSource = ctxFor([], viewOnlyQuery);
    const count = (await sitemapCoverageRule.run(withSource)).checks.length;
    expect(count).toBeGreaterThan(0);
    // eeat/terms reads content pages only: its views exclude the redirect source.
    const noRedirect = views.filter((v) => !v.redirectSource);
    const filtered = await termsOfServiceRule.run(
      ctxFor([], { pageViews: () => noRedirect } as unknown as SiteQuery)
    );
    const unfiltered = await termsOfServiceRule.run(withSource);
    expect(unfiltered.checks).toEqual(filtered.checks);
  });
});

describe("no migrated rule reads site.pages directly (#2309)", () => {
  const FILES = [
    ...new Glob("src/eeat/*.ts").scanSync({ cwd: `${import.meta.dir}/..` }),
    "src/crawl/sitemap-coverage.ts",
    "src/crawl/product-discovery.ts",
    "src/crawl/sitemap-lastmod-drift.ts",
    "src/i18n/hreflang-targets.ts",
  ];
  for (const file of FILES) {
    test(file, async () => {
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
      expect(source).not.toMatch(/site\??\.pages/);
    });
  }
});
