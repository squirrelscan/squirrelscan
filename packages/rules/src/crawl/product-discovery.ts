// crawl/sitemap-coverage, product discovery check: where a commerce site's product URLs were found.
//
// This reports PROVENANCE and the sitemap's read state, and nothing else. It never says a product is
// missing: the crawl is a bounded sample and a sitemap is the site's own list, so neither is a product
// inventory, and the size of the catalogue cannot be inferred from eight sampled pages. A claim of
// missing products needs an inventory the site owner supplies, which this check has no input for.
//
// Commerce scope comes from page evidence only (Product JSON-LD or og:type product on crawled pages,
// plus a cart or checkout link), read from the scalar page record so it needs no DOM and runs the same
// in the streaming engine. A site without that evidence gets no check at all.

import type { SitemapReadState } from "@squirrelscan/core-contracts";
import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import type { CheckResult, RuleContext, SiteData } from "../types";

/** Product pages needed to confirm commerce scope on their own. */
export const COMMERCE_MIN_PRODUCT_PAGES = 3;

/** A product-shaped sitemap URL: a slug under a product segment, so the `/products` index is not one. */
const PRODUCT_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:products?|p|items?)\/[^/]{1,200}/i;
const CART_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:cart|basket|bag|checkout)(?:\/|$)/i;
const PRODUCT_SITEMAP_NAME = /product/i;

type Page = SiteData["pages"][number];

