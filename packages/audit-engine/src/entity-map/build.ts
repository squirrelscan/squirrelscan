// Entity-map builder (#2061) — collapses the JSON-LD of every crawled page into
// one site-wide graph of entities and the references between them.
//
// Pure and streaming-friendly: the caller hands it `{ url, raw }` per page and
// gets the finished document back. Nothing here touches the network, the DOM or
// the filesystem.
//
// EVERY value read here comes from an audited page and is attacker controlled —
// type names, `@id`s, property values. Two consequences run through the file:
// keyed lookups use `Map`, never a plain object, so a type literally named
// `__proto__` cannot reach an inherited setter; and nothing is ever rendered,
// only stored (see ./html for the escaping side).

import {
  ENTITY_MAP_CONFLICT_PAGES_CAP,
  ENTITY_MAP_DESCRIPTION_MAX,
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_PAGES_CAP,
  ENTITY_MAP_PREDICATES,
  ENTITY_MAP_PROPERTY_KEYS,
  ENTITY_MAP_VERSION,
  type EntityMap,
  type EntityMapConflict,
  type EntityMapEdge,
  type EntityMapNode,
  type EntityMapPage,
  type EntityMapProperties,
} from "@squirrelscan/core-contracts/entity-map";
import { flattenJsonLdNodes } from "@squirrelscan/utils/schema-rich-results";

/** One crawled page's JSON-LD, as the builder wants it. */
export interface EntityMapPageInput {
  /** Absolute page URL — the base every relative `@id` resolves against. */
  url: string;
  /** Raw `<script type="application/ld+json">` payload (`parsed.schemas.raw`). */
  raw: string | null;
}

export interface BuildEntityMapOptions {
  /** Overrides `new Date().toISOString()`. Tests pin it to diff two builds. */
  generatedAt?: string;
}

const PREDICATES: ReadonlySet<string> = new Set<string>(ENTITY_MAP_PREDICATES);

/**
 * Distinct values kept per conflicting property. A site that emits a unique
 * logo URL per page would otherwise accumulate one entry per page.
 */
const MAX_CONFLICT_VALUES = 50;

/** Guard against a page declaring a pathologically deep nested object. */
const MAX_NESTING_DEPTH = 12;

// ── Value coercion ─────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-LD lets any property be a single value or an array of them. */
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A displayable string for a JSON-LD value: the string itself, a number or
 * boolean, an `{"@value": …}` wrapper, or the `url`/`contentUrl`/`name` of an
 * object. Returns null when there is nothing worth showing.
 */
function toDisplayString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isObject(value)) {
    const wrapped = value["@value"];
    if (typeof wrapped === "string" || typeof wrapped === "number") {
      return toDisplayString(wrapped);
    }
    for (const key of ["url", "contentUrl", "@id", "name"]) {
      const nested = value[key];
      if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
    }
  }
  return null;
}

/** Flatten a `PostalAddress` (or a plain string address) to one line. */
function toAddressString(value: unknown): string | null {
  if (!isObject(value)) return toDisplayString(value);
  const parts: string[] = [];
  for (const key of [
    "streetAddress",
    "addressLocality",
    "addressRegion",
    "postalCode",
    "addressCountry",
  ]) {
    const part = toDisplayString(value[key]);
    if (part) parts.push(part);
  }
  if (parts.length === 0) return toDisplayString(value);
  return parts.join(", ");
}

function toStringList(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of toArray(value)) {
    const text = toDisplayString(entry);
    if (text) out.push(text);
  }
  return out;
}

// ── Identity ───────────────────────────────────────────────────────

/**
 * Resolve an `@id` (often a bare `#organization` fragment) against the page
 * that declared it. A fragment-only `@id` is genuinely page-scoped, so two
 * pages declaring `#organization` produce two nodes — which is the finding, not
 * a bug.
 */
function resolveId(rawId: string, pageUrl: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) return trimmed;
  try {
    return new URL(trimmed, pageUrl).href;
  } catch {
    return trimmed;
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeUrlish(value: string, pageUrl: string): string {
  try {
    const url = new URL(value.trim(), pageUrl);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return normalizeText(value);
  }
}

function idKey(resolvedId: string): string {
  return `id:${resolvedId}`;
}

/** `@type` as a deduped string list. Non-string entries are dropped. */
function readTypes(node: JsonObject): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const entry of toArray(node["@type"])) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    types.push(trimmed);
  }
  return types;
}

