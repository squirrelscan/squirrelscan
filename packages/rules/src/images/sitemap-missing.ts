// images/sitemap-missing - An indexable page's main image is not in its sitemap image entries (pub#2093)
//
// Google's image sitemap extension (`<image:image><image:loc>` under a `<url>`) is the documented way to
// declare a page's images for image search. The crawler keeps those entries per URL (capped); this rule
// reads them. No network: it compares the page's main image (og:image, else a Product JSON-LD `image`)
// with the entries of that page's own sitemap `<url>`.
//
// Quiet by design:
//   * a site whose sitemaps carry no image entries at all is SKIPPED, not flagged: image sitemaps are
//     optional, and flagging every page of a site that never adopted them is noise, not a defect;
//   * only an indexable page is judged: status 200, no noindex (meta or header), canonical absent or self;
//   * a page absent from the sitemap, listed with no image entries of its own (a stock Shopify sitemap lists
//     the homepage and /pages/* that way), or without a main image, is not judged;
//   * URLs are normalized before comparing (scheme, query string and fragment dropped, a CDN size suffix
//     such as Shopify's `_800x` or WordPress's `-300x200` removed, and Shopify's two spellings of one file,
//     `<shop>/cdn/shop/files/x.png` and `cdn.shopify.com/s/files/1/.../files/x.png`, made equal), so a
//     stock Shopify sitemap passes;
//   * any one candidate (og:image or a Product image) matching passes;
//   * an entry whose image list was truncated at the crawler's cap is not judged.
//
// info severity (one finding per page, no per-page values in the message so one defect has one identity).

import { flattenJsonLdNodes, isPageIndexable } from "@squirrelscan/utils";
import type { SitemapDiscovery } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const SIZE_SUFFIX = /(?:_(?:\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|master)|-\d+x\d+)(?=\.[a-z0-9]+$)/i;

/** Shopify's storefront image path: `<shop>/cdn/shop/<files|products|...>/x.png`. */
const SHOPIFY_STOREFRONT_PATH = /^\/cdn\/shop\/(.+)$/;
/** Shopify's CDN image path: `cdn.shopify.com/s/files/1/0123/4567/<files|products|...>/x.png`. */
const SHOPIFY_CDN_PATH = /^\/s\/files\/\d+(?:\/\d+)*\/(.+)$/;

/**
 * An image URL reduced to the part that names the picture: host and path, no size suffix, query or fragment.
 * Shopify serves one file from the shop's own host (`/cdn/shop/...`) and from `cdn.shopify.com`
 * (`/s/files/1/<store id>/...`); both reduce to the same `shopify:` key.
 */
export function normalizeImageUrl(raw: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // keep the path as written
  }
  path = path.replace(SIZE_SUFFIX, "");
  const host = url.hostname.toLowerCase();
  const storefront = SHOPIFY_STOREFRONT_PATH.exec(path);
  if (storefront) return `shopify:${storefront[1]}`;
  const cdn = host === "cdn.shopify.com" ? SHOPIFY_CDN_PATH.exec(path) : null;
  if (cdn) return `shopify:${cdn[1]}`;
  return `${host}${path}`;
}

