// Bound an entity map for the publish body (#2061).
//
// The files on disk stay complete. The hosted copy travels inside the report
// payload, which is measured against a hard size gate, so it keeps the part
// that carries the findings and drops the tail.

import {
  ENTITY_MAP_PUBLISH_LIMITS,
  type EntityMap,
} from "@squirrelscan/core-contracts/entity-map";

/**
 * Cap an entity map for publishing.
 *
 * Nodes are kept by occurrence count, since an entity declared on 200 pages is
 * the one a reader cares about and a one-off is not. Edges are then filtered to
 * the ones whose source survived, so the hosted graph has no edge pointing at
 * nothing; a dangling edge is kept regardless of its target, because the
 * missing target is the finding. `pages` is dropped: it is the largest array in
 * the document and `summary.pagesTotal` / `pagesWithoutEntities` already carry
 * what a reader needs from it.
 *
 * `summary` is NOT recomputed. It describes the site, not this projection, so a
 * hosted map still reports the true node and edge counts and a consumer can
 * tell it was clipped by comparing them against the array lengths.
 */
export function slimEntityMapForPublish(map: EntityMap): EntityMap {
  const withinLimits =
    map.nodes.length <= ENTITY_MAP_PUBLISH_LIMITS.maxNodes &&
    map.edges.length <= ENTITY_MAP_PUBLISH_LIMITS.maxEdges &&
    map.pages.length === 0;
  if (withinLimits) return map;

  // Rank by occurrences, break ties on key so the projection is deterministic,
  // then restore the document's key order.
  const keptNodes = [...map.nodes]
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, ENTITY_MAP_PUBLISH_LIMITS.maxNodes)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const keptKeys = new Set(keptNodes.map((node) => node.key));
  const keptEdges = map.edges
    .filter(
      (edge) =>
        keptKeys.has(edge.source) && (edge.dangling || keptKeys.has(edge.target)),
    )
    .slice(0, ENTITY_MAP_PUBLISH_LIMITS.maxEdges);

  return {
    ...map,
    nodes: keptNodes,
    edges: keptEdges,
    pages: [],
  };
}
