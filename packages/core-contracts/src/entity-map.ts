// Structured entity map (#2061/#2091) — the graph of things a site declares in
// JSON-LD, collapsed across every page of one audit.
//
// One document per audit. The engine builds it, the CLI stores it and embeds it
// in every report format, and the cloud stores the published copy. The schema
// lives here so the CLI, the engine, the API and the dashboard read one type.
//
// TypeBox, not zod, and deliberately: this package is consumed by the private
// API on zod 3 and by the CLI and rules on zod 4, which install as two separate
// copies, so a zod schema here could not be composed on either side. TypeBox is
// already this package's schema library and has no such split. Validate with
// `Value.Check(EntityMapSchema, doc)` from `@sinclair/typebox/value`.
//
// Everything in this document is derived from JSON-LD on audited pages, i.e.
// from UNTRUSTED input: type names, property values and `@id`s are attacker
// controlled. Consumers must escape before rendering and must never bracket-copy
// a type name onto a plain `{}` (see ./untrusted-keys).

import { Type, type Static } from "@sinclair/typebox";

/** Discriminator written into every entity-map document. */
export const ENTITY_MAP_FORMAT = "squirrelscan/entity-map";

/**
 * Schema version. Bump on any change that makes an ALREADY-STORED document
 * invalid, which a new required field does.
 *
 * Additive required fields were fine while nothing was persisted. Once the
 * cloud writes published maps to R2 (#2099) they are v1 documents in the wild
 * with no migration path, and the API re-validates stored bytes on every read
 * rather than casting — so an invalidating change without a bump turns every
 * older report's entity endpoints into a 404.
 */
export const ENTITY_MAP_VERSION = 1;

/**
 * Predicates the builder follows when linking one node to another.
 *
 * Only these produce edges; every other property stays a plain value. A
 * predicate fires on a nested object with an `@type` (that object becomes its
 * own node) or on an explicit `{"@id": …}` reference.
 */
export const ENTITY_MAP_PREDICATES = [
  "about",
  "author",
  "brand",
  "creator",
  "hasPart",
  "image",
  "isPartOf",
  "itemListElement",
  "itemReviewed",
  "logo",
  "mainEntity",
  "mainEntityOfPage",
  "member",
  "mentions",
  "offers",
  "provider",
  "publisher",
  "review",
  "sameAs",
  "subjectOf",
  "worksFor",
] as const;

export type EntityMapPredicate = (typeof ENTITY_MAP_PREDICATES)[number];

/**
 * Types that describe one page rather than a thing the site is about.
 *
 * A 60-page site emits one BreadcrumbList and one WebPage per page and a
 * Question per FAQ entry, so these outnumber the Organization and Person nodes
 * the map exists to show: on squirrelscan.com they are 233 of 363 entities. The
 * builder tags them and the viewer hides them by default.
 *
 * An ImageObject joins them only when it has no name, since an unnamed image is
 * a URL rather than an entity a reader can reason about. That check needs the
 * node, so it lives in `isPageLocalEntity` rather than in this list.
 */
export const ENTITY_MAP_PAGE_LOCAL_TYPES = [
  "Answer",
  "BreadcrumbList",
  "ListItem",
  "Question",
  "WebPage",
] as const;

const PAGE_LOCAL_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_MAP_PAGE_LOCAL_TYPES);

/**
 * Whether an entity describes one page rather than the site's subject matter.
 *
 * Shared by the builder (which stamps `pageLocal`) and by any consumer that has
 * to make the same call on a node it did not build, so the two can never drift.
 */
export function isPageLocalEntity(primaryType: string, name: string | null): boolean {
  if (PAGE_LOCAL_TYPE_SET.has(primaryType)) return true;
  return primaryType === "ImageObject" && !name;
}

/** Longest `description` kept on a node before truncation. */
export const ENTITY_MAP_DESCRIPTION_MAX = 200;

/** Most page URLs listed on a node or an edge before `morePages` takes over. */
export const ENTITY_MAP_PAGES_CAP = 50;

/** Most page URLs listed per distinct value inside a conflict. */
export const ENTITY_MAP_CONFLICT_PAGES_CAP = 10;

/**
 * Caps applied when the map rides the publish body.
 *
 * The local document is uncapped, because a file on disk costs nothing. The
 * publish payload is measured against a hard size gate, so the hosted copy keeps
 * the entities and references that carry the findings and drops the tail.
 *
 * Node and edge counts alone are NOT enough: property values are site-controlled
 * strings, so fifty conflict values of a megabyte each would pass a node-count
 * cap and still blow the payload limit. `maxBytes` is the real backstop and the
 * per-string caps are what usually keep it from engaging.
 */
