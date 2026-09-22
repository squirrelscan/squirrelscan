// Bound an entity map for a copy that travels (#2091).
//
// The local document stays complete — `-f json` is the canonical export. Two
// copies do not get to be complete:
//
//   - the PUBLISH body, measured against a hard size gate;
//   - the VIEWER payload, inlined into an HTML page as a JSON blob the browser
//     parses in full before it draws anything. That one grows linearly with the
//     crawl: 5,000 pages declaring four entities each measures 20,001 nodes and
//     15.3MB of inline JSON, to draw 400 nodes and 25 table rows.
//
// Counts alone do NOT bound bytes. Every string in this document is a
// site-controlled value, so fifty conflict values of a megabyte each pass a
// node-count cap and still blow the limit. Three layers, cheapest first: clamp
// every string, sample the conflict and page arrays, then drop
// lowest-occurrence nodes until the serialized document fits.
//
// Lives in core-contracts rather than in the engine because `@squirrelscan/report`
// needs it for the viewer payload and the engine depends on report, never the
// reverse. The engine re-exports it from `./entity-map/slim`.

import {
  ENTITY_MAP_PUBLISH_LIMITS,
  ENTITY_MAP_VIEWER_LIMITS,
  type EntityMap,
  type EntityMapConflict,
  type EntityMapEdge,
  type EntityMapLimits,
  type EntityMapNode,
  type EntityMapProperties,
  type EntityMapTruncation,
} from "./entity-map";

function clampString(value: string, limits: EntityMapLimits): string {
  return value.length > limits.maxStringLength
    ? `${value.slice(0, limits.maxStringLength - 1)}…`
    : value;
}

function clampStrings(values: string[], max: number, limits: EntityMapLimits): string[] {
  return values.slice(0, max).map((value) => clampString(value, limits));
}

/** Every property value clamped, and the array-valued ones sampled. */
function clampProperties(
  properties: EntityMapProperties,
  limits: EntityMapLimits,
): EntityMapProperties {
  const out: EntityMapProperties = {};
  if (properties.name !== undefined) out.name = clampString(properties.name, limits);
  if (properties.url !== undefined) out.url = clampString(properties.url, limits);
  if (properties.logo !== undefined) out.logo = clampString(properties.logo, limits);
  if (properties.image !== undefined) {
    out.image = clampStrings(properties.image, limits.maxConflictValues, limits);
  }
  if (properties.sameAs !== undefined) {
    out.sameAs = clampStrings(properties.sameAs, limits.maxConflictValues, limits);
  }
  if (properties.telephone !== undefined) {
    out.telephone = clampString(properties.telephone, limits);
  }
  if (properties.email !== undefined) out.email = clampString(properties.email, limits);
  if (properties.address !== undefined) out.address = clampString(properties.address, limits);
  if (properties.description !== undefined) {
    out.description = clampString(properties.description, limits);
  }
  return out;
}

function clampConflicts(
  conflicts: EntityMapConflict[],
  limits: EntityMapLimits,
): EntityMapConflict[] {
  return conflicts.map((conflict) => ({
    property: conflict.property,
    values: conflict.values.slice(0, limits.maxConflictValues).map((value) => ({
      value: clampString(value.value, limits),
      pages: clampStrings(value.pages, limits.maxPages, limits),
      // The dropped page URLs are still counted, so a reader sees the real
      // spread rather than a number that shrank with the payload.
      morePages: value.morePages + Math.max(0, value.pages.length - limits.maxPages),
    })),
  }));
}

function clampNode(node: EntityMapNode, limits: EntityMapLimits): EntityMapNode {
  return {
    ...node,
    id: node.id === null ? null : clampString(node.id, limits),
    types: clampStrings(node.types, limits.maxConflictValues, limits),
    name: node.name === null ? null : clampString(node.name, limits),
    properties: clampProperties(node.properties, limits),
    pages: clampStrings(node.pages, limits.maxPages, limits),
    morePages: node.morePages + Math.max(0, node.pages.length - limits.maxPages),
    conflicts: clampConflicts(node.conflicts, limits),
  };
}

