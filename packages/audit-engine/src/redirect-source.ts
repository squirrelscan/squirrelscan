// A URL that redirected is a redirect, not a page (#1762).
//
// The crawler files a followed redirect under the requested URL and stores no body for
// it: the content belongs to the destination, which is crawled and audited as itself.
// A page stored by an older crawl (or a carried one) may still hold the destination's
// markup under the source URL, so the test here reads only the URL pair, never the body.
//
// A redirect source stays in `site.pages` so the redirect rules still see its hops, with
// its first hop's 3xx as status so no site rule reads it as a page that answered. It is
// out of the page-rule universe, the page totals and every content check.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";
import type { ParsedPage } from "@squirrelscan/rules";
import { landedElsewhere } from "@squirrelscan/utils/url";

/** A 2xx that landed on a different URL. A 4xx/5xx is an error page, a stored 3xx a redirect that never resolved. */
export function isRedirectSourcePage(
  page: Pick<PageRecord, "status" | "normalizedUrl" | "finalUrl">,
): boolean {
  return page.status >= 200 && page.status < 300 && landedElsewhere(page.normalizedUrl, page.finalUrl);
}

/** The status the redirecting URL itself answered with: its first hop's 3xx when the crawl saw one. */
export function redirectSourceStatus(page: Pick<PageRecord, "status" | "redirectChain">): number {
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
} {
  return {
    url: page.normalizedUrl,
    finalUrl: page.finalUrl,
    statusCode: redirectSourceStatus(page),
    // A copy: the runner writes soft-404 flags onto the parse it is handed.
    parsed: { ...empty },
    headers: {},
    redirectChain: page.redirectChain,
  };
}