export const ENTITY_MAP_PUBLISH_LIMITS = {
  maxNodes: 750,
  maxEdges: 1500,
  /** Longest any single string property may be in the published copy. */
  maxStringLength: 512,
  /** Distinct values kept per conflicting property. */
  maxConflictValues: 5,
  /** Page URLs kept per conflict value, and per node or edge. */
  maxPages: 5,
  /** Serialized ceiling for the whole map. Well under the 20MB publish gate. */
  maxBytes: 512_000,
} as const;

/**
 * Caps applied when the map is inlined into an HTML page for the viewer.
 *
 * The viewer's payload is a `<script type="application/json">` block the browser
 * must parse in full before it draws anything, and the document grows linearly
 * with the crawl: a 5,000-page store declaring four entities per page measures
 * 20,001 nodes and a 15.3MB inline blob, of which the graph draws 400 and the
 * table shows 25. Capping the payload at 2,000 nodes takes that to 1.4MB while
 * still shipping five times what the graph can draw.
 *
 * Looser than the publish limits on the per-node fields, because this copy is
 * READ rather than merely stored: the detail panel lists twelve declaring pages
 * and a description is worth showing at more than 512 characters. `maxBytes` is
 * the backstop for a site whose property values are pathologically long, since
 * a node count alone bounds no bytes.
 */
export const ENTITY_MAP_VIEWER_LIMITS = {
  maxNodes: 2000,
  maxEdges: 4000,
  maxStringLength: 2048,
  maxConflictValues: 10,
  /** The detail panel lists twelve, so fewer would clip what a reader sees. */
  maxPages: 12,
  maxBytes: 4_000_000,
} as const;

/**
 * The caps one projection of a map was built with.
 *
 * Spelled out rather than `typeof ENTITY_MAP_PUBLISH_LIMITS`: the constants are
 * `as const`, so that would be a type of literal numbers and no other limit set
 * would satisfy it.
 */
export interface EntityMapLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxStringLength: number;
  readonly maxConflictValues: number;
  readonly maxPages: number;
  readonly maxBytes: number;
}

// ── Node properties ────────────────────────────────────────────────

/**
 * The consistency-relevant properties of an entity, normalised to strings.
 *
 * Objects (a `PostalAddress`, an `ImageObject`) are flattened to a single
 * display string; arrays are kept as arrays only where schema.org routinely
 * uses one (`sameAs`, `image`). Absent means the entity never declared it.
 */
