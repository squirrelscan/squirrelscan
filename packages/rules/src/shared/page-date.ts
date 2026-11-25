// A page's own date signal, as sitemap-lastmod-drift compares it with the sitemap's lastmod.
// Reads parsed-page scalars only, never `parsed.document`.

import { flattenJsonLdNodes } from "@squirrelscan/utils";
import { datePeriod, type DatePeriod } from "@squirrelscan/utils/date-period";

import type { ParsedPage } from "../types";

import {
  documentTypes,
  isArticleType,
  schemaDateString,
} from "./schema-document";

/** Where a page's own date came from — reported so a fix targets the right markup. */
export type DateSource = "schema" | "meta" | "visible";

interface PageDate {
  value: string;
  /** The period the value names (#772): a `dateModified` of `2024` is that whole year. */
  period: DatePeriod;
  source: DateSource;
}

const isUsableDate = (value: string): boolean => datePeriod(value) !== null;

/**
 * The `dateModified` of the JSON-LD node that describes THIS DOCUMENT.
 *
 * Nodes for things the page merely mentions are ignored: a sitewide
 * `WebSite`/`Organization` node carries its own stale `dateModified`, and Yoast
 * and Rank Math emit it FIRST in `@graph`, ahead of the `Article`. Reading the
 * first dated node made the verdict depend on `@graph` order — the same trap
 * `content/date-agreement` guards with the shared `documentTypes` (#1570).
 *
 * Selection is position-independent: an Article-family node wins wherever it
 * sits, since the post's own node speaks for the content, and a node claiming
 * both (`["WebPage", "BlogPosting"]`) counts as the article whichever half was
 * written first. Among nodes of one kind the first with a USABLE `dateModified`
 * wins; unparseable values are skipped while scanning rather than returned, so a
 * malformed date cannot hide a good one later in the graph or later in the same
 * node's date list. When no document node carries a usable date the answer is
 * null, and the caller falls through to the page's own visible date signals
 * rather than borrowing a sitewide one.
 */
function schemaDateModified(parsed: ParsedPage): string | null {
  if (!parsed.schema?.raw) return null;
  let pageLevel: string | null = null;
  // Flattened nodes include @graph children — a top-level-only read misses every
  // date on Yoast-style sites (same reason eeat/content-dates flattens).
  for (const node of flattenJsonLdNodes(parsed.schema.raw)) {
    const types = documentTypes(node);
    if (types.length === 0) continue;
    const value = schemaDateString(node["dateModified"], isUsableDate);
    if (!value) continue;
    if (types.some(isArticleType)) return value;
    pageLevel ??= value;
  }
  return pageLevel;
}

/**
 * The page's strongest own date signal: the document node's schema
 * `dateModified`, else the `dateModified`-equivalent markup the parser lifts from
 * `[itemprop=dateModified]` meta/`<time>` (`visibleDateModified`), else the
 * visible published date.
 *
 * Only parsed-page SCALARS are read — never `parsed.document` — so the rule sees
 * the same input on the legacy path and on the streaming path, where
 * every DOM has been dropped before site rules run.
 */
function resolvePageDate(parsed: ParsedPage): PageDate | null {
  const candidates: Array<{
    value: string | null | undefined;
    source: DateSource;
  }> = [
    { value: schemaDateModified(parsed), source: "schema" },
    { value: parsed.visibleDateModified, source: "meta" },
    { value: parsed.visibleDatePublished, source: "visible" },
  ];

  for (const candidate of candidates) {
    const value = candidate.value?.trim();
    const period = datePeriod(value);
    if (value && period !== null)
      return { value, period, source: candidate.source };
  }
  return null;
}

/** The page's own date as the view stores it: the value and where it came from. */
export function pagePrimaryDate(
  parsed: ParsedPage
): { value: string; source: DateSource } | null {
  const date = resolvePageDate(parsed);
  return date ? { value: date.value, source: date.source } : null;
}
