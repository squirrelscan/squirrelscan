// A URL that redirected is a redirect, not a page (#1762). The predicates live in the crawler
// (`@squirrelscan/crawler/redirect-row`), shared with its page slots and page count.
//
// A redirect source stays in `site.pages` (flagged `redirectSource`) so the redirect rules
// still see its hops. It is out of the page-rule universe, the page totals and every
// content check.

import type { RedirectRow as RedirectRow_ } from "@squirrelscan/core-contracts";
import { RESOLUTION_SIGNAL_LIMITS } from "@squirrelscan/core-contracts/limits";
import type { PageRecord } from "@squirrelscan/core-contracts/storage";
import type { ParsedPage } from "@squirrelscan/rules";

import { isRedirectSourcePage } from "@squirrelscan/crawler/redirect-row";

export { isRedirectSourcePage };

/** A stored page as the redirect predicate reads it. */
type RedirectRow = Parameters<typeof isRedirectSourcePage>[0];

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

/**
 * Where a redirect source page lands, as evidence for the findings that resolve on it (#1759): the status
 * its own URL answered and the destination, or null when the page is not a redirect row.
 */
export function pageRedirectEvidence(
  page: RedirectRow,
): { status: number; to: string } | null {
  if (!page.finalUrl || !isRedirectSourcePage(page)) return null;
  return { status: redirectSourceEntry(page, {} as ParsedPage).statusCode, to: page.finalUrl };
}

/**
 * Collects the crawl's redirect rows for the report's transport fields (#1759), at most RESOLUTION_SIGNAL_LIMITS.maxRedirects
 * of them, counting every one. Call `note` for each stored page in the walk that already tests `isRedirectSourcePage`.
 */
export function createRedirectCollector(): {
  note(page: RedirectRow): void;
  fields(): { redirectedPages?: RedirectRow_[]; redirectedPagesTotal?: number };
} {
  const rows: RedirectRow_[] = [];
  let total = 0;
  return {
    note(page) {
      const evidence = pageRedirectEvidence(page);
      if (!evidence) return;
      total += 1;
      if (rows.length < RESOLUTION_SIGNAL_LIMITS.maxRedirects) {
        rows.push({
          url: page.normalizedUrl,
          finalUrl: evidence.to,
          status: evidence.status,
          hops: Math.max(1, (page.redirectChain?.hops.length ?? 2) - 1),
        });
      }
    },
    fields: () =>
      total === 0
        ? {}
        : { redirectedPages: rows, ...(total > rows.length ? { redirectedPagesTotal: total } : {}) },
  };
}
