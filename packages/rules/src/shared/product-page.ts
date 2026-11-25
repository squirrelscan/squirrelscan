// Product and cart evidence read from one crawled page, shared by crawl/product-discovery and
// the page view (#2309). Reads parsed-page scalars only.

import { getPathname } from "@squirrelscan/utils";

import type { ParsedPage } from "../types";

/** A product-shaped sitemap URL: a slug under a product segment, so the `/products` index is not one. */
export const PRODUCT_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:products?|p|items?)\/[^/]{1,200}/i;
const CART_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:cart|basket|bag|checkout)(?:\/|$)/i;
/** The slice of a crawled page these checks read. */
export interface ProductEvidencePage {
  statusCode: number;
  parsed?: ParsedPage;
}

export function pathOrNull(url: string): string | null {
  try {
    return getPathname(url);
  } catch {
    return null;
  }
}

export function isProductPage(page: ProductEvidencePage): boolean {
  if (page.statusCode !== 200) return false;
  // TOP-LEVEL nodes only (the collection's `all`, @graph children included): a Product nested in a
  // Review.itemReviewed, an ItemList element or an Offer.itemOffered does not make the page a product page.
  // `types` is the fallback for a collection that carries no nodes; it is built from the same top-level nodes.
  const schemas = page.parsed?.schemas as
    | { all?: unknown; types?: unknown }
    | undefined;
  const nodeTypes: unknown[] = [];
  if (Array.isArray(schemas?.all)) {
    for (const node of schemas.all) {
      const t = (node as { "@type"?: unknown } | null)?.["@type"];
      if (Array.isArray(t)) nodeTypes.push(...t);
      else nodeTypes.push(t);
    }
  } else if (Array.isArray(schemas?.types)) {
    nodeTypes.push(...schemas.types);
  }
  for (const type of nodeTypes) {
    if (typeof type !== "string") continue;
    // "Product", "schema:Product" and "https://schema.org/Product" all name the type.
    const name = type.slice(type.lastIndexOf("/") + 1).replace(/^schema:/i, "");
    if (name === "Product" || name === "ProductGroup") return true;
  }
  const ogType = page.parsed?.og?.type;
  return (
    typeof ogType === "string" &&
    /^(?:og:)?product(?:\.[a-z]{1,32})?$/i.test(ogType.trim())
  );
}

export function linksToCart(page: ProductEvidencePage): boolean {
  for (const link of page.parsed?.links ?? []) {
    if (!link.isInternal) continue;
    const path = pathOrNull(link.url);
    if (path && CART_PATH.test(path)) return true;
  }
  return false;
}
