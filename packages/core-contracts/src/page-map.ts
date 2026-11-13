// Page map (#701, hosted half squirrelscan/repo#4172): one row per crawled page of an audit.
//
// The CLI's `squirrel pages` and the local MCP `list_pages` build these rows from the project
// store. The published copy of a report carries them as an optional `pageMap` section, so the
// hosted API and MCP can list pages of a stored report without re-crawling or spending credits.
//
// Every value here comes from audited pages, so it is UNTRUSTED text: escape before rendering.
// TypeBox, not zod, for the same reason as `./entity-map`: one schema both zod majors can use.
// Validate with `Value.Check(PageMapSchema, doc)` from `@sinclair/typebox/value`.

import { Type, type Static } from "@sinclair/typebox";

/** Discriminator written into every published page map. */
export const PAGE_MAP_FORMAT = "squirrelscan/page-map";

/** Schema version. Bump on a change that makes an already-stored map unreadable. */
export const PAGE_MAP_VERSION = 1;

/**
 * Caps on the page map that rides the publish body.
 *
 * The local map is uncapped (a file on disk costs nothing). The hosted copy keeps the first
 * `maxRows` pages, ordered by depth then URL, and says so with `truncated: true` plus the stored
 * and total counts. The strings are site-controlled, so each is clipped to `maxStringLength`;
 * the whole report is still fitted to the publish budget by `capReportForPublish`, which drops
 * the map (stamping `detail.pageMapDropped`) if the body would not fit.
 */
export const PAGE_MAP_PUBLISH_LIMITS = {
  /** Most rows kept in the published copy, whatever the plan's page ceiling. */
  maxRows: 1000,
  /** Longest any single string in a row may be. */
  maxStringLength: 512,
  /** Most entries kept in a row's list fields (`schemaTypes`, `schemaIds`, `externalDomains`, `flags`). */
  maxListItems: 20,
} as const;

const Str = Type.String({ maxLength: PAGE_MAP_PUBLISH_LIMITS.maxStringLength });
const NullableStr = Type.Union([Str, Type.Null()]);
const List = Type.Array(Str, { maxItems: PAGE_MAP_PUBLISH_LIMITS.maxListItems });
const Count = Type.Integer({ minimum: 0 });
const NullableCount = Type.Union([Count, Type.Null()]);

/**
 * One crawled page, failed pages included. Matches the local `PageMapRow` of
 * `@squirrelscan/report` field for field.
 */
export const PageMapRowSchema = Type.Object({
  url: Str,
  finalUrl: Str,
  status: Type.Integer(),
  depth: Count,
  canonical: NullableStr,
  noindex: Type.Boolean(),
  title: NullableStr,
  titleLength: Count,
  description: NullableStr,
  descriptionLength: Count,
  h1Count: NullableCount,
  h1: NullableStr,
  headingCount: NullableCount,
  wordCount: NullableCount,
  schemaTypes: List,
  schemaIds: List,
  /** Distinct crawled pages linking here, self links excluded. 0 is an orphan in this audit's crawl graph. */
  inlinks: Count,
  internalOutlinks: Count,
  externalOutlinks: Count,
  externalDomains: List,
  loadTimeMs: NullableCount,
  lastModified: NullableStr,
  flags: List,
});

export type PageMapPublishedRow = Static<typeof PageMapRowSchema>;

export const PageMapSchema = Type.Object({
  format: Type.Literal(PAGE_MAP_FORMAT),
  version: Type.Literal(PAGE_MAP_VERSION),
  /** Site the audit started from. */
  site: Type.String(),
  /** ISO-8601 timestamp. */
  generatedAt: Type.String(),
  /** Pages in the audit. */
  total: Count,
  /** Rows in `pages`. Less than `total` exactly when `truncated`. */
  stored: Count,
  /** True when `pages` is the first `stored` of `total` rows, not the whole crawl. */
  truncated: Type.Boolean(),
  pages: Type.Array(PageMapRowSchema, { maxItems: PAGE_MAP_PUBLISH_LIMITS.maxRows }),
});

export type PageMap = Static<typeof PageMapSchema>;
