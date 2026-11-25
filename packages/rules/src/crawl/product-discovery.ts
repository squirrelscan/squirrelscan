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

import type {
  SitemapReadState,
  SitePageView,
} from "@squirrelscan/core-contracts";

import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import type { CheckResult, RuleContext, SiteData } from "../types";

import { pathOrNull, PRODUCT_PATH } from "../shared/product-page";
import { sitePageViews } from "../shared/site-page-view";

/** Product pages needed to confirm commerce scope on their own. */
export const COMMERCE_MIN_PRODUCT_PAGES = 3;

const PRODUCT_SITEMAP_NAME = /product/i;

function normalizedOrNull(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
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
export function hasCommerceEvidence(pages: readonly SitePageView[]): boolean {
  let productPages = 0;
  let cartLink = false;
  let productPathPage = false;
  for (const page of pages) {
    if (page.productPage) {
      productPages++;
      // A lone product page counts only when its own path looks like a product path.
      const path = pathOrNull(page.url);
      if (path !== null && PRODUCT_PATH.test(path)) productPathPage = true;
    }
    if (!cartLink && page.cartLink) cartLink = true;
    if (productPages >= COMMERCE_MIN_PRODUCT_PAGES) return true;
  }
  return productPathPage && cartLink;
}

export function discoverProductUrls(
  site: SiteData,
  pages: readonly SitePageView[]
): ProductDiscovery {
  const sitemapAll = new Set<string>();
  const sitemapProducts = new Set<string>();
  for (const sitemap of site.sitemaps?.discovered ?? []) {
    const productSitemap = PRODUCT_SITEMAP_NAME.test(
      pathOrNull(sitemap.url) ?? ""
    );
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
      for (const link of page.links) {
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
    if (!page.productPage) continue;
    const url = normalizedOrNull(page.url);
    if (!url || crawledProducts.has(url)) continue;
    crawledProducts.add(url);
    const finalUrl = page.finalUrl ? normalizedOrNull(page.finalUrl) : null;
    const inSitemap =
      sitemapAll.has(url) || (finalUrl !== null && sitemapAll.has(finalUrl));
    const isLinked =
      linked.has(url) || (finalUrl !== null && linked.has(finalUrl));
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

function sitemapStateText(
  state: SitemapReadState | undefined,
  found: boolean
): string {
  if (state === "complete") return "sitemap read completely";
  if (state === "partial")
    return "sitemap only partly read (a cap, deadline or failed fetch), so its product list is a lower bound";
  if (state === "unreadable")
    return "sitemap unreadable, so no sitemap product URLs are known";
  return found ? "sitemap read state not recorded" : "no sitemap found";
}

/** The INFO check, or null when the site has no commerce evidence (no change for it). */
export function productDiscoveryCheck(ctx: RuleContext): CheckResult | null {
  const site = ctx.site;
  const pages = sitePageViews(ctx, { redirectAware: true });
  if (!site || !pages || pages.length === 0) return null;
  if (!hasCommerceEvidence(pages)) return null;

  const found = (site.sitemaps?.discovered.length ?? 0) > 0;
  const state = site.sitemaps?.readState;
  const discovery = discoverProductUrls(site, pages);
  const limits = site.crawlLimits;
  const crawlBounded = !!limits && limits.pagesCrawled >= limits.maxPages;

  const parts = [
    `${discovery.total} product URL(s) found: ${discovery.both} by both sitemap and crawl links, ` +
      `${discovery.sitemapOnly} by sitemap only, ${discovery.crawlOnly} by crawl only`,
    sitemapStateText(state, found),
  ];
  if (crawlBounded) {
    parts.push(
      `the crawl stopped at its ${limits.maxPages}-page limit, so crawl coverage is bounded, not a measure of missing products`
    );
  }
  if (site.linkDiscoveryOff)
    parts.push(
      "the crawl did not follow links, so crawl-link discovery was not observed"
    );

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
