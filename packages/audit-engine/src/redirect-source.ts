// A URL that redirected is a redirect, not a page (#1762). The predicates live in the crawler
// (`@squirrelscan/crawler/redirect-row`), shared with its page slots and page count.
//
// A redirect source stays in `site.pages` (flagged `redirectSource`) so the redirect rules
// still see its hops. It is out of the page-rule universe, the page totals and every
// content check.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";
import type { ParsedPage } from "@squirrelscan/rules";

export { isRedirectSourcePage } from "@squirrelscan/crawler/redirect-row";

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
