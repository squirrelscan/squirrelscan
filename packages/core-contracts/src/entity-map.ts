// Structured entity map (#2061) — the graph of things a site declares in
// JSON-LD, collapsed across every page of one audit.
//
// One document per audit. The engine builds it, the CLI writes it next to the
// report, and (later) the cloud stores it alongside the report JSON. The schema
// lives here so the CLI, the engine and the dashboard read one type.
//
// Everything in this document is derived from JSON-LD on audited pages, i.e.
// from UNTRUSTED input: type names, property values and `@id`s are attacker
// controlled. Consumers must escape before rendering and must never bracket-copy
// a type name onto a plain `{}` (see ./untrusted-keys).

import { z } from "zod";

/** Discriminator written into every entity-map document. */
export const ENTITY_MAP_FORMAT = "squirrelscan/entity-map";

/** Schema version. Bump on any breaking shape change. */
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

/** Longest `description` kept on a node before truncation. */
export const ENTITY_MAP_DESCRIPTION_MAX = 200;

/** Most page URLs listed on a node or an edge before `morePages` takes over. */
export const ENTITY_MAP_PAGES_CAP = 50;

/** Most page URLs listed per distinct value inside a conflict. */
export const ENTITY_MAP_CONFLICT_PAGES_CAP = 10;

/**
 * Caps applied when the map rides the publish body.
 *
 * The local files are uncapped, because a file on disk costs nothing. The
 * publish payload is measured against a hard gate, so the hosted copy keeps the
 * entities and references that carry the findings and drops the tail. Nodes are
 * kept by occurrence count, edges follow the nodes they connect, and `pages` is
 * dropped outright: it is the largest array and the summary already carries the
 * only number a reader needs from it.
 */
export const ENTITY_MAP_PUBLISH_LIMITS = {
  maxNodes: 750,
  maxEdges: 1500,
} as const;

// ── Node properties ────────────────────────────────────────────────

/**
 * The consistency-relevant properties of an entity, normalised to strings.
 *
 * Objects (a `PostalAddress`, an `ImageObject`) are flattened to a single
 * display string; arrays are kept as arrays only where schema.org routinely
 * uses one (`sameAs`, `image`). Absent means the entity never declared it.
 */
export const entityMapPropertiesSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  logo: z.string().optional(),
  image: z.array(z.string()).optional(),
  sameAs: z.array(z.string()).optional(),
  telephone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  description: z.string().optional(),
});

export type EntityMapProperties = z.infer<typeof entityMapPropertiesSchema>;

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
export const entityMapConflictValueSchema = z.object({
  /** The value as rendered into {@link EntityMapProperties} (arrays joined). */
  value: z.string(),
  /** Pages declaring this value, sorted, capped at {@link ENTITY_MAP_CONFLICT_PAGES_CAP}. */
  pages: z.array(z.string()),
  /** Pages beyond the cap. */
  morePages: z.number().int().nonnegative(),
});

export type EntityMapConflictValue = z.infer<typeof entityMapConflictValueSchema>;

/**
 * One property on which two occurrences of the same node disagree — the
 * "same Organization, three different logos" finding.
 */
export const entityMapConflictSchema = z.object({
  property: z.string(),
  /** At least two entries, sorted by value. */
  values: z.array(entityMapConflictValueSchema),
});

export type EntityMapConflict = z.infer<typeof entityMapConflictSchema>;

// ── Nodes ──────────────────────────────────────────────────────────

/**
 * One entity, collapsed across every page that declares it.
 *
 * `key` is the identity the builder settled on: the resolved `@id` when the
 * site supplied one (`id:<absolute @id>`), a synthetic type+name/url/sameAs key
 * when it did not, or a per-page anonymous key for an entity with no
 * distinguishing property at all (those never collapse).
 */
