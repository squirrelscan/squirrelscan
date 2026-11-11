// Pages with open findings: re-verified this run or left carried, and why (#1759).
//
// A smart audit carries the open findings of every page it did not fetch. Those pages are of
// two kinds a reader must not confuse: pages the crawl knew of and did not reach (the page
// budget or time ran out), and pages the crawl never found a way to (unlinked, moved, gone from
// the sitemap). Only the crawl's frontier tells them apart, so the caller supplies how far each
// carried page got through it.

import type { OpenPageCoverage } from "@squirrelscan/core-contracts";

/**
 * How far a carried page got in this crawl: `pending` was queued and never fetched, `other` has a
 * frontier row that ended failed, skipped or in flight, `unseen` has no row at all.
 */
export type FrontierReach = "pending" | "other" | "unseen";

/** Carried pages a store counted without listing them (the cloud's untouched aggregate). */
export interface UntouchedPageCounts {
  pages: number;
  /** Of those, the ones the crawl queued and did not fetch; absent when the store could not tell. */
  pending?: number;
  /** Of those, the ones the crawl found and failed or skipped; absent when the store could not tell. */
  notFetched?: number;
}

export interface OpenPageCoverageInput {
  /** Pages with open findings this run re-fetched. */
  reverified: number;
  /** Pages with open findings this run left alone, listed. */
  carried: Iterable<string>;
  /** More carried pages, counted but not listed. */
  untouched?: UntouchedPageCounts;
  /** How far a listed carried page got through the crawl; absent when the frontier is not known. */
  reach?: (normalizedUrl: string) => FrontierReach;
}

/**
 * The `coverage.openPages` figure, or undefined when no known page held an open finding (a first
 * run, or a site with nothing open). The split of `carried` is present only when the caller could
 * read the frontier for every carried page.
 */
export function summarizeOpenPages(input: OpenPageCoverageInput): OpenPageCoverage | undefined {
  let carried = 0;
  let listed = 0;
  let pending = 0;
  let other = 0;
  let unseen = 0;
  let splitKnown = true;
  for (const url of input.carried) {
    carried += 1;
    listed += 1;
    const reach = input.reach?.(url);
    if (reach === "pending") pending += 1;
    else if (reach === "other") other += 1;
    else if (reach === "unseen") unseen += 1;
  }
  const untouched = input.untouched;
  if (untouched) {
    carried += untouched.pages;
    if (untouched.pending === undefined || untouched.notFetched === undefined) splitKnown = false;
    else {
      pending += untouched.pending;
      other += untouched.notFetched;
      unseen += untouched.pages - untouched.pending - untouched.notFetched;
    }
  }
  if (input.reverified + carried === 0) return undefined;
  const base = { reverified: input.reverified, carried };
  // A split that leaves some carried pages unaccounted for would read as a count of all of them.
  if (carried === 0 || !splitKnown || (listed > 0 && !input.reach)) return base;
  return {
    ...base,
    ...(pending > 0 ? { skippedByBudget: pending } : {}),
    ...(unseen > 0 ? { noLongerLinked: unseen } : {}),
    ...(other > 0 ? { notFetched: other } : {}),
  };
}
