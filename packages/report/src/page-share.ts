// Page share of a collapsed finding (repo#1885).
//
// Collapse never gates on a chrome threshold: a Shopify footer script lands on 50 to 79% of
// pages because product, collection and blog pages use different templates. The share is a
// LABEL only, so it can never change which findings exist or the health score.

export type PageShareLabel =
  | "site-wide"
  | "template"
  | "some pages"
  | "single page";

/** Share at or above which a finding reads as site-wide. */
export const PAGE_SHARE_SITE_WIDE = 0.9;
/** Share at or above which a finding reads as template-level. */
export const PAGE_SHARE_TEMPLATE = 0.5;

export interface PageShare {
  affectedPageCount: number;
  crawledPages: number;
  /** affectedPageCount / crawledPages, clamped to 0..1; 0 when nothing was crawled. */
  pageShare: number;
  label: PageShareLabel;
}

/** `pageShare = affectedPageCount / crawledPages`, with its label. One page is always "single page". */
export function pageShare(
  affectedPageCount: number,
  crawledPages: number
): PageShare {
  const affected = Math.max(0, Math.floor(affectedPageCount));
  const crawled = Math.max(0, Math.floor(crawledPages));
  const share = crawled > 0 ? Math.min(1, affected / crawled) : 0;
  let label: PageShareLabel;
  if (affected <= 1) label = "single page";
  else if (share >= PAGE_SHARE_SITE_WIDE) label = "site-wide";
  else if (share >= PAGE_SHARE_TEMPLATE) label = "template";
  else label = "some pages";
  return {
    affectedPageCount: affected,
    crawledPages: crawled,
    pageShare: share,
    label,
  };
}

/**
 * The page share a fix-once unit carries (repo#1885), set when the unit is built so every renderer and
 * the JSON report read one value instead of each recomputing it. `share` is the ratio, for machines;
 * the human reports print only `label`.
 */
export interface UnitPageShare {
  /** affectedPageCount / crawledPages, clamped to 0..1. */
  share: number;
  label: PageShareLabel;
  /** The crawl size the share is of. */
  crawledPages: number;
}

/** A unit's page share, or undefined when the crawl size is unknown (an older or bare report). */
export function unitPageShare(
  affectedPageCount: number,
  crawledPages: number | undefined
): UnitPageShare | undefined {
  if (crawledPages === undefined || !(crawledPages > 0)) return undefined;
  const result = pageShare(affectedPageCount, crawledPages);
  if (result.crawledPages <= 0) return undefined;
  return {
    share: result.pageShare,
    label: result.label,
    crawledPages: result.crawledPages,
  };
}

/** " (template)" for a unit's carried share; "" when it carries none, so the line reads as it always did. */
export function pageShareSuffix(share: UnitPageShare | undefined): string {
  return share ? ` (${share.label})` : "";
}

/**
 * The tag a fix-once line ends with: " (site-wide)", " (template)", " (some pages)". A label, never a
 * raw ratio. "" when the crawl size is unknown, so a caller without it prints the line it always did.
 */
export function pageShareTag(
  affectedPageCount: number,
  crawledPages: number | undefined
): string {
  return pageShareSuffix(unitPageShare(affectedPageCount, crawledPages));
}