export const entityMapNodeSchema = z.object({
  key: z.string(),
  /** The resolved `@id`, or null when the entity declared none. */
  id: z.string().nullable(),
  /** `@type` values of the first occurrence, deduped. `types[0]` is primary. */
  types: z.array(z.string()),
  name: z.string().nullable(),
  /** Taken from the first occurrence in `(pageUrl, nodeIndex)` order. */
  properties: entityMapPropertiesSchema,
  /** How many times the entity was declared across the crawl. */
  occurrences: z.number().int().nonnegative(),
  /** Declaring pages, sorted, capped at {@link ENTITY_MAP_PAGES_CAP}. */
  pages: z.array(z.string()),
  morePages: z.number().int().nonnegative(),
  /** Properties whose value differs between occurrences. Empty when consistent. */
  conflicts: z.array(entityMapConflictSchema),
  /** Outgoing `@id` references from this node that nothing declares. */
  danglingRefs: z.number().int().nonnegative(),
});

export type EntityMapNode = z.infer<typeof entityMapNodeSchema>;

// ── Edges ──────────────────────────────────────────────────────────

/**
 * A typed reference from one node to another.
 *
 * `target` is a node key. When `dangling` is true no page declares that key:
 * the site referenced `{"@id": …}` and never defined it. Dangling targets are
 * deliberately NOT present in `nodes` — a renderer draws them as placeholders.
 */
export const entityMapEdgeSchema = z.object({
  source: z.string(),
  predicate: z.string(),
  target: z.string(),
  dangling: z.boolean(),
  /** How many page-level declarations produced this edge. */
  occurrences: z.number().int().nonnegative(),
  pages: z.array(z.string()),
  morePages: z.number().int().nonnegative(),
});

export type EntityMapEdge = z.infer<typeof entityMapEdgeSchema>;

// ── Pages ──────────────────────────────────────────────────────────

/** What one crawled page contributed to the map. */
export const entityMapPageSchema = z.object({
  url: z.string(),
  /** Node keys this page declares, sorted. */
  declares: z.array(z.string()),
  /** Node keys this page references without declaring, sorted. */
  references: z.array(z.string()),
  /** Number of JSON-LD entities declared on the page (before collapsing). */
  entityCount: z.number().int().nonnegative(),
});

export type EntityMapPage = z.infer<typeof entityMapPageSchema>;

// ── Summary ────────────────────────────────────────────────────────

export const entityMapSummarySchema = z.object({
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  /** Edges whose target no page declares. */
  danglingCount: z.number().int().nonnegative(),
  /** Pages considered by the builder. */
  pagesTotal: z.number().int().nonnegative(),
  /** Pages that declared no JSON-LD entity at all. */
  pagesWithoutEntities: z.number().int().nonnegative(),
  /** Nodes carrying an `@id`, and that count as a 0-1 share of `nodeCount`. */
  nodesWithStableId: z.number().int().nonnegative(),
  stableIdShare: z.number().min(0).max(1),
  /** Occurrence count per `@type`, every type of every node. Sorted by type. */
  countsByType: z.record(z.string(), z.number().int().nonnegative()),
});

export type EntityMapSummary = z.infer<typeof entityMapSummarySchema>;

// ── Document ───────────────────────────────────────────────────────

/**
 * The entity-map document.
 *
 * Ordering is deterministic: `nodes` by `key`, `edges` by source then target
 * then predicate, `pages` by url, `countsByType` by type. `generatedAt` is the
 * only field that changes between two runs over an unchanged site.
 */
export const entityMapSchema = z.object({
  format: z.literal(ENTITY_MAP_FORMAT),
  version: z.literal(ENTITY_MAP_VERSION),
  /** Site the audit started from, as an absolute URL. */
  site: z.string(),
  /** ISO-8601 timestamp. The one non-deterministic field. */
  generatedAt: z.string(),
  summary: entityMapSummarySchema,
  nodes: z.array(entityMapNodeSchema),
  edges: z.array(entityMapEdgeSchema),
  pages: z.array(entityMapPageSchema),
});

export type EntityMap = z.infer<typeof entityMapSchema>;

// ── JSON-LD export ─────────────────────────────────────────────────

/**
 * The merged graph re-emitted as JSON-LD — what a user pastes into a schema
 * validator or feeds a CMS plugin. One `@graph` member per collapsed node.
 */
export interface EntityMapJsonLd {
  "@context": "https://schema.org";
  "@graph": Record<string, unknown>[];
}