/** The nine consistency properties, normalised. */
function readProperties(node: JsonObject, pageUrl: string): EntityMapProperties {
  const properties: EntityMapProperties = {};

  const name = toDisplayString(node.name) ?? toDisplayString(node.headline);
  if (name) properties.name = name;

  const url = toDisplayString(node.url);
  if (url) properties.url = resolveId(url, pageUrl);

  const logo = toStringList(node.logo)[0];
  if (logo) properties.logo = resolveId(logo, pageUrl);

  const image = toStringList(node.image).map((entry) => resolveId(entry, pageUrl));
  if (image.length > 0) properties.image = image;

  // `sameAs` is a set, not a sequence: sort it so two pages listing the same
  // profiles in a different order are not reported as a conflict.
  const sameAs = toStringList(node.sameAs)
    .map((entry) => resolveId(entry, pageUrl))
    .sort(compareStrings);
  if (sameAs.length > 0) properties.sameAs = [...new Set(sameAs)];

  const telephone = toDisplayString(node.telephone);
  if (telephone) properties.telephone = telephone;

  const email = toDisplayString(node.email);
  if (email) properties.email = email;

  const address = toAddressString(node.address);
  if (address) properties.address = address;

  const description = toDisplayString(node.description);
  if (description) {
    properties.description =
      description.length > ENTITY_MAP_DESCRIPTION_MAX
        ? `${description.slice(0, ENTITY_MAP_DESCRIPTION_MAX - 1)}…`
        : description;
  }

  return properties;
}

/** The string written into a conflict entry for one property value. */
function propertyValueText(properties: EntityMapProperties, key: string): string | null {
  const value = (properties as Record<string, unknown>)[key];
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : null;
  return typeof value === "string" ? value : null;
}

// ── Accumulators ───────────────────────────────────────────────────

interface NodeAccumulator {
  key: string;
  id: string | null;
  /** Union of `@type` across occurrences, in first-seen order. */
  types: string[];
  typeSeen: Set<string>;
  /** First declared value per property, in walk order. */
  properties: EntityMapProperties;
  occurrences: number;
  pages: Set<string>;
  /** property -> value text -> pages carrying it. */
  values: Map<string, Map<string, Set<string>>>;
  danglingRefs: number;
}

type EdgeKind = "node" | "idref" | "soft";

interface EdgeCandidate {
  source: string;
  predicate: string;
  target: string;
  kind: EdgeKind;
  page: string;
}

interface EdgeAccumulator {
  source: string;
  predicate: string;
  target: string;
  kind: EdgeKind;
  occurrences: number;
  pages: Set<string>;
}

interface PageAccumulator {
  url: string;
  declares: Set<string>;
  references: Set<string>;
  entityCount: number;
}

// ── Builder ────────────────────────────────────────────────────────

/**
 * Build the entity map for one audit.
 *
 * Pages are sorted by URL before the walk, so "the first occurrence of an
 * entity" is a property of the site rather than of crawl order: two runs over
 * an unchanged site produce identical output apart from `generatedAt`.
 */
export function buildEntityMap(
  pages: EntityMapPageInput[],
  siteUrl: string,
  options: BuildEntityMapOptions = {},
): EntityMap {
  const nodes = new Map<string, NodeAccumulator>();
  const pageAccumulators = new Map<string, PageAccumulator>();
  const candidates: EdgeCandidate[] = [];

  // Deduplicate pages by URL (a redirect chain can land two records on one
  // final URL) and walk them in URL order.
  const byUrl = new Map<string, EntityMapPageInput>();
  for (const page of pages) {
    if (!byUrl.has(page.url)) byUrl.set(page.url, page);
  }
  const ordered = [...byUrl.values()].sort((a, b) => compareStrings(a.url, b.url));

  for (const page of ordered) {
    const pageAccumulator: PageAccumulator = {
      url: page.url,
      declares: new Set(),
      references: new Set(),
      entityCount: 0,
    };
    pageAccumulators.set(page.url, pageAccumulator);
    if (!page.raw) continue;

    // `flattenJsonLdNodes` handles multi-block raw, top-level arrays and
    // `@graph` (the Yoast/Rank Math shape). It does NOT descend into ordinary
    // properties — the nested walk below does that.
    const roots = flattenJsonLdNodes(page.raw);
    const counter = { index: 0 };
    for (const root of roots) {
      if (readTypes(root).length === 0) continue;
      registerNode(root, page.url, pageAccumulator, nodes, candidates, counter, 0);
    }
  }

  return assemble(nodes, pageAccumulators, candidates, siteUrl, options);
}