/** A page URL as a lookup key: no fragment, no trailing slash, host lowercased. */
function pageKey(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

interface SitemapImages {
  /** Normalized images declared for the URL, merged across sitemaps. */
  images: Set<string>;
  truncated: boolean;
}

interface SitemapImageIndex {
  byPage: Map<string, SitemapImages>;
  anyImages: boolean;
}

const indexCache = new WeakMap<SitemapDiscovery, SitemapImageIndex>();

function imageIndex(sitemaps: SitemapDiscovery): SitemapImageIndex {
  const cached = indexCache.get(sitemaps);
  if (cached) return cached;
  const byPage = new Map<string, SitemapImages>();
  let anyImages = false;
  for (const sitemap of sitemaps.discovered) {
    for (const entry of sitemap.urls) {
      const key = pageKey(entry.loc);
      if (!key) continue;
      let slot = byPage.get(key);
      if (!slot) {
        slot = { images: new Set(), truncated: false };
        byPage.set(key, slot);
      }
      for (const image of entry.images ?? []) {
        const normalized = normalizeImageUrl(image, entry.loc);
        if (normalized) {
          slot.images.add(normalized);
          anyImages = true;
        }
      }
      if (entry.imagesTruncated) slot.truncated = true;
    }
  }
  const built = { byPage, anyImages };
  indexCache.set(sitemaps, built);
  return built;
}

/** `image` values of a JSON-LD node: a string, an ImageObject (`url` / `contentUrl`), or a list of either. */
function jsonLdImages(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonLdImages(item, out);
  else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    jsonLdImages(node.url ?? node.contentUrl, out);
  }
  return out;
}

function isProduct(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.includes("Product") || types.includes("ProductGroup");
}

function mainImages(ctx: RuleContext): string[] {
  const out: string[] = [];
  const og = ctx.parsed.og?.image;
  if (og) out.push(og);
  const doc = ctx.parsed.document;
  if (doc) {
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      for (const node of flattenJsonLdNodes(script.textContent || "")) {
        if (isProduct(node)) jsonLdImages(node.image, out);
      }
    }
  }
  return out;
}

const NAME = "sitemap-missing-image";

export const sitemapMissingRule: Rule = {
  meta: {
    id: "images/sitemap-missing",
    name: "Image Missing From Sitemap",
    description: "Checks that an indexable page's main image is listed in its sitemap image entries",
    solution:
      "Your sitemap lists image entries for other pages, but not this page's main image (og:image or Product image). Image sitemaps are how Google discovers images that are loaded by script or sit behind galleries, which matters most for shops. Add an <image:image><image:loc> entry for the main image under this page's <url>, or let your platform or sitemap plugin generate image entries (Shopify does by default). Sites that do not use image sitemaps are not flagged.",
    category: "images",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 3,
    checks: [
      { name: NAME, outcome: "problem" },
      { name: NAME, outcome: "clean", clears: [NAME] },
      { name: NAME, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const sitemaps = ctx.site?.sitemaps;
    if (!sitemaps || sitemaps.discovered.length === 0) {
      return { checks: [{ name: NAME, status: "skipped", message: "No sitemap data available" }] };
    }
    const index = imageIndex(sitemaps);
    if (!index.anyImages) {
      return {
        checks: [{ name: NAME, status: "skipped", message: "The sitemap declares no image entries" }],
      };
    }

    const page = ctx.page;
    if (page.statusCode !== 200) return { checks: [] };
    if (!isPageIndexable(ctx.parsed, page.headers).isIndexable) return { checks: [] };
    const pageUrl = page.finalUrl ?? page.url;
    const self = pageKey(page.url);
    const canonical = ctx.parsed.meta?.canonical;
    if (canonical && pageKey(canonical, pageUrl) !== self) return { checks: [] };

    const slot = self ? index.byPage.get(self) : undefined;
    // Not judged: a page outside the sitemap, an entry listed without image entries of its own (Shopify lists
    // the homepage and /pages/* that way), or one whose image list was truncated at the crawler's cap.
    if (!slot || slot.images.size === 0 || slot.truncated) return { checks: [] };

    const candidates = mainImages(ctx)
      .map((raw) => normalizeImageUrl(raw, pageUrl))
      .filter((c): c is string => c !== null);
    if (candidates.length === 0) return { checks: [] };

    const check: CheckResult = candidates.some((c) => slot.images.has(c))
      ? { name: NAME, status: "pass", message: "The page's main image is in its sitemap image entries" }
      : {
          name: NAME,
          status: "info",
          message: "Main image is not in the page's sitemap image entries",
          expected: "An <image:image><image:loc> entry for the main image under the page's <url>",
        };
    return { checks: [check] };
  },
};
