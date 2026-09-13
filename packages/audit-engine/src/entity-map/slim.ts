// Bound an entity map for the publish body (#2091).
//
// The local document stays complete — `-f json` is the canonical export. The
// hosted copy travels inside the report payload, which is measured against a
// hard size gate, so it keeps the part that carries the findings and drops the
// tail.
//
// Counts alone do NOT bound bytes. Every string in this document is a
// site-controlled value, so fifty conflict values of a megabyte each pass a
// node-count cap and still blow the payload limit. Three layers, cheapest
// first: clamp every string, sample the conflict and page arrays, then drop
// lowest-occurrence nodes until the serialized document fits.

import {
  ENTITY_MAP_PUBLISH_LIMITS,
  type EntityMap,
  type EntityMapConflict,
  type EntityMapEdge,
  type EntityMapNode,
  type EntityMapProperties,
} from "@squirrelscan/core-contracts/entity-map";

const LIMITS = ENTITY_MAP_PUBLISH_LIMITS;

function clampString(value: string): string {
  return value.length > LIMITS.maxStringLength
    ? `${value.slice(0, LIMITS.maxStringLength - 1)}…`
    : value;
}

function clampStrings(values: string[], max: number): string[] {
  return values.slice(0, max).map(clampString);
}

/** Every property value clamped, and the array-valued ones sampled. */
function clampProperties(properties: EntityMapProperties): EntityMapProperties {
  const out: EntityMapProperties = {};
  if (properties.name !== undefined) out.name = clampString(properties.name);
  if (properties.url !== undefined) out.url = clampString(properties.url);
  if (properties.logo !== undefined) out.logo = clampString(properties.logo);
  if (properties.image !== undefined) {
    out.image = clampStrings(properties.image, LIMITS.maxConflictValues);
  }
  if (properties.sameAs !== undefined) {
    out.sameAs = clampStrings(properties.sameAs, LIMITS.maxConflictValues);
  }
  if (properties.telephone !== undefined) out.telephone = clampString(properties.telephone);
  if (properties.email !== undefined) out.email = clampString(properties.email);
  if (properties.address !== undefined) out.address = clampString(properties.address);
  if (properties.description !== undefined) {
    out.description = clampString(properties.description);
  }
  return out;
}

function clampConflicts(conflicts: EntityMapConflict[]): EntityMapConflict[] {
  return conflicts.map((conflict) => ({
    property: conflict.property,
    values: conflict.values.slice(0, LIMITS.maxConflictValues).map((value) => ({
      value: clampString(value.value),
      pages: clampStrings(value.pages, LIMITS.maxPages),
      // The dropped page URLs are still counted, so a reader sees the real
      // spread rather than a number that shrank with the payload.
      morePages:
        value.morePages + Math.max(0, value.pages.length - LIMITS.maxPages),
    })),
  }));
}

function clampNode(node: EntityMapNode): EntityMapNode {
  return {
    ...node,
    id: node.id === null ? null : clampString(node.id),
    types: clampStrings(node.types, LIMITS.maxConflictValues),
    name: node.name === null ? null : clampString(node.name),
    properties: clampProperties(node.properties),
    pages: clampStrings(node.pages, LIMITS.maxPages),
    morePages: node.morePages + Math.max(0, node.pages.length - LIMITS.maxPages),
    conflicts: clampConflicts(node.conflicts),
  };
}

function clampEdge(edge: EntityMapEdge): EntityMapEdge {
  return {
    ...edge,
    source: clampString(edge.source),
    target: clampString(edge.target),
    pages: clampStrings(edge.pages, LIMITS.maxPages),
    morePages: edge.morePages + Math.max(0, edge.pages.length - LIMITS.maxPages),
  };
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Keep only edges whose source survived; a dangling edge keeps regardless. */
function edgesFor(edges: EntityMapEdge[], keys: Set<string>): EntityMapEdge[] {
  return edges
    .filter((edge) => keys.has(edge.source) && (edge.dangling || keys.has(edge.target)))
    .slice(0, LIMITS.maxEdges);
}

/**
 * Cap an entity map for publishing.
 *
 * Nodes are kept by occurrence count, since an entity declared on 200 pages is
 * the one a reader cares about and a one-off is not. Edges follow the nodes
 * they connect; a dangling edge is kept regardless of its target, because the
 * missing target IS the finding. `pages` is dropped: it is the largest array in
 * the document and `summary.pagesTotal` / `pagesWithoutEntities` already carry
 * what a reader needs from it.
 *
 * `summary` is NOT recomputed. It describes the site, not this projection, so a
 * hosted map still reports the true node and edge counts and a consumer can
 * tell it was clipped by comparing them against the array lengths.
 */
export function slimEntityMapForPublish(map: EntityMap): EntityMap {
  // Rank once, by reach, ties broken on key so the projection is deterministic.
  const ranked = [...map.nodes].sort(
    (a, b) => b.occurrences - a.occurrences || compareKeys(a.key, b.key),
  );

  let budget = Math.min(ranked.length, LIMITS.maxNodes);
  let result = project(ranked, budget, map);

  // Only now does byte size enter, and only when the clamps were not enough.
  // Halving rather than stepping keeps this O(log n) serializations instead of
  // one per dropped node.
  while (budget > 0 && JSON.stringify(result).length > LIMITS.maxBytes) {
    budget = Math.floor(budget / 2);
    result = project(ranked, budget, map);
  }
  return result;
}

function project(ranked: EntityMapNode[], budget: number, map: EntityMap): EntityMap {
  const kept = ranked.slice(0, budget).map(clampNode).sort((a, b) => compareKeys(a.key, b.key));
  const keys = new Set(kept.map((node) => node.key));
  return {
    ...map,
    site: clampString(map.site),
    nodes: kept,
    edges: edgesFor(map.edges, keys).map(clampEdge),
    pages: [],
  };
}
