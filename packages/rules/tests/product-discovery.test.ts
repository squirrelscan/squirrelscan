// crawl/sitemap-coverage product-discovery check (#1651): provenance of a shop's product URLs and
// the sitemap's read state, never a missing-product claim.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import type { SitemapDiscovery, SitemapReadState } from "@squirrelscan/core-contracts";

import { parseSchemas } from "@squirrelscan/parser";

import { sitemapCoverageRule } from "../src/crawl/sitemap-coverage";
import type { CheckResult, ParsedPage, RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";
const INVENTORY = Array.from({ length: 12 }, (_, i) => `${BASE}/products/item-${i + 1}`);

function link(url: string, isInternal = true) {
  return { url, text: "", isInternal };
}

function productPage(url: string, links: string[] = []) {
  return {
    url,
    statusCode: 200,
    parsed: {
      meta: {},
      og: { type: null },
      schemas: { types: ["Product"] },
      links: links.map((l) => link(l)),
    } as unknown as ParsedPage,
  };
}

function plainPage(url: string, links: string[] = []) {
  return {
    url,
    statusCode: 200,
    parsed: {
      meta: {},
      og: { type: "website" },
      schemas: { types: ["WebSite"] },
      links: links.map((l) => link(l)),
    } as unknown as ParsedPage,
  };
}

function sitemaps(locs: string[], readState?: SitemapReadState): SitemapDiscovery {
  return {
    discovered: [
      {
        url: `${BASE}/sitemap.xml`,
        type: "urlset",
        urls: locs.map((loc) => ({ loc })),
        childSitemaps: [],
        errors: [],
        urlCount: locs.length,
      },
    ],
    sources: { robotsTxt: [], commonLocations: [] },
    totalUrls: locs.length,
    orphanPages: [],
    missingPages: [],
    failed: [],
    ...(readState ? { readState } : {}),
  };
}

function run(site: Partial<SiteData>): CheckResult[] {
  const ctx = {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, robotsTxt: null, sitemaps: null, pages: [], ...site },
    options: {},
  } as unknown as RuleContext;
  return (sitemapCoverageRule.run(ctx) as { checks: CheckResult[] }).checks;
}

function discovery(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((c) => c.name === "product-discovery");
}

/** Eight crawled pages: the home page plus seven products, the first four linked from the home page. */
function boundedShop(): Pick<SiteData, "pages" | "crawlLimits"> {
  const products = INVENTORY.slice(0, 7);
  return {
    pages: [plainPage(`${BASE}/`, products.slice(0, 4)), ...products.map((u) => productPage(u))],
    crawlLimits: { pagesCrawled: 8, maxPages: 8 },
  };
}

