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
// every string, sample the conflict and page arrays, then sample the nodes
// themselves until the serialized document fits.
//
// That last sample is the part with judgement in it, and getting it wrong is
// quiet: the document still validates, still reports true totals in `summary`,
// and simply describes a different site than the one audited. See
// `projectEntityMap` for the tiers.
//
// Lives in core-contracts rather than in the engine because `@squirrelscan/report`
// needs it for the viewer payload and the engine depends on report, never the
// reverse. The engine re-exports it from `./entity-map/slim`.

import {
  ENTITY_MAP_DEFAULT_PAGE_LOCAL_SHARE,
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

// ── Sampling ───────────────────────────────────────────────────────
//
// Ranking on occurrences alone spent the whole budget on whichever type sorted
// first. On a store that declares its entities per page — Shopify, WooCommerce,
// most of the CMS world — every Product, Offer, BreadcrumbList and WebPage
// occurs exactly once, so the ranking degenerated to its tie-break on `key`, and
// what that did depended on the theme. Both shapes measured on a 1,000-page
// synthetic store:
//
//   - page-local entities with no `@id` take `anon:`/`blank:` keys, which sort
//     ahead of every `id:` key: 748 BreadcrumbLists, the Organization, the Brand
//     and ZERO edges. A hosted graph of disconnected crumbs.
//   - `@id` everywhere: keys group by page URL, so the types interleave and the
//     body looks like a fair sample while being the alphabetically-first pages:
//     250 BreadcrumbLists, 249 Products, 249 WebPages, no Offers, two thirds of
//     it page-local. Neither grew more representative at 5,000 pages.
//
// So the budget is allocated in three tiers instead, and stratified by type
// inside each one.

/** Edges touching a node, inbound and outbound: how connected it is. */
function degreesByKey(edges: EntityMapEdge[]): Map<string, number> {
  // A Map, not a plain object: type names and node keys are site-controlled.
  const out = new Map<string, number>();
  for (const edge of edges) {
    out.set(edge.source, (out.get(edge.source) ?? 0) + 1);
    if (!edge.dangling) out.set(edge.target, (out.get(edge.target) ?? 0) + 1);
  }
  return out;
}

type NodeCompare = (a: EntityMapNode, b: EntityMapNode) => number;

/**
 * Nodes grouped by primary type, each group in priority order.
 *
 * Groups are ordered by their own best node, so a budget too small to reach
 * every type still spends itself on the types that reach furthest.
 */
function bucketsByType(nodes: EntityMapNode[], compare: NodeCompare): EntityMapNode[][] {
  const byType = new Map<string, EntityMapNode[]>();
  for (const node of nodes) {
    const type = node.types[0] ?? "";
    const bucket = byType.get(type);
    if (bucket) bucket.push(node);
    else byType.set(type, [node]);
  }
  const buckets = [...byType.entries()].map(([type, bucket]) => {
    bucket.sort(compare);
    return { type, bucket };
  });
  buckets.sort((a, b) => compare(a.bucket[0]!, b.bucket[0]!) || compareKeys(a.type, b.type));
  return buckets.map(({ bucket }) => bucket);
}

/**
 * Round-robin across the type buckets until the budget runs out.
 *
 * Equal shares with redistribution, deliberately, rather than shares
 * proportional to how many nodes each type has: proportional is what the old
 * ranking effectively did, and on a 5,000-page store it hands 749 of 750 slots
 * to Product and leaves the one Organization the map exists to show fighting
 * for the last. A type that runs out early gives its remaining slots back to
 * the types that still have nodes, so nothing is wasted on a rare type.
 */
function takeStratified(buckets: EntityMapNode[][], budget: number): EntityMapNode[] {
  const taken: EntityMapNode[] = [];
  for (let round = 0; taken.length < budget; round += 1) {
    let progressed = false;
    for (const bucket of buckets) {
      if (taken.length >= budget) break;
      const node = bucket[round];
      if (node === undefined) continue;
      taken.push(node);
      progressed = true;
    }
    if (!progressed) break;
  }
  return taken;
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
 * The surviving nodes are a SAMPLE of the map, not its head. Three tiers, in
 * order:
 *
 *   1. shared subjects — entities declared on more than one page. The
 *      Organization, the WebSite, the Brand every product points at: the things
 *      the map exists to show, ranked by occurrences then by degree.
 *   2. one-off subjects — everything else that is not page-local, stratified by
 *      type so a 5,000-product catalogue cannot crowd out its own Offers,
 *      ranked inside a type by degree, since a connected node explains more of
 *      the graph than an isolated one.
 *   3. page-local entities — the per-page BreadcrumbList and WebPage a graph
 *      hides by default. Capped at `maxPageLocalShare` of the budget, because
 *      there is one of them per page and they say nothing about the site.
 *
 * Edges follow the nodes they connect; a dangling edge is kept regardless of
 * its target, because the missing target IS the finding. `pages` is dropped: it
 * is the largest array in the document, neither consumer reads it, and
 * `summary.pagesTotal` / `pagesWithoutEntities` already carry what a reader
 * needs from it.
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
  const degrees = degreesByKey(map.edges);
  const degree = (node: EntityMapNode): number => degrees.get(node.key) ?? 0;
  const byReach: NodeCompare = (a, b) =>
    b.occurrences - a.occurrences || degree(b) - degree(a) || compareKeys(a.key, b.key);
  const byDegree: NodeCompare = (a, b) =>
    degree(b) - degree(a) || b.occurrences - a.occurrences || compareKeys(a.key, b.key);

  const shared: EntityMapNode[] = [];
  const oneOff: EntityMapNode[] = [];
  const pageLocal: EntityMapNode[] = [];
  for (const node of map.nodes) {
    if (node.pageLocal) pageLocal.push(node);
    else if (node.occurrences > 1) shared.push(node);
    else oneOff.push(node);
  }

  // Ranked once; only the budget moves between attempts.
  const sharedBuckets = bucketsByType(shared, byReach);
  const oneOffBuckets = bucketsByType(oneOff, byDegree);
  const pageLocalBuckets = bucketsByType(pageLocal, byReach);
  const pageLocalShare = limits.maxPageLocalShare ?? ENTITY_MAP_DEFAULT_PAGE_LOCAL_SHARE;

  const select = (budget: number): EntityMapNode[] => {
    // Reserved, not merely capped: the page-local slice is set aside first so
    // tier 3 still gets its share, and held to what the pool actually holds so
    // a site with none of them spends the whole budget on subjects.
    const localBudget = Math.min(pageLocal.length, Math.floor(budget * pageLocalShare));
    const subjects = takeStratified(sharedBuckets, budget - localBudget);
    const rest = takeStratified(oneOffBuckets, budget - localBudget - subjects.length);
    // Whatever tiers 1 and 2 could not fill falls back here rather than going
    // unspent, so a page-local-heavy map still publishes a full budget.
    const locals = takeStratified(pageLocalBuckets, budget - subjects.length - rest.length);
    return [...subjects, ...rest, ...locals];
  };

  let budget = Math.min(map.nodes.length, limits.maxNodes);
  let result = project(select(budget), map, limits, reason);
  let size = JSON.stringify(result).length;

  // Only now does byte size enter, and only when the clamps were not enough.
  // Scaled to the overshoot rather than halved: halving cost a 5,000-page map
  // half its budget (750 to 375 nodes) to shed 4% of its bytes. Shrinking the
  // budget shrinks every tier and every type bucket with it, so the mix of the
  // sample survives the shrink; only its resolution drops. `budget - 1` bounds
  // the loop when the fixed overhead alone is over the limit.
  while (budget > 0 && size > limits.maxBytes) {
    const scaled = Math.floor((budget * limits.maxBytes) / size);
    budget = Math.max(0, Math.min(budget - 1, scaled));
    result = project(select(budget), map, limits, reason);
    size = JSON.stringify(result).length;
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
  selected: EntityMapNode[],
  map: EntityMap,
  limits: EntityMapLimits,
  reason: EntityMapTruncation["reason"],
): EntityMap {
  const kept = selected
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
