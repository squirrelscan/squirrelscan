// A URL that redirected is a redirect, not a page (#1762).
//
// The crawler files a followed redirect under the requested URL with no body and the
// first hop's 3xx as its status: that row IS the marker (status 3xx, a resolved chain
// that ends elsewhere), so the engine reads it instead of re-deciding from URLs. Rows
// stored by an older crawl (or carried) still hold the destination's markup under a 2xx
// status; for those only, the URL pair is compared with the frontier's own
// path normalization, so the two sides agree on `/a` vs `/a/`, and a query-only change is
// never read as a redirect here.
//
// A redirect source stays in `site.pages` (flagged `redirectSource`) so the redirect rules
// still see its hops. It is out of the page-rule universe, the page totals and every
// content check.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";
import { normalizeUrl } from "@squirrelscan/crawler/frontier";
import type { ParsedPage } from "@squirrelscan/rules";

type RedirectRow = Pick<PageRecord, "status" | "normalizedUrl" | "finalUrl" | "redirectChain"> & {
  html?: string | null;
};

function pathKey(url: string, base: string): string | null {
  const normalized = normalizeUrl(url, { baseUrl: base, allowQueryParams: [], dropQueryPrefixes: [] });
  if (!normalized) return null;
  const parsed = new URL(normalized);
  return `${parsed.origin}${parsed.pathname}`;
}

/** The crawler's own marker: a 3xx row whose chain resolved to a landing page. */
function isRedirectRecord(page: RedirectRow): boolean {
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
 * URL is one it judged the same page (a stripped tracking parameter), so it must stay a page.
 */
function isLegacyRedirectRow(page: RedirectRow): boolean {
  if (page.status < 200 || page.status >= 300 || !page.html || !page.finalUrl) return false;
  const from = pathKey(page.normalizedUrl, page.normalizedUrl);
  const to = pathKey(page.finalUrl, page.normalizedUrl);
  return from !== null && to !== null && from !== to;
}

export function isRedirectSourcePage(page: RedirectRow): boolean {
  return isRedirectRecord(page) || isLegacyRedirectRow(page);
}

/** The status the redirecting URL itself answered with: its first hop's 3xx when the crawl saw one. */
export function redirectSourceStatus(page: Pick<PageRecord, "redirectChain">): number {
  const first = page.redirectChain?.hops[0];
  return first && first.type === "http" && first.statusCode >= 300 && first.statusCode < 400
    ? first.statusCode
    : 302;
}

/** The `site.pages` entry for a redirecting URL: hops and destination, no content. */
export function redirectSourceEntry(
  page: Pick<PageRecord, "normalizedUrl" | "finalUrl" | "status" | "redirectChain">,
  empty: ParsedPage,
): {
  url: string;
  finalUrl?: string;
  statusCode: number;
  parsed: ParsedPage;
  headers: Record<string, string>;
  redirectChain?: PageRecord["redirectChain"];
  redirectSource: true;
} {
  return {
    url: page.normalizedUrl,
    finalUrl: page.finalUrl,
    statusCode: page.status >= 300 && page.status < 400 ? page.status : redirectSourceStatus(page),
    // A copy: the runner writes soft-404 flags onto the parse it is handed.
    parsed: { ...empty },
    headers: {},
    redirectChain: page.redirectChain,
    redirectSource: true,
  };
}