export const EntityMapPropertiesSchema = Type.Object({
  name: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  logo: Type.Optional(Type.String()),
  image: Type.Optional(Type.Array(Type.String())),
  sameAs: Type.Optional(Type.Array(Type.String())),
  telephone: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

export type EntityMapProperties = Static<typeof EntityMapPropertiesSchema>;

/** Property names that participate in conflict detection, in output order. */
export const ENTITY_MAP_PROPERTY_KEYS = [
  "name",
  "url",
  "logo",
  "image",
  "sameAs",
  "telephone",
  "email",
  "address",
  "description",
] as const satisfies readonly (keyof EntityMapProperties)[];

// ── Conflicts ──────────────────────────────────────────────────────

/** One distinct value of a conflicting property and where it was declared. */
export const EntityMapConflictValueSchema = Type.Object({
  /** The value as rendered into {@link EntityMapProperties} (arrays joined). */
  value: Type.String(),
  /** Pages declaring this value, sorted, capped at {@link ENTITY_MAP_CONFLICT_PAGES_CAP}. */
  pages: Type.Array(Type.String()),
  /** Pages beyond the cap. */
  morePages: Type.Integer({ minimum: 0 }),
});

export type EntityMapConflictValue = Static<typeof EntityMapConflictValueSchema>;

/**
 * One property on which two occurrences of the same node disagree — the
 * "same Organization, three different logos" finding.
 */
export const EntityMapConflictSchema = Type.Object({
  property: Type.String(),
  /** At least two entries, sorted by value. */
  values: Type.Array(EntityMapConflictValueSchema),
});

export type EntityMapConflict = Static<typeof EntityMapConflictSchema>;

// ── Nodes ──────────────────────────────────────────────────────────

/**
 * One entity, collapsed across every page that declares it.
 *
 * `key` is the identity the builder settled on: the resolved `@id` when the
 * site supplied one (`id:<absolute @id>`), a page-scoped `blank:<page>:<id>`
 * for a JSON-LD blank node, a synthetic type+name/url/sameAs key when the site
 * supplied nothing, or a per-page anonymous key for an entity with no
 * distinguishing property at all (those never collapse).
 */
export const EntityMapNodeSchema = Type.Object({
  key: Type.String(),
  /** The resolved `@id`, or null when the entity declared none. */
  id: Type.Union([Type.String(), Type.Null()]),
  /** `@type` values, deduped. `types[0]` is primary. */
  types: Type.Array(Type.String()),
  name: Type.Union([Type.String(), Type.Null()]),
  /** First declared value per property, in page order. */
  properties: EntityMapPropertiesSchema,
  /** How many times the entity was declared across the crawl. */
  occurrences: Type.Integer({ minimum: 0 }),
  /** Declaring pages, sorted, capped at {@link ENTITY_MAP_PAGES_CAP}. */
  pages: Type.Array(Type.String()),
  morePages: Type.Integer({ minimum: 0 }),
  /** Properties whose value differs between occurrences. Empty when consistent. */
  conflicts: Type.Array(EntityMapConflictSchema),
  /** Outgoing `@id` references from this node that nothing declares. */
  danglingRefs: Type.Integer({ minimum: 0 }),
  /**
   * True when this entity describes one page rather than the site's subject
   * matter — see {@link ENTITY_MAP_PAGE_LOCAL_TYPES}. Stamped by the builder so
   * every consumer filters on the same call.
   */
  pageLocal: Type.Boolean(),
});

export type EntityMapNode = Static<typeof EntityMapNodeSchema>;

// ── Edges ──────────────────────────────────────────────────────────

/**
 * A typed reference from one node to another.
 *
 * `target` is a node key. When `dangling` is true no page declares that key:
 * the site referenced `{"@id": …}` and never defined it. Dangling targets are
 * deliberately NOT present in `nodes` — a renderer draws them as placeholders.
 */
export const EntityMapEdgeSchema = Type.Object({
  source: Type.String(),
  predicate: Type.String(),
  target: Type.String(),
  dangling: Type.Boolean(),
  /** How many page-level declarations produced this edge. */
  occurrences: Type.Integer({ minimum: 0 }),
  pages: Type.Array(Type.String()),
  morePages: Type.Integer({ minimum: 0 }),
});

export type EntityMapEdge = Static<typeof EntityMapEdgeSchema>;

// ── Pages ──────────────────────────────────────────────────────────

/** What one crawled page contributed to the map. */
export const EntityMapPageSchema = Type.Object({
  url: Type.String(),
  /** Node keys this page declares, sorted. */
  declares: Type.Array(Type.String()),
  /** Node keys this page references without declaring, sorted. */
  references: Type.Array(Type.String()),
  /** Number of JSON-LD entities declared on the page (before collapsing). */
  entityCount: Type.Integer({ minimum: 0 }),
});

export type EntityMapPage = Static<typeof EntityMapPageSchema>;

// ── Summary ────────────────────────────────────────────────────────

export const EntityMapSummarySchema = Type.Object({
  nodeCount: Type.Integer({ minimum: 0 }),
  edgeCount: Type.Integer({ minimum: 0 }),
  /** Edges whose target no page declares. */
  danglingCount: Type.Integer({ minimum: 0 }),
  /** Pages considered by the builder. */
  pagesTotal: Type.Integer({ minimum: 0 }),
  /** Pages that declared no JSON-LD entity at all. */
  pagesWithoutEntities: Type.Integer({ minimum: 0 }),
  /** Nodes carrying an `@id`, and that count as a 0-1 share of `nodeCount`. */
  nodesWithStableId: Type.Integer({ minimum: 0 }),
  stableIdShare: Type.Number({ minimum: 0, maximum: 1 }),
  /** Nodes tagged `pageLocal` — what a graph hides by default. */
  pageLocalCount: Type.Integer({ minimum: 0 }),
  /** Nodes with no `@id` declared on more than one page: the identity finding. */
  nodesWithoutIdCount: Type.Integer({ minimum: 0 }),
  /** Nodes carrying at least one conflicting property. */
  conflictCount: Type.Integer({ minimum: 0 }),
  /** Occurrence count per `@type`, every type of every node. Sorted by type. */
  countsByType: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});

export type EntityMapSummary = Static<typeof EntityMapSummarySchema>;

// ── Document ───────────────────────────────────────────────────────

/**
 * The entity-map document.
 *
 * Ordering is deterministic: `nodes` by `key`, `edges` by source then target
 * then predicate, `pages` by url, `countsByType` by type. `generatedAt` is the
 * only field that changes between two runs over an unchanged site.
 */
/**
 * What a bounded projection of a map left out.
 *
 * Present only on a projection; the document the builder produces carries the
 * whole crawl and omits this field. `summary` is never recomputed, so a reader
 * that ignores this still sees the TRUE site-wide counts — but "ignores this"
 * is exactly how a clipped graph gets mistaken for a small one, so a projection
 * states the loss rather than leaving it to be inferred from two lengths.
 */
export const EntityMapTruncationSchema = Type.Object({
  /** Which projection clipped it: the publish body, or an inlined viewer. */
  reason: Type.Union([Type.Literal("publish"), Type.Literal("viewer")]),
  /** Nodes present in the full map but not in `nodes`. */
  nodes: Type.Integer({ minimum: 0 }),
  /** Edges present in the full map but not in `edges`. */
  edges: Type.Integer({ minimum: 0 }),
  /** Page records dropped from `pages`. Both projections drop all of them. */
  pages: Type.Integer({ minimum: 0 }),
});

export type EntityMapTruncation = Static<typeof EntityMapTruncationSchema>;

export const EntityMapSchema = Type.Object({
  format: Type.Literal(ENTITY_MAP_FORMAT),
  version: Type.Literal(ENTITY_MAP_VERSION),
  /** Site the audit started from, as an absolute URL. */
  site: Type.String(),
  /** ISO-8601 timestamp. The one non-deterministic field. */
  generatedAt: Type.String(),
  summary: EntityMapSummarySchema,
  nodes: Type.Array(EntityMapNodeSchema),
  edges: Type.Array(EntityMapEdgeSchema),
  pages: Type.Array(EntityMapPageSchema),
  /**
   * Set when this copy is a bounded projection rather than the full document.
   * Optional so a v1 document written before the field still validates.
   */
  truncated: Type.Optional(EntityMapTruncationSchema),
});

export type EntityMap = Static<typeof EntityMapSchema>;

// ── Diff (#2092, epic section 9) ───────────────────────────────────

/** Discriminator written into every entity-map diff document. */
export const ENTITY_MAP_DIFF_FORMAT = "squirrelscan/entity-map-diff";

/** Diff schema version. Versioned like the map itself. */
export const ENTITY_MAP_DIFF_VERSION = 1;

/** An entity named in a change list. Enough to identify it without the map. */
export const EntityMapDiffNodeSchema = Type.Object({
  key: Type.String(),
  id: Type.Union([Type.String(), Type.Null()]),
  types: Type.Array(Type.String()),
  name: Type.Union([Type.String(), Type.Null()]),
  occurrences: Type.Integer({ minimum: 0 }),
});

export type EntityMapDiffNode = Static<typeof EntityMapDiffNodeSchema>;

/**
 * An entity that gained or lost a stable `@id`.
 *
 * Its key changes when that happens, so the two sides are matched on the sorted
 * type set plus the normalised name instead. `before` and `after` are the keys
 * on each side, which is what a reader needs to find it in either map.
 */
export const EntityMapDiffIdChangeSchema = Type.Object({
  beforeKey: Type.String(),
  afterKey: Type.String(),
  types: Type.Array(Type.String()),
  name: Type.Union([Type.String(), Type.Null()]),
  id: Type.Union([Type.String(), Type.Null()]),
  /**
   * Whether the evidence covers the pages this change claims to describe.
   *
   * `proven` requires BOTH: every page the older map recorded for this entity
   * was crawled again, AND the replacement is declared on every one of those
   * pages. `partial` means at least one of those could not be established.
   *
   * Both, because either alone is satisfied by a site that is not fixed. A
   * re-audit of /c and /d pairs against an entity last seen on /a and /b and
   * says nothing about them; an entity whose markup was DELETED from /a and /b
   * and added on /c passes the recrawl test while /a and /b lost their markup
   * entirely.
   *
   * The same discipline that separates `removed` from `notCrawled`, carried
   * onto the field an agent uses to decide a fix landed. Required, not
   * optional: a consumer that forgets it would report a partial result as proof.
   */
  coverage: Type.Union([Type.Literal("proven"), Type.Literal("partial")]),
});

export type EntityMapDiffIdChange = Static<typeof EntityMapDiffIdChangeSchema>;

/** How often an entity was declared, before and after. */
export const EntityMapDiffOccurrenceSchema = Type.Object({
  key: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  types: Type.Array(Type.String()),
  before: Type.Integer({ minimum: 0 }),
  after: Type.Integer({ minimum: 0 }),
  delta: Type.Integer(),
});

export type EntityMapDiffOccurrence = Static<typeof EntityMapDiffOccurrenceSchema>;

/** A conflicting property that appeared or went away. */
export const EntityMapDiffConflictSchema = Type.Object({
  key: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  property: Type.String(),
});

export type EntityMapDiffConflict = Static<typeof EntityMapDiffConflictSchema>;

/** A dangling reference that appeared or went away. */
export const EntityMapDiffDanglingSchema = Type.Object({
  source: Type.String(),
  predicate: Type.String(),
  target: Type.String(),
});

export type EntityMapDiffDangling = Static<typeof EntityMapDiffDanglingSchema>;

/** One summary metric, before and after. */
export const EntityMapDiffMetricSchema = Type.Object({
  before: Type.Number(),
  after: Type.Number(),
  delta: Type.Number(),
});

export type EntityMapDiffMetric = Static<typeof EntityMapDiffMetricSchema>;

/** What one side of the comparison was. */
export const EntityMapDiffSideSchema = Type.Object({
  site: Type.String(),
  generatedAt: Type.String(),
  nodeCount: Type.Integer({ minimum: 0 }),
  pagesTotal: Type.Integer({ minimum: 0 }),
});

export type EntityMapDiffSide = Static<typeof EntityMapDiffSideSchema>;

/**
 * The change set between two entity maps.
 *
 * The distinction that makes this trustworthy is `notCrawled`: an entity whose
 * declaring pages were not all visited again is NOT reported as removed. A
 * smaller crawl would otherwise read as the site having deleted its markup,
 * which is the single most misleading thing a diff like this can say.
 *
 * Deterministic: every list is sorted, and `generatedAt` is the only field that
 * changes between two runs over the same pair of maps.
 */
export const EntityMapDiffSchema = Type.Object({
  format: Type.Literal(ENTITY_MAP_DIFF_FORMAT),
  version: Type.Literal(ENTITY_MAP_DIFF_VERSION),
  generatedAt: Type.String(),
  older: EntityMapDiffSideSchema,
  newer: EntityMapDiffSideSchema,
  /** Entities the newer map declares and the older one did not. */
  added: Type.Array(EntityMapDiffNodeSchema),
  /** Gone, and every page that declared them WAS crawled again. */
  removed: Type.Array(EntityMapDiffNodeSchema),
  /** Gone, but at least one declaring page was not crawled again. */
  notCrawled: Type.Array(EntityMapDiffNodeSchema),
  gainedId: Type.Array(EntityMapDiffIdChangeSchema),
  lostId: Type.Array(EntityMapDiffIdChangeSchema),
  occurrenceDeltas: Type.Array(EntityMapDiffOccurrenceSchema),
  newConflicts: Type.Array(EntityMapDiffConflictSchema),
  resolvedConflicts: Type.Array(EntityMapDiffConflictSchema),
  newDangling: Type.Array(EntityMapDiffDanglingSchema),
  resolvedDangling: Type.Array(EntityMapDiffDanglingSchema),
  /** Every summary metric, before and after. */
  summaryDelta: Type.Record(Type.String(), EntityMapDiffMetricSchema),
  /**
   * Pages the older map saw and the newer one did not, and the reverse.
   *
   * Sampled, sorted, capped at {@link ENTITY_MAP_DIFF_PAGES_CAP}: two 5,000-page
   * crawls that happened to cover different pages would otherwise put 10,000
   * URLs in this document, and a reader acts on the count plus a handful of
   * examples, never on the whole list.
   */
  pagesOnlyInOlder: Type.Array(Type.String()),
  pagesOnlyInNewer: Type.Array(Type.String()),
  /** Pages past the cap on each side. Optional so a v1 diff still validates. */
  morePagesOnlyInOlder: Type.Optional(Type.Integer({ minimum: 0 })),
  morePagesOnlyInNewer: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type EntityMapDiff = Static<typeof EntityMapDiffSchema>;

/** Page URLs listed per side before a diff says "and N more". */
export const ENTITY_MAP_DIFF_PAGES_CAP = 25;

// ── JSON-LD export ─────────────────────────────────────────────────

/**
 * The merged graph re-emitted as JSON-LD — what a user pastes into a schema
 * validator or feeds a CMS plugin. One `@graph` member per collapsed node.
 */
export interface EntityMapJsonLd {
  "@context": "https://schema.org";
  "@graph": Record<string, unknown>[];
}
