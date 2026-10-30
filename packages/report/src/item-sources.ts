// The pages an item was found on, one row each (pub#837): the page, and what its links there add
// ("2 links, in the footer"). Every format renders these rows, so a broken link reads the same in
// each, and a cut list says how many pages it leaves out instead of pointing at a list elsewhere.

import {
  itemSourceDetail,
  type CheckItem,
  type LinkSectionCounts,
  type ReportStructure,
} from "@squirrelscan/core-contracts";

import type { PageTypeScopeCheck } from "./page-type-scope";
import { itemRegionScope, type RegionScope } from "./region-scope";

export interface ItemSourceRow {
  page: string;
  /** "2 links, in the footer"; "" when the page has nothing to add. */
  detail: string;
  /** Where the item sits on this page, when known. */
  sections?: LinkSectionCounts;
}

export interface ItemSourceList {
  /** Each page of `sourcePages` once, in its order. */
  rows: ItemSourceRow[];
  /** Pages the item was found on that the report does not list (`pageCount` past the rows). */
  unlisted: number;
}

/** The item's source pages as rows, each page once, with the detail its `sources` entry gives. */
export function itemSourceList(item: CheckItem): ItemSourceList {
  const sources = new Map((item.sources ?? []).map((source) => [source.page, source]));
  const rows = [...new Set(item.sourcePages ?? [])].map((page): ItemSourceRow => {
    const source = sources.get(page);
    return {
      page,
      detail: source ? itemSourceDetail(source) : "",
      ...(source?.sections ? { sections: source.sections } : {}),
    };
  });
  const total = item.pageCount;
  const unlisted =
    typeof total === "number" && Number.isFinite(total) && total > rows.length
      ? Math.floor(total) - rows.length
      : 0;
  return { rows, unlisted };
}

export interface ItemSourceView {
  /** The region the item is shown in (pub#846); `rows` are then its pages outside the region. */
  scope?: RegionScope;
  /** The rows a format lists. */
  rows: ItemSourceRow[];
  /** Pages those rows stand for, listed or not: a format says how many it leaves out from this. */
  total: number;
  /** Every listed row, for the collapsed full list HTML keeps under a scoped item. */
  all: ItemSourceRow[];
}

/**
 * What a format prints for an item's pages. Unscoped: every listed page, and the pages a capped
 * list leaves out. Scoped to a region: the region line comes from `scope`, and the rows are only
 * the listed pages the item is on outside the region (a page with no known section among them),
 * standing for `scope.otherPages`.
 */
export function itemSourceView(
  item: CheckItem,
  structure: ReportStructure | undefined,
  check?: PageTypeScopeCheck,
): ItemSourceView {
  const { rows, unlisted } = itemSourceList(item);
  const scope = itemRegionScope(item, structure, check);
  if (!scope) return { rows, total: rows.length + unlisted, all: rows };
  const outside = rows
    .filter((row) => !row.sections?.[scope.region])
    .slice(0, scope.otherPages);
  // The region line already counts the other pages; a "+N more" only follows rows it lists.
  const total = outside.length > 0 ? Math.max(scope.otherPages, outside.length) : 0;
  return { scope, rows: outside, total, all: rows };
}

/** "/about (2 links, in the footer)", or the page alone when it has nothing to add. */
export function sourceRowText(page: string, detail: string): string {
  return detail ? `${page} (${detail})` : page;
}

/** "+1 more page" / "+4 more pages". */
export function moreSourcePages(n: number): string {
  return `+${n} more ${n === 1 ? "page" : "pages"}`;
}

/** True when the check's items are links that say how they sit on each page. */
export function hasItemSources(check: { items?: CheckItem[] }): boolean {
  return check.items?.some((item) => (item.sources?.length ?? 0) > 0) ?? false;
}

/**
 * What follows a check's message: ", found on 3 pages" when its items are links found on pages,
 * so the summary keeps the links and the pages apart; " (3 pages)" for other checks on more than
 * one page; "" otherwise.
 */
export function affectedPagesSuffix(check: { items?: CheckItem[] }, count: number): string {
  if (hasItemSources(check) && count > 0) return `, found on ${count} ${count === 1 ? "page" : "pages"}`;
  return count > 1 ? ` (${count} pages)` : "";
}