function clampEdge(edge: EntityMapEdge, limits: EntityMapLimits): EntityMapEdge {
  return {
    ...edge,
    source: clampString(edge.source, limits),
    target: clampString(edge.target, limits),
    pages: clampStrings(edge.pages, limits.maxPages, limits),
    morePages: edge.morePages + Math.max(0, edge.pages.length - limits.maxPages),
  };
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Keep only edges whose source survived; a dangling edge keeps regardless. */
function edgesFor(
  edges: EntityMapEdge[],
  keys: Set<string>,
  limits: EntityMapLimits,
): EntityMapEdge[] {
  return edges
    .filter((edge) => keys.has(edge.source) && (edge.dangling || keys.has(edge.target)))
    .slice(0, limits.maxEdges);
}

/**
 * Cap an entity map for a copy that travels.
 *
 * Nodes are kept by occurrence count, since an entity declared on 200 pages is
 * the one a reader cares about and a one-off is not. Edges follow the nodes
 * they connect; a dangling edge is kept regardless of its target, because the
 * missing target IS the finding. `pages` is dropped: it is the largest array in
 * the document, neither consumer reads it, and `summary.pagesTotal` /
 * `pagesWithoutEntities` already carry what a reader needs from it.
 *
 * `summary` is NOT recomputed. It describes the site, not this projection, so a
 * clipped map still reports the true node and edge counts. What was dropped is
 * stated in `truncated` rather than left to be inferred by comparing `summary`
 * against two array lengths — an inference every consumer would otherwise have
 * to make independently, and one a renderer that forgets silently turns into
 * "this site has 2,000 entities".
 */
export function projectEntityMap(
  map: EntityMap,
  limits: EntityMapLimits,
  reason: EntityMapTruncation["reason"],
): EntityMap {
  // Rank once, by reach, ties broken on key so the projection is deterministic.
  const ranked = [...map.nodes].sort(
    (a, b) => b.occurrences - a.occurrences || compareKeys(a.key, b.key),
  );

  let budget = Math.min(ranked.length, limits.maxNodes);
  let result = project(ranked, budget, map, limits, reason);

  // Only now does byte size enter, and only when the clamps were not enough.
  // Halving rather than stepping keeps this O(log n) serializations instead of
  // one per dropped node.
  while (budget > 0 && JSON.stringify(result).length > limits.maxBytes) {
    budget = Math.floor(budget / 2);
    result = project(ranked, budget, map, limits, reason);
  }
  return result;
}

/** The publish body. The smallest copy: stored, not read. */
export function slimEntityMapForPublish(map: EntityMap): EntityMap {
  return projectEntityMap(map, ENTITY_MAP_PUBLISH_LIMITS, "publish");
}

/**
 * The copy inlined into an HTML page for the entities viewer.
 *
 * Looser per-node caps than the publish body, because this one is read on the
 * page, and a hard bound on the whole payload, because the browser parses all
 * of it before the graph appears.
 */
export function slimEntityMapForViewer(map: EntityMap): EntityMap {
  return projectEntityMap(map, ENTITY_MAP_VIEWER_LIMITS, "viewer");
}

function project(
  ranked: EntityMapNode[],
  budget: number,
  map: EntityMap,
  limits: EntityMapLimits,
  reason: EntityMapTruncation["reason"],
): EntityMap {
  const kept = ranked
    .slice(0, budget)
    .map((node) => clampNode(node, limits))
    .sort((a, b) => compareKeys(a.key, b.key));
  const keys = new Set(kept.map((node) => node.key));
  const edges = edgesFor(map.edges, keys, limits).map((edge) => clampEdge(edge, limits));
  return {
    ...map,
    site: clampString(map.site, limits),
    nodes: kept,
    edges,
    pages: [],
    truncated: {
      reason,
      nodes: Math.max(0, map.nodes.length - kept.length),
      edges: Math.max(0, map.edges.length - edges.length),
      pages: map.pages.length,
    },
  };
}
