// Serialization codec for shared site-resource evidence (#2341).
//
// Same problem as `component-evidence`, in a different shape. The in-memory
// `SiteResourceOccurrence` is self-contained: every observation repeats its
// kind, its origin, its page URL and the map URL. On a template site that is
// exactly what repeats — one build's 4 maps across 87 pages is 348 records
// carrying 87 copies of each map URL and 4 copies of each page URL, most of it
// long cache-busted asset paths.
//
// So the contract stays as it is and only the WIRE form is hoisted. Every
// repeating string becomes a per-check table and an occurrence is a tuple of
// indices into them. Tuples rather than objects because this is the densest
// JSON available and the layout is versioned anyway: a 348-record blob drops
// from tens of kilobytes to a handful.
//
// This is the only place that knows the packed layout. Every writer (the SQLite
// column, the finding payload, the CLI JSON) and every reader (rowToCheckResult,
// reconstructRuleChecks, carriedFindingToCheck, convertSlimReport) goes through
// these two functions.

import type { SiteResourceOccurrence } from "./index";

/** Bumped when the packed layout changes in a way a reader must notice. */
export const SITE_RESOURCE_EVIDENCE_FORMAT = 1;
const READABLE_FORMATS = new Set([SITE_RESOURCE_EVIDENCE_FORMAT]);

/** `[kind, origin, page, key, source]`, each an index into its table. */
export type PackedSiteResourceOccurrence = [number, number, number, number, number];

export interface PackedSiteResourceEvidence {
  v: number;
  kinds: string[];
  origins: string[];
  pages: string[];
  keys: string[];
  sources: string[];
  occurrences: PackedSiteResourceOccurrence[];
}

/** Append-if-absent, returning the index. One table, one pass. */
function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  index.set(value, next);
  table.push(value);
  return next;
}

export function packSiteResourceOccurrences(
  occurrences: readonly SiteResourceOccurrence[],
): PackedSiteResourceEvidence {
  const kinds: string[] = [];
  const origins: string[] = [];
  const pages: string[] = [];
  const keys: string[] = [];
  const sources: string[] = [];
  const kindIndex = new Map<string, number>();
  const originIndex = new Map<string, number>();
  const pageIndex = new Map<string, number>();
  const keyIndex = new Map<string, number>();
  const sourceIndex = new Map<string, number>();

  const packed = occurrences.map(
    (occurrence): PackedSiteResourceOccurrence => [
      intern(kinds, kindIndex, occurrence.kind),
      intern(origins, originIndex, occurrence.siteOrigin),
      intern(pages, pageIndex, occurrence.pageUrl),
      intern(keys, keyIndex, occurrence.key),
      intern(sources, sourceIndex, occurrence.source),
    ],
  );

  return {
    v: SITE_RESOURCE_EVIDENCE_FORMAT,
    kinds,
    origins,
    pages,
    keys,
    sources,
    occurrences: packed,
  };
}

function isPacked(value: unknown): value is PackedSiteResourceEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedSiteResourceEvidence>;
  if (typeof candidate.v === "number" && !READABLE_FORMATS.has(candidate.v)) return false;
  return (
    Array.isArray(candidate.occurrences) &&
    Array.isArray(candidate.keys) &&
    Array.isArray(candidate.pages)
  );
}

/**
 * Rebuild full occurrences from either form.
 *
 * Tolerates a plain array of complete occurrences — the un-hoisted layout a
 * store written before this codec holds — so an existing audit still reads. A
 * tuple whose index does not resolve is SKIPPED rather than rehydrated with a
 * placeholder: a half-resolved occurrence would claim a page or a map URL that
 * nothing observed, and the grouping keys on exactly those two fields. An
 * unrecognized value yields `undefined` rather than throwing, because evidence
 * is additive and a malformed blob must never take its finding down with it.
 */
export function unpackSiteResourceOccurrences(
  value: unknown,
): SiteResourceOccurrence[] | undefined {
  if (value === null || value === undefined) return undefined;

  // Legacy / un-hoisted: already complete occurrences.
  if (Array.isArray(value)) {
    return value.length > 0 ? (value as SiteResourceOccurrence[]) : undefined;
  }
  if (!isPacked(value)) return undefined;

  const out: SiteResourceOccurrence[] = [];
  for (const row of value.occurrences) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const kind = value.kinds[row[0]];
    const siteOrigin = value.origins[row[1]];
    const pageUrl = value.pages[row[2]];
    const key = value.keys[row[3]];
    const source = value.sources[row[4]];
    if (
      kind === undefined ||
      siteOrigin === undefined ||
      pageUrl === undefined ||
      key === undefined ||
      source === undefined
    ) {
      continue;
    }
    out.push({
      kind: kind as SiteResourceOccurrence["kind"],
      key,
      pageUrl,
      source,
      siteOrigin,
    });
  }
  return out.length > 0 ? out : undefined;
}
