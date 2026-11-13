// The published page map (#701, repo#4172): the local page rows as the bounded `pageMap`
// section of a published report. Pure: it reads rows already built from the project store (or
// the cloud crawl), so it costs no request and no credit.

import {
  PAGE_MAP_FORMAT,
  PAGE_MAP_PUBLISH_LIMITS,
  PAGE_MAP_VERSION,
  type PageMap,
  type PageMapPublishedRow,
} from "@squirrelscan/core-contracts";

import type { PageMapRow } from "./page-map";

const LIMITS = PAGE_MAP_PUBLISH_LIMITS;

/** `value` cut to `max` UTF-16 units, never inside a surrogate pair. */
function clip(value: string): string {
  if (value.length <= LIMITS.maxStringLength) return value;
  let end = LIMITS.maxStringLength;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

const clipOrNull = (value: string | null | undefined): string | null =>
  typeof value === "string" ? clip(value) : null;

const clipList = (list: readonly string[] | undefined): string[] =>
  (list ?? []).slice(0, LIMITS.maxListItems).map(clip);

const count = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;

const countOr0 = (value: number | null | undefined): number => count(value) ?? 0;

/** One row at its publish bound: strings clipped, lists cut, counts whole and non-negative. */
export function publishPageMapRow(row: PageMapRow): PageMapPublishedRow {
  return {
    url: clip(row.url),
    finalUrl: clip(row.finalUrl || row.url),
    status: Number.isInteger(row.status) ? row.status : 0,
    depth: countOr0(row.depth),
    canonical: clipOrNull(row.canonical),
    noindex: row.noindex === true,
    title: clipOrNull(row.title),
    titleLength: countOr0(row.titleLength),
    description: clipOrNull(row.description),
    descriptionLength: countOr0(row.descriptionLength),
    h1Count: count(row.h1Count),
    h1: clipOrNull(row.h1),
    headingCount: count(row.headingCount),
    wordCount: count(row.wordCount),
    schemaTypes: clipList(row.schemaTypes),
    schemaIds: clipList(row.schemaIds),
    inlinks: countOr0(row.inlinks),
    internalOutlinks: countOr0(row.internalOutlinks),
    externalOutlinks: countOr0(row.externalOutlinks),
    externalDomains: clipList(row.externalDomains),
    loadTimeMs: count(row.loadTimeMs),
    lastModified: clipOrNull(row.lastModified),
    flags: clipList(row.flags),
  };
}

/**
 * The page map for a report: every row of the audit (failed pages included) ordered by depth,
 * then URL, cut to {@link PAGE_MAP_PUBLISH_LIMITS}`.maxRows`. `total` counts the audit's pages
 * and `stored` the rows kept; `truncated` is true exactly when they differ. Null for an audit
 * with no pages, which has nothing to list.
 */
export function buildPageMap(
  rows: readonly PageMapRow[],
  meta: { site: string; generatedAt?: Date },
): PageMap | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(
    (a, b) => a.depth - b.depth || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  const kept = ordered.slice(0, LIMITS.maxRows).map(publishPageMapRow);
  return {
    format: PAGE_MAP_FORMAT,
    version: PAGE_MAP_VERSION,
    site: meta.site,
    generatedAt: (meta.generatedAt ?? new Date()).toISOString(),
    total: rows.length,
    stored: kept.length,
    truncated: kept.length < rows.length,
    pages: kept,
  };
}

/**
 * A map from a producer, brought back to its publish bound. The capper calls this and never
 * trusts the producer's own counts: rows are re-clipped and recounted, and `total` can only be
 * raised to the rows present, never lowered.
 */
export function projectPageMap(map: PageMap): PageMap {
  const kept = map.pages.slice(0, LIMITS.maxRows).map((row) => publishPageMapRow(row as PageMapRow));
  const total = Math.max(countOr0(map.total), map.pages.length);
  return {
    format: PAGE_MAP_FORMAT,
    version: PAGE_MAP_VERSION,
    site: map.site,
    generatedAt: map.generatedAt,
    total,
    stored: kept.length,
    truncated: kept.length < total,
    pages: kept,
  };
}