/**
 * Record one JSON-LD object as a node occurrence and queue its outgoing edges.
 * Returns the node key.
 */
function registerNode(
  raw: JsonObject,
  pageUrl: string,
  page: PageAccumulator,
  nodes: Map<string, NodeAccumulator>,
  candidates: EdgeCandidate[],
  counter: { index: number },
  depth: number,
): string | null {
  const types = readTypes(raw);
  if (types.length === 0) return null;

  const properties = readProperties(raw, pageUrl);
  const rawId = typeof raw["@id"] === "string" ? raw["@id"] : null;
  const resolvedId = rawId ? resolveId(rawId, pageUrl) : null;
  const key = resolvedId
    ? idKey(resolvedId)
    : syntheticKey(types[0] ?? "Thing", properties, pageUrl, counter.index);

  counter.index += 1;
  page.entityCount += 1;
  page.declares.add(key);

  let accumulator = nodes.get(key);
  if (!accumulator) {
    accumulator = {
      key,
      id: resolvedId,
      types: [],
      typeSeen: new Set(),
      properties: {},
      occurrences: 0,
      pages: new Set(),
      values: new Map(),
      danglingRefs: 0,
    };
    nodes.set(key, accumulator);
  }
  accumulator.occurrences += 1;
  accumulator.pages.add(pageUrl);
  for (const type of types) {
    if (accumulator.typeSeen.has(type)) continue;
    accumulator.typeSeen.add(type);
    accumulator.types.push(type);
  }
  mergeProperties(accumulator, properties, pageUrl);

  if (depth < MAX_NESTING_DEPTH) {
    collectEdges(raw, key, pageUrl, page, nodes, candidates, counter, depth);
  }
  return key;
}

/**
 * Canonical properties are "the first occurrence that declares the property, in
 * page order" rather than "whatever the first occurrence happened to carry" —
 * a homepage Organization with a logo and forty inner pages without one should
 * still show the logo.
 */
function mergeProperties(
  accumulator: NodeAccumulator,
  properties: EntityMapProperties,
  pageUrl: string,
): void {
  for (const key of ENTITY_MAP_PROPERTY_KEYS) {
    const text = propertyValueText(properties, key);
    if (text === null) continue;

    if ((accumulator.properties as Record<string, unknown>)[key] === undefined) {
      (accumulator.properties as Record<string, unknown>)[key] = (
        properties as Record<string, unknown>
      )[key];
    }

    let values = accumulator.values.get(key);
    if (!values) {
      values = new Map();
      accumulator.values.set(key, values);
    }
    const existing = values.get(text);
    if (existing) {
      existing.add(pageUrl);
    } else if (values.size < MAX_CONFLICT_VALUES) {
      values.set(text, new Set([pageUrl]));
    }
  }
}

/** Queue an edge for every followed predicate present on `raw`. */
function collectEdges(
  raw: JsonObject,
  sourceKey: string,
  pageUrl: string,
  page: PageAccumulator,
  nodes: Map<string, NodeAccumulator>,
  candidates: EdgeCandidate[],
  counter: { index: number },
  depth: number,
): void {
  for (const predicate of ENTITY_MAP_PREDICATES) {
    const value = raw[predicate];
    if (value === undefined || value === null) continue;

    for (const entry of toArray(value)) {
      // Breadcrumbs: the interesting target is the ListItem's `item`, not the
      // ListItem wrapper, so unwrap rather than minting a node per crumb. A
      // crumb that carries only a position and a name names no entity at all
      // and is dropped.
      let target: unknown = entry;
      if (predicate === "itemListElement" && isObject(entry) && readTypes(entry).includes("ListItem")) {
        if (entry.item === undefined) continue;
        target = entry.item;
      }

      for (const resolvedTarget of toArray(target)) {
        pushEdge(
          resolvedTarget,
          predicate,
          sourceKey,
          pageUrl,
          page,
          nodes,
          candidates,
          counter,
          depth,
        );
      }
    }
  }
}

