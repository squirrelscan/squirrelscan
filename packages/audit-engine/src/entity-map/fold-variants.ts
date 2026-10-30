// Query-string variants in the entity map (#1350, follow-up to #858).
//
// The map is built from every crawled page, so `/contact?subject=Billing` is a page of its own in
// `pages`, in each node's and edge's `pages`, and in `summary.pagesTotal`, while the report counts it
// with `/contact`. This folds the map the same way, on a COPY at report time: a variant's declarations
// and references are added to its canonical page and the variant is no longer listed, so the map's
// page counts agree with `meta.totalPages`. Nodes, edges, occurrences and every other count are
// unchanged (a variant's entities are still declared, just on the page the report counts them under).
//
// Reaches no further than `@squirrelscan/core-contracts`: the private API imports this barrel.

import type { EntityMap, EntityMapPage } from "@squirrelscan/core-contracts";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `pages` with each variant replaced by its canonical page, de-duplicated and sorted like the builder's. */
function foldPages(pages: readonly string[], variantOf: ReadonlyMap<string, string>): string[] {
  return [...new Set(pages.map((p) => variantOf.get(p) ?? p))].sort(compare);
}

/**
 * A copy of `map` with every page in `variantOf` (variant -> canonical) counted under its canonical page.
 * Returns `map` itself when there is nothing to fold, so a site with no variants is byte-identical.
 */
export function foldEntityMapVariants(map: EntityMap, variantOf: ReadonlyMap<string, string>): EntityMap {
  if (variantOf.size === 0 || !map.pages.some((p) => variantOf.has(p.url))) return map;

  const byUrl = new Map<string, { declares: Set<string>; references: Set<string>; entityCount: number }>();
  for (const page of map.pages) {
    const url = variantOf.get(page.url) ?? page.url;
    const into = byUrl.get(url) ?? { declares: new Set<string>(), references: new Set<string>(), entityCount: 0 };
    for (const key of page.declares) into.declares.add(key);
    for (const key of page.references) into.references.add(key);
    // The canonical page and its variants carry the same template's entities; the larger count is the page's.
    into.entityCount = Math.max(into.entityCount, page.entityCount);
    byUrl.set(url, into);
  }
  const pages: EntityMapPage[] = [...byUrl]
    .sort(([a], [b]) => compare(a, b))
    .map(([url, page]) => ({
      url,
      declares: [...page.declares].sort(compare),
      // A key the page declares is not also a reference.
      references: [...page.references].filter((key) => !page.declares.has(key)).sort(compare),
      entityCount: page.entityCount,
    }));

  return {
    ...map,
    summary: {
      ...map.summary,
      pagesTotal: pages.length,
      pagesWithoutEntities: pages.filter((p) => p.entityCount === 0).length,
    },
    nodes: map.nodes.map((node) => ({
      ...node,
      pages: foldPages(node.pages, variantOf),
      conflicts: node.conflicts.map((conflict) => ({
        ...conflict,
        values: conflict.values.map((v) => ({ ...v, pages: foldPages(v.pages, variantOf) })),
      })),
    })),
    edges: map.edges.map((edge) => ({ ...edge, pages: foldPages(edge.pages, variantOf) })),
    pages,
  };
}