function normalizedOrNull(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

function pathOrNull(url: string): string | null {
  try {
    return getPathname(url);
  } catch {
    return null;
  }
}

function isProductPage(page: Page): boolean {
  if (page.statusCode !== 200) return false;
  const types = page.parsed?.schemas?.types;
  if (Array.isArray(types)) {
    for (const type of types) {
      if (typeof type !== "string") continue;
      // "Product", "schema:Product" and "https://schema.org/Product" all name the type.
      const name = type.slice(type.lastIndexOf("/") + 1).replace(/^schema:/i, "");
      if (name === "Product" || name === "ProductGroup") return true;
    }
  }
  const ogType = page.parsed?.og?.type;
  return typeof ogType === "string" && /^(?:og:)?product(?:\.[a-z]{1,32})?$/i.test(ogType.trim());
}

function linksToCart(page: Page): boolean {
  for (const link of page.parsed?.links ?? []) {
    if (!link.isInternal) continue;
    const path = pathOrNull(link.url);
    if (path && CART_PATH.test(path)) return true;
  }
  return false;
}

export interface ProductDiscovery {
  /** Distinct product URLs, by how they were found. */
  total: number;
  both: number;
  sitemapOnly: number;
  crawlOnly: number;
  crawledProductPages: number;
  /** Product-shaped URLs the sitemaps list (crawled or not). */
  sitemapProductUrls: number;
}

/** True when the crawled pages show the site sells products. */
export function hasCommerceEvidence(pages: Page[]): boolean {
  let productPages = 0;
  let cartLink = false;
  for (const page of pages) {
    if (isProductPage(page)) productPages++;
    if (!cartLink && linksToCart(page)) cartLink = true;
    if (productPages >= COMMERCE_MIN_PRODUCT_PAGES) return true;
  }
  return productPages >= 1 && cartLink;
}

export function discoverProductUrls(site: SiteData): ProductDiscovery {
  const pages = site.pages;
  const sitemapAll = new Set<string>();
  const sitemapProducts = new Set<string>();
  for (const sitemap of site.sitemaps?.discovered ?? []) {
    const productSitemap = PRODUCT_SITEMAP_NAME.test(pathOrNull(sitemap.url) ?? "");
    for (const entry of sitemap.urls) {
      const normalized = normalizedOrNull(entry.loc);
      if (!normalized) continue;
      sitemapAll.add(normalized);
      const path = pathOrNull(entry.loc);
      if (productSitemap || (path !== null && PRODUCT_PATH.test(path))) {
        sitemapProducts.add(normalized);
      }
    }
  }

  // Crawl links are only observed when the crawl followed links.
  const linked = new Set<string>();
  if (!site.linkDiscoveryOff) {
    for (const page of pages) {
      const self = normalizedOrNull(page.url);
      for (const link of page.parsed?.links ?? []) {
        if (!link.isInternal) continue;
        const target = normalizedOrNull(link.url);
        if (target && target !== self) linked.add(target);
      }
    }
  }

  const crawledProducts = new Set<string>();
  let both = 0;
  let sitemapOnly = 0;
  let crawlOnly = 0;
  for (const page of pages) {
    if (!isProductPage(page)) continue;
    const url = normalizedOrNull(page.url);
    if (!url || crawledProducts.has(url)) continue;
    crawledProducts.add(url);
    const finalUrl = page.finalUrl ? normalizedOrNull(page.finalUrl) : null;
    const inSitemap = sitemapAll.has(url) || (finalUrl !== null && sitemapAll.has(finalUrl));
    const isLinked = linked.has(url) || (finalUrl !== null && linked.has(finalUrl));
    if (inSitemap && isLinked) both++;
    else if (inSitemap) sitemapOnly++;
    else crawlOnly++;
  }
  let sitemapNotCrawled = 0;
  for (const url of sitemapProducts) {
    if (!crawledProducts.has(url)) sitemapNotCrawled++;
  }

  return {
    total: both + sitemapOnly + crawlOnly + sitemapNotCrawled,
    both,
    sitemapOnly: sitemapOnly + sitemapNotCrawled,
    crawlOnly,
    crawledProductPages: crawledProducts.size,
    sitemapProductUrls: sitemapProducts.size,
  };
}

function sitemapStateText(state: SitemapReadState | undefined, found: boolean): string {
  if (state === "complete") return "sitemap read completely";
  if (state === "partial")
    return "sitemap only partly read (a cap, deadline or failed fetch), so its product list is a lower bound";
  if (state === "unreadable") return "sitemap unreadable, so no sitemap product URLs are known";
  return found ? "sitemap read state not recorded" : "no sitemap found";
}

/** The INFO check, or null when the site has no commerce evidence (no change for it). */
export function productDiscoveryCheck(ctx: RuleContext): CheckResult | null {
  const site = ctx.site;
  if (!site?.pages || site.pages.length === 0) return null;
  if (!hasCommerceEvidence(site.pages)) return null;

  const found = (site.sitemaps?.discovered.length ?? 0) > 0;
  const state = site.sitemaps?.readState;
  const discovery = discoverProductUrls(site);
  const limits = site.crawlLimits;
  const crawlBounded = !!limits && limits.pagesCrawled >= limits.maxPages;

  const parts = [
    `${discovery.total} product URL(s) found: ${discovery.both} by both sitemap and crawl links, ` +
      `${discovery.sitemapOnly} by sitemap only, ${discovery.crawlOnly} by crawl only`,
    sitemapStateText(state, found),
  ];
  if (crawlBounded) {
    parts.push(
      `the crawl stopped at its ${limits.maxPages}-page limit, so crawl coverage is bounded, not a measure of missing products`,
    );
  }
  if (site.linkDiscoveryOff)
    parts.push("the crawl did not follow links, so crawl-link discovery was not observed");

  return {
    name: "product-discovery",
    status: "info",
    message: parts.join("; "),
    details: {
      total: discovery.total,
      bySource: {
        both: discovery.both,
        sitemap: discovery.sitemapOnly,
        crawl: discovery.crawlOnly,
      },
      crawledProductPages: discovery.crawledProductPages,
      sitemapProductUrls: discovery.sitemapProductUrls,
      sitemapState: state ?? (found ? "unknown" : "none"),
      crawlBounded,
      // No inventory input exists, so no missing-product count is ever reported.
      inventory: "unknown",
    },
  };
}