function pushEdge(
  value: unknown,
  predicate: string,
  sourceKey: string,
  pageUrl: string,
  page: PageAccumulator,
  nodes: Map<string, NodeAccumulator>,
  candidates: EdgeCandidate[],
  counter: { index: number },
  depth: number,
): void {
  if (isObject(value)) {
    if (readTypes(value).length > 0) {
      // An inline entity — becomes a node of its own and the edge can never
      // dangle.
      const targetKey = registerNode(
        value,
        pageUrl,
        page,
        nodes,
        candidates,
        counter,
        depth + 1,
      );
      if (targetKey) {
        candidates.push({ source: sourceKey, predicate, target: targetKey, kind: "node", page: pageUrl });
      }
      return;
    }
    const reference = value["@id"];
    if (typeof reference === "string" && reference.trim().length > 0) {
      // A bare `{"@id": …}` is a promise that some page declares the entity.
      // When no page does, that promise is the finding.
      candidates.push({
        source: sourceKey,
        predicate,
        target: idKey(resolveId(reference, pageUrl)),
        kind: "idref",
        page: pageUrl,
      });
    }
    return;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    // A bare string (a `sameAs` profile URL, a breadcrumb `item` URL) is a
    // value, not a promise. It only becomes an edge when some page really does
    // declare a node under that `@id`; it never dangles.
    candidates.push({
      source: sourceKey,
      predicate,
      target: idKey(resolveId(value, pageUrl)),
      kind: "soft",
      page: pageUrl,
    });
  }
}

/**
 * Synthetic identity for an entity with no `@id`: type plus the first
 * distinguishing property. An entity with none of them gets a per-page
 * anonymous key so two unrelated blank nodes never collapse into one.
 */
function syntheticKey(
  primaryType: string,
  properties: EntityMapProperties,
  pageUrl: string,
  index: number,
): string {
  if (properties.name) return `syn:${primaryType}|name:${normalizeText(properties.name)}`;
  if (properties.url) return `syn:${primaryType}|url:${normalizeUrlish(properties.url, pageUrl)}`;
  const sameAs = properties.sameAs?.[0];
  if (sameAs) return `syn:${primaryType}|sameAs:${normalizeUrlish(sameAs, pageUrl)}`;
  return `anon:${pageUrl}#${index}`;
}

// ── Assembly ───────────────────────────────────────────────────────

