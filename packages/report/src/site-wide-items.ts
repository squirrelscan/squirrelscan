// Collapsing items that are the SAME resource on nearly every page.
//
// A survey of 1,148 real reports found that most collapsible output is not a
// DOM component at all: it is one shared resource or one global style repeated
// site-wide. a11y/color-contrast alone accounted for 17.8k of 20.3k collapsible
// lines, and on 75% of the sites it affected it was site-wide;
// perf/critical-request-chains 13.6k of 14.9k at 95%. The item id is ALREADY a
// site-wide key there (a script URL, a colour pair, an image src), so no DOM
// evidence is needed to say "this is one thing, not forty".
//
// This is presentation only. Detections, statuses, scores and stored data are
// untouched, every item and page stays in the JSON, and the JSON gains a
// machine-readable `siteWide` flag so an agent gets the same collapse without
// re-deriving the threshold.

import type { CheckItem } from "./types";

/**
 * An item must appear on at least this FRACTION of the audited pages to be
 * called site-wide. 0.8 keeps the claim honest on sites with a handful of
 * template-less pages (a standalone landing page, a print stylesheet) while
 * still collapsing the shared-resource case the survey found dominant.
 */
export const SITE_WIDE_MIN_PAGE_RATIO = 0.8;

/**
 * ...and on at least this many pages. A ratio alone would call an item
 * site-wide on a 2-page audit, where "both pages" is not evidence of anything.
 */
export const SITE_WIDE_MIN_PAGES = 3;

/** Name the pages an otherwise site-wide item misses, up to this many. */
export const SITE_WIDE_MAX_EXCEPTIONS = 3;

export interface SiteWideItem {
  /** Pages this item appears on. */
  pages: number;
  /** Pages the audit covers. */
  of: number;
  /**
   * Audited pages where the item is absent, when the report carries a complete
   * page list and there are few enough of them to name. Empty otherwise: an
   * incomplete list would name the wrong pages, which is worse than naming none.
   */
  missing: string[];
}

/** The page list a report carries, when it carries one. */
interface PageListCarrier {
  pages?: Array<{ url?: string }>;
  totalPages?: number;
  coverage?: { knownPages?: number };
}

/**
 * The denominator for "site-wide".
 *
 * `coverage.knownPages` when a smart audit supplied it, else `totalPages`.
 * Known pages is the SITE, while `totalPages` is what this run crawled: on a
 * partial re-audit the item's `sourcePages` union spans both fresh and carried
 * findings, so dividing by the smaller crawled count would overstate reach and
 * call a ten-page sample "site-wide". Choosing the larger denominator can only
 * make the claim harder to earn, which is the right direction for a claim this
 * assertive.
 */
export function auditedPageTotal(report: unknown): number {
  const carrier = report as PageListCarrier;
  const known = carrier.coverage?.knownPages;
  if (typeof known === "number" && known > 0) return known;
  return typeof carrier.totalPages === "number" ? carrier.totalPages : 0;
}

/** Every audited page URL, when the report carries a complete list. */
function auditedPageUrls(report: unknown, total: number): string[] | undefined {
  const carrier = report as PageListCarrier;
  const urls = carrier.pages
    ?.map((page) => page.url)
    .filter((url): url is string => typeof url === "string");
  // A list that does not match the denominator is not a list of the audited
  // pages (a reimported slim report carries `pages: []`), so it is not used.
  return urls && urls.length === total ? urls : undefined;
}

/**
 * Whether `item` is the same thing on effectively every audited page.
 *
 * Returns undefined when it is not, so callers render it exactly as before.
 */
export function siteWideItem(
  item: CheckItem,
  total: number,
  pageUrls?: string[],
): SiteWideItem | undefined {
  const sourcePages = item.sourcePages;
  if (!sourcePages || total < SITE_WIDE_MIN_PAGES) return undefined;
  // A link that says how it sits on each page (pub#837) is presented by its own rows, or by one
  // region line when it sits in a shared region (pub#846). Collapsing it as well would drop the
  // sections those say, so it is never site-wide here.
  if ((item.sources?.length ?? 0) > 0) return undefined;
  const pages = new Set(sourcePages);
  if (pages.size < SITE_WIDE_MIN_PAGES) return undefined;
  if (pages.size < total * SITE_WIDE_MIN_PAGE_RATIO) return undefined;

  const absent = pageUrls?.filter((url) => !pages.has(url)) ?? [];
  return {
    pages: pages.size,
    of: total,
    missing: absent.length > 0 && absent.length <= SITE_WIDE_MAX_EXCEPTIONS ? absent : [],
  };
}

/**
 * `Site-wide (41 of 45 pages): <label>` with no page list, which is the whole
 * point: the list was the noise.
 */
export function formatSiteWideItem(
  label: string,
  info: SiteWideItem,
  format: (page: string) => string,
): string {
  const head = `Site-wide (${info.pages} of ${info.of} pages): ${label}`;
  if (info.missing.length === 0) return head;
  return `${head} (except: ${info.missing.map(format).join(", ")})`;
}

/**
 * Report-scoped helper so each renderer resolves the denominator once.
 *
 * `enabled: false` reports a zero denominator, which makes every item fall
 * below {@link SITE_WIDE_MIN_PAGES} and so renders exactly as it did before
 * this feature. That is the opt-out behind `siteWideCollapse: false`, and it is
 * what the corpus survey measures "before" with.
 */
export function siteWideContext(
  report: unknown,
  enabled = true,
): {
  total: number;
  pageUrls?: string[];
} {
  if (!enabled) return { total: 0 };
  const total = auditedPageTotal(report);
  return { total, pageUrls: auditedPageUrls(report, total) };
}