describe("crawl/sitemap-coverage product discovery (#1651)", () => {
  test("bounded crawl against a complete product sitemap: provenance by source, bounded not missing", () => {
    const check = discovery(run({ ...boundedShop(), sitemaps: sitemaps(INVENTORY, "complete") }));
    expect(check?.status).toBe("info");
    expect(check?.details).toMatchObject({
      total: 12,
      bySource: { both: 4, sitemap: 8, crawl: 0 },
      crawledProductPages: 7,
      sitemapProductUrls: 12,
      sitemapState: "complete",
      crawlBounded: true,
    });
    expect(check?.message).toContain("sitemap read completely");
    expect(check?.message).toContain("bounded, not a measure of missing products");
  });

  test("never asserts missing products, whatever the sitemap state", () => {
    for (const state of ["complete", "partial", "unreadable", undefined] as const) {
      const checks = run({ ...boundedShop(), sitemaps: sitemaps(INVENTORY, state) });
      for (const check of checks) {
        if (check.name !== "product-discovery") continue;
        expect(check.status).toBe("info");
        // The only mention of "missing" is the negation that crawl coverage is not a measure of it.
        expect(check.message).not.toMatch(
          /\d+ [^;]{0,40}missing|missing from|not in (the )?sitemap/i,
        );
        expect(check.details).toMatchObject({ inventory: "unknown" });
        expect(check.details).not.toHaveProperty("missing");
      }
    }
  });

  test("unreadable sitemap: crawl-only provenance and the state says so", () => {
    const { pages, crawlLimits } = boundedShop();
    const check = discovery(run({ pages, crawlLimits, sitemaps: null }));
    expect(check?.details).toMatchObject({
      total: 7,
      bySource: { both: 0, sitemap: 0, crawl: 7 },
      sitemapState: "none",
    });
    const unreadable = discovery(
      run({ pages, crawlLimits, sitemaps: { ...sitemaps([], "unreadable"), discovered: [] } }),
    );
    // The state travels even when nothing was read.
    expect(unreadable?.details).toMatchObject({ sitemapState: "unreadable" });
    expect(unreadable?.message).toContain("unreadable");
  });

  test("partial sitemap is distinguished from complete", () => {
    const check = discovery(
      run({ ...boundedShop(), sitemaps: sitemaps(INVENTORY.slice(0, 6), "partial") }),
    );
    expect(check?.details).toMatchObject({ sitemapState: "partial", sitemapProductUrls: 6 });
    expect(check?.message).toContain("lower bound");
  });

  test("a read state that was never recorded is unknown, not complete", () => {
    const check = discovery(run({ ...boundedShop(), sitemaps: sitemaps(INVENTORY) }));
    expect(check?.details).toMatchObject({ sitemapState: "unknown" });
    expect(check?.message).not.toContain("read completely");
  });

  test("a crawl that did not follow links claims no crawl-link discovery", () => {
    const check = discovery(
      run({ ...boundedShop(), sitemaps: sitemaps(INVENTORY, "complete"), linkDiscoveryOff: true }),
    );
    expect(check?.details).toMatchObject({ bySource: { both: 0, sitemap: 12, crawl: 0 } });
  });

  test("a site without commerce evidence is unchanged: no check", () => {
    const pages = [plainPage(`${BASE}/`), plainPage(`${BASE}/about`), plainPage(`${BASE}/blog`)];
    expect(discovery(run({ pages, sitemaps: sitemaps(INVENTORY, "complete") }))).toBeUndefined();
    // Two product pages alone are below the threshold.
    const two = [plainPage(`${BASE}/`), productPage(INVENTORY[0]!), productPage(INVENTORY[1]!)];
    expect(
      discovery(run({ pages: two, sitemaps: sitemaps(INVENTORY, "complete") })),
    ).toBeUndefined();
  });

  test("one product page plus a cart link is enough evidence", () => {
    const pages = [plainPage(`${BASE}/`, [`${BASE}/cart`]), productPage(INVENTORY[0]!)];
    expect(discovery(run({ pages, sitemaps: sitemaps(INVENTORY, "complete") }))?.status).toBe(
      "info",
    );
  });

  test("og:type=product counts as product evidence", () => {
    const og = (url: string) => ({
      url,
      statusCode: 200,
      parsed: {
        meta: {},
        og: { type: "product" },
        schemas: { types: [] },
        links: [],
      } as unknown as ParsedPage,
    });
    const pages = INVENTORY.slice(0, 3).map(og);
    expect(discovery(run({ pages }))?.details).toMatchObject({ crawledProductPages: 3 });
  });

  test("the existing coverage verdict is untouched", () => {
    const checks = run({ ...boundedShop(), sitemaps: sitemaps(INVENTORY, "complete") });
    expect(checks.map((c) => c.name)).toContain("sitemap-coverage");
  });

  // Real parser output, so the nested-type cases run against what a crawl actually stores.
  function jsonLdPage(url: string, ld: unknown, links: string[] = []) {
    const { document } = parseHTML(
      `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`,
    );
    return {
      url,
      statusCode: 200,
      parsed: {
        meta: {},
        og: { type: null },
        schemas: parseSchemas(document as never),
        links: links.map((l) => link(l)),
      } as unknown as ParsedPage,
    };
  }

  test("a Product nested in a Review, ItemList or Offer is not a product page", () => {
    const product = { "@type": "Product", name: "Widget" };
    const pages = [
      jsonLdPage(`${BASE}/reviews/a`, { "@type": "Review", itemReviewed: product }),
      jsonLdPage(`${BASE}/reviews/b`, { "@type": "Review", itemReviewed: product }),
      jsonLdPage(`${BASE}/reviews/c`, { "@type": "Review", itemReviewed: product }),
    ];
    expect(discovery(run({ pages, sitemaps: sitemaps(INVENTORY, "complete") }))).toBeUndefined();

    const list = {
      "@type": "ItemList",
      itemListElement: [1, 2, 3].map((position) => ({ "@type": "ListItem", position, item: product })),
    };
    const category = [
      jsonLdPage(`${BASE}/products/shoes`, list, [`${BASE}/cart`]),
      jsonLdPage(`${BASE}/products/hats`, list, [`${BASE}/cart`]),
      jsonLdPage(`${BASE}/products/bags`, list, [`${BASE}/cart`]),
    ];
    expect(discovery(run({ pages: category }))).toBeUndefined();

    const offered = jsonLdPage(
      `${BASE}/products/x`,
      { "@type": "Offer", itemOffered: product },
      [`${BASE}/cart`],
    );
    expect(discovery(run({ pages: [offered] }))).toBeUndefined();
  });

  test("top-level Product, ProductGroup and @graph Product count", () => {
    const pages = [
      jsonLdPage(`${BASE}/products/a`, { "@type": "Product" }),
      jsonLdPage(`${BASE}/products/b`, { "@type": "ProductGroup" }),
      jsonLdPage(`${BASE}/products/c`, { "@graph": [{ "@type": "WebPage" }, { "@type": ["Product"] }] }),
    ];
    expect(discovery(run({ pages }))?.details).toMatchObject({ crawledProductPages: 3 });
  });

  test("one embedded Product page plus a nav cart link needs a product-shaped path of its own", () => {
    const nav = [`${BASE}/cart`];
    const blog = jsonLdPage(`${BASE}/blog/post`, { "@type": "Product" }, nav);
    expect(discovery(run({ pages: [blog] }))).toBeUndefined();
    const shop = jsonLdPage(`${BASE}/products/post`, { "@type": "Product" }, nav);
    expect(discovery(run({ pages: [shop] }))?.status).toBe("info");
  });
});