/** Stable, locale-independent string order. `localeCompare` is not portable. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function capPages(pages: Set<string>, cap: number): { pages: string[]; morePages: number } {
  const sorted = [...pages].sort(compareStrings);
  return {
    pages: sorted.slice(0, cap),
    morePages: Math.max(0, sorted.length - cap),
  };
}

function assemble(
  nodes: Map<string, NodeAccumulator>,
  pageAccumulators: Map<string, PageAccumulator>,
  candidates: EdgeCandidate[],
  siteUrl: string,
  options: BuildEntityMapOptions,
): EntityMap {
  // Pass 2: a candidate can only be classified once every declared key is known.
  const edges = new Map<string, EdgeAccumulator>();
  for (const candidate of candidates) {
    const declared = nodes.has(candidate.target);
    if (candidate.kind === "soft" && !declared) continue;
    if (candidate.source === candidate.target) continue;

    const dedupeKey = `${candidate.source} ${candidate.predicate} ${candidate.target}`;
    let edge = edges.get(dedupeKey);
    if (!edge) {
      edge = {
        source: candidate.source,
        predicate: candidate.predicate,
        target: candidate.target,
        kind: candidate.kind,
        occurrences: 0,
        pages: new Set(),
      };
      edges.set(dedupeKey, edge);
    }
    edge.occurrences += 1;
    edge.pages.add(candidate.page);

    const page = pageAccumulators.get(candidate.page);
    if (page && !page.declares.has(candidate.target)) page.references.add(candidate.target);
  }

  const outputEdges: EntityMapEdge[] = [];
  for (const edge of edges.values()) {
    const dangling = edge.kind === "idref" && !nodes.has(edge.target);
    if (dangling) {
      const source = nodes.get(edge.source);
      if (source) source.danglingRefs += 1;
    }
    const { pages, morePages } = capPages(edge.pages, ENTITY_MAP_PAGES_CAP);
    outputEdges.push({
      source: edge.source,
      predicate: edge.predicate,
      target: edge.target,
      dangling,
      occurrences: edge.occurrences,
      pages,
      morePages,
    });
  }
  outputEdges.sort(
    (a, b) =>
      compareStrings(a.source, b.source) ||
      compareStrings(a.target, b.target) ||
      compareStrings(a.predicate, b.predicate),
  );

  const outputNodes: EntityMapNode[] = [];
  const typeCounts = new Map<string, number>();
  let nodesWithStableId = 0;

  for (const accumulator of [...nodes.values()].sort((a, b) => compareStrings(a.key, b.key))) {
    if (accumulator.id) nodesWithStableId += 1;
    for (const type of accumulator.types) {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + accumulator.occurrences);
    }

    const conflicts: EntityMapConflict[] = [];
    for (const property of ENTITY_MAP_PROPERTY_KEYS) {
      const values = accumulator.values.get(property);
      if (!values || values.size < 2) continue;
      const entries = [...values.entries()].sort((a, b) => compareStrings(a[0], b[0]));
      conflicts.push({
        property,
        values: entries.map(([value, pages]) => {
          const capped = capPages(pages, ENTITY_MAP_CONFLICT_PAGES_CAP);
          return { value, pages: capped.pages, morePages: capped.morePages };
        }),
      });
    }

    const { pages, morePages } = capPages(accumulator.pages, ENTITY_MAP_PAGES_CAP);
    outputNodes.push({
      key: accumulator.key,
      id: accumulator.id,
      types: accumulator.types,
      name: accumulator.properties.name ?? null,
      properties: orderProperties(accumulator.properties),
      occurrences: accumulator.occurrences,
      pages,
      morePages,
      conflicts,
      danglingRefs: accumulator.danglingRefs,
    });
  }

  const outputPages: EntityMapPage[] = [...pageAccumulators.values()]
    .sort((a, b) => compareStrings(a.url, b.url))
    .map((page) => ({
      url: page.url,
      declares: [...page.declares].sort(compareStrings),
      references: [...page.references].sort(compareStrings),
      entityCount: page.entityCount,
    }));

  const danglingCount = outputEdges.filter((edge) => edge.dangling).length;
  const pagesWithoutEntities = outputPages.filter((page) => page.entityCount === 0).length;

  return {
    format: ENTITY_MAP_FORMAT,
    version: ENTITY_MAP_VERSION,
    site: siteUrl,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    summary: {
      nodeCount: outputNodes.length,
      edgeCount: outputEdges.length,
      danglingCount,
      pagesTotal: outputPages.length,
      pagesWithoutEntities,
      nodesWithStableId,
      stableIdShare: outputNodes.length === 0 ? 0 : nodesWithStableId / outputNodes.length,
      // Type names come from audited pages, so a type called `__proto__` is
      // possible. `Object.fromEntries` uses CreateDataProperty and keeps it as
      // an own property instead of hitting the inherited setter.
      countsByType: Object.fromEntries(
        [...typeCounts.entries()].sort((a, b) => compareStrings(a[0], b[0])),
      ),
    },
    nodes: outputNodes,
    edges: outputEdges,
    pages: outputPages,
  };
}

/** Serialize properties in a fixed key order so JSON output is byte-stable. */
function orderProperties(properties: EntityMapProperties): EntityMapProperties {
  const ordered: EntityMapProperties = {};
  for (const key of ENTITY_MAP_PROPERTY_KEYS) {
    const value = (properties as Record<string, unknown>)[key];
    if (value !== undefined) (ordered as Record<string, unknown>)[key] = value;
  }
  return ordered;
}
