// Entity map persistence (#2091).
//
// The map is built on every audit and every analyze — there is no flag. This
// module is the seam between the built document and the project store, so the
// audit and analyze controllers write it the same way.

import type { EntityMap } from "@squirrelscan/audit-engine/entity-map";

import { Effect } from "effect";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";

import { logger } from "@/utils/logger";

/**
 * Persist an already-built map for one crawl.
 *
 * Never throws: a store write that fails must not lose a finished audit, and
 * the report still carries the map even when the rows did not land.
 */
export async function storeEntityMap(options: {
  storage: SQLiteStorage;
  crawlId: string;
  map: EntityMap;
}): Promise<void> {
  const { map } = options;

  // The document caps each node's `pages[]`; the store keeps the full list, so
  // rebuild the (entity, page) pairs from the per-page record rather than from
  // the capped arrays.
  const occurrences: Array<{ key: string; normalizedUrl: string }> = [];
  for (const page of map.pages) {
    for (const key of page.declares) {
      occurrences.push({ key, normalizedUrl: page.url });
    }
  }

  try {
    await Effect.runPromise(
      options.storage.saveEntityMap(options.crawlId, {
        nodes: map.nodes,
        edges: map.edges,
        occurrences,
      })
    );
    logger.debug(
      "entity map stored",
      `${map.summary.nodeCount} nodes, ${map.summary.edgeCount} edges, ${occurrences.length} occurrences`
    );
  } catch (error) {
    logger.warn(
      `Could not store the entity map: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
