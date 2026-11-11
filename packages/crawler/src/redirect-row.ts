// What is a redirect row and what is a page (#1762). One definition for the crawler (page slots, cached
// rows, the page count) and the engine (the page universe, the report), so they never disagree on a row.
//
// The crawler files a followed redirect under the requested URL with no body and the first hop's 3xx
// as its status: that row IS the marker (status 3xx, a resolved chain that ends elsewhere). Rows stored
// by an older crawl (or carried) still hold the destination's markup under a 2xx status; for those
// only, the URL pair is compared with the frontier's own path normalization, so the two sides agree on
// `/a` vs `/a/`, and a query-only change is never read as a redirect here. A redirect the crawler
// followed and kept as a page on purpose (an out-of-scope destination) carries `redirectChain.keptAsPage`
// and is never read as a legacy redirect.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import { normalizeUrl } from "./frontier";

export type RedirectRow = Pick<PageRecord, "status" | "normalizedUrl" | "finalUrl" | "redirectChain"> & {
  html?: string | null;
  /**
   * A read without bodies (`getPagesWithoutBodies`) has `html` null whatever the row holds, but it still
   * has the content hash, which a stored body always has and a redirect marker row (no body) does not.
   */
  contentHash?: string | null;
};

/** The row holds a body: its markup, or the hash of the one the content store keeps. */
function hasBody(page: RedirectRow): boolean {
  return !!page.html || !!page.contentHash;
}

function pathKey(url: string, base: string): string | null {
  const normalized = normalizeUrl(url, { baseUrl: base, allowQueryParams: [], dropQueryPrefixes: [] });
  if (!normalized) return null;
  const parsed = new URL(normalized);
  return `${parsed.origin}${parsed.pathname}`;
}

/** The crawler's own marker: a 3xx row whose chain resolved to a landing page. */
export function isRedirectRecord(page: RedirectRow): boolean {
  if (page.status < 300 || page.status >= 400) return false;
  const chain = page.redirectChain;
  return (
    !!chain &&
    !chain.endsInError &&
    !chain.isLoop &&
    chain.hops.length > 1 &&
    !!page.finalUrl &&
    page.finalUrl !== page.normalizedUrl
  );
}

/**
 * A 2xx row from an older crawl that holds the destination's markup under the source URL.
 * Compared on origin and path with the slash kept, as the frontier does; the query is left out
 * because whether a parameter is stripped depends on the crawl's `allow_query_params`, which a
 * stored row does not carry. A row the current crawler stored as a 2xx with a different final
 * URL is one it judged the same page (a stripped tracking parameter), or one it kept as a page on
 * purpose because the destination is out of scope (`redirectChain.keptAsPage`), so it stays a page.
 */
export function isLegacyRedirectRow(page: RedirectRow): boolean {
  if (page.status < 200 || page.status >= 300 || !hasBody(page) || !page.finalUrl) return false;
  if (page.redirectChain?.keptAsPage) return false;
  const from = pathKey(page.normalizedUrl, page.normalizedUrl);
  const to = pathKey(page.finalUrl, page.normalizedUrl);
  return from !== null && to !== null && from !== to;
}

export function isRedirectSourcePage(page: RedirectRow): boolean {
  return isRedirectRecord(page) || isLegacyRedirectRow(page);
}
