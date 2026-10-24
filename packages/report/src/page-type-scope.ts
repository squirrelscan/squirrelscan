// Findings on every page of one page type say so (pub#857): the expected-schema check on a site
// with a documentation section reads "On all 9 documentation pages" instead of nine rows with the
// same template behind them. The page-type twin of region-scope.ts (pub#846): decided at report
// time from data the audit already stored, never from a per-page type table. A check names the
// page type it is about (`details.pageType`), and the report knows how many pages of each type it
// audited (`structure.pageTypes.counts`). Nothing here changes a finding, its severity or the score.

import type { ReportStructure } from "@squirrelscan/core-contracts";

import { pageTypePhrase, structureNumber } from "./structure";

/**
 * A check is shown as one finding on a page type when its pages are at least this share of the
 * audited pages of that type. The denominator is those pages, not every page, so a docs section
 * of nine pages with a finding on all nine reads "all 9" whatever else the site holds.
 */
export const PAGE_TYPE_SCOPE_MIN_SHARE = 0.8;

/** ...and on at least this many pages: a finding on one page reads better as that page. */
export const PAGE_TYPE_SCOPE_MIN_PAGES = 2;

/**
 * The `details.pageTypeSource` value that says the check's `details.pageType` is a label from the
 * page classifier's model, the same label space `structure.pageTypes` counts. Another rule's
 * `pageType` (a schema and URL based guess, `content/thin-vs-site-norm`) is a different label
 * space and never scopes a check.
 */
export const PAGE_TYPE_SCOPE_SOURCE = "model";

/** What the scope reads of a check: its details, and whether any of its pages are carried. */
export interface PageTypeScopeCheck {
  details?: Record<string, unknown>;
  carriedPages?: readonly string[];
  carriedCount?: number;
  provenance?: string;
}

export interface PageTypeScope {
  /** The page classifier's label, e.g. `docs`. */
  pageType: string;
  /** Pages the check is on. */
  pages: number;
  /** Audited pages of that type: the denominator. */
  typePages: number;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Audited pages the report counts under the label; 0 when it counts none or has no structure. */
function typePagesOf(structure: ReportStructure | undefined, label: string): number {
  const counts = structure?.pageTypes?.counts;
  if (!Array.isArray(counts)) return 0;
  return count(counts.find((row) => row?.label === label)?.pages);
}

/**
 * The page type a whole check is scoped to, or undefined to keep its page list. `pages` is how
 * many pages the check is on. A check is scoped when it names one classifier page type, is on at
 * least {@link PAGE_TYPE_SCOPE_MIN_PAGES} pages, and those pages are at least
 * {@link PAGE_TYPE_SCOPE_MIN_SHARE} of the audited pages of that type.
 *
 * Undefined, so the rows stay as they were, when: the check names no type, or one that is not the
 * classifier's; the report has no structure (a crawl stored before it existed, the classifier off)
 * or counts no page of the type; or the check is on MORE pages than the report counts of the type
 * (counts built from different data). Undefined too for a check with carried pages: findings kept
 * from earlier audits sit on pages this audit's counts do not cover. Never an "all" the numbers do
 * not back.
 */
export function checkPageTypeScope(
  check: PageTypeScopeCheck,
  pages: number,
  structure: ReportStructure | undefined,
): PageTypeScope | undefined {
  // Findings carried from earlier audits sit on pages this audit did not look at, so they are
  // not in `structure.pageTypes` and the share would compare two populations: never scoped.
  if (
    (check.carriedPages?.length ?? 0) > 0 ||
    (check.carriedCount ?? 0) > 0 ||
    check.provenance === "carried"
  ) {
    return undefined;
  }
  const details = check.details;
  if (!details || details.pageTypeSource !== PAGE_TYPE_SCOPE_SOURCE) return undefined;
  const pageType = details.pageType;
  // A label the report may print: plain lowercase words, as pageTypePhrase accepts.
  if (typeof pageType !== "string" || pageTypePhrase(pageType, 1) === undefined) return undefined;
  const affected = count(pages);
  if (affected < PAGE_TYPE_SCOPE_MIN_PAGES) return undefined;
  const typePages = typePagesOf(structure, pageType);
  if (typePages === 0 || affected > typePages) return undefined;
  if (affected / typePages < PAGE_TYPE_SCOPE_MIN_SHARE) return undefined;
  return { pageType, pages: affected, typePages };
}

/** "On all 9 documentation pages", or "On 9 of 11 documentation pages". */
export function pageTypeScopeLine(scope: PageTypeScope): string {
  const named = pageTypePhrase(scope.pageType, scope.typePages) ?? `${scope.typePages} pages`;
  return scope.pages === scope.typePages
    ? `On all ${named}`
    : `On ${structureNumber(scope.pages)} of ${named}`;
}

/** The scope as data for JSON and XML: `{ pageType, pages, typePages }`. */
export function pageTypeScopeData(scope: PageTypeScope): PageTypeScope {
  return { pageType: scope.pageType, pages: scope.pages, typePages: scope.typePages };
}
