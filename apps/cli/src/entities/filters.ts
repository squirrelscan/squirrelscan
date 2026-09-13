// Filters for `squirrel entities` (#2092): --type, --page and --problem.
//
// They apply to EVERY output format, which is the whole reason they live here
// and not in a renderer: `-f graphml --type Organization` has to hand Gephi the
// filtered graph, not the whole one with a filtered table beside it. So a
// filter produces a new `EntityMap`, and every format renders a map.

import type {
  EntityMap,
  EntityMapNode,
} from "@squirrelscan/audit-engine/entity-map";

/** The problem classes `--problem` accepts. */
export const ENTITY_PROBLEMS = [
  "no-id",
  "conflict",
  "dangling",
  "single-page",
  "split-identity",
] as const;

export type EntityProblem = (typeof ENTITY_PROBLEMS)[number];

export interface EntityFilters {
  /** `@type` values; a node matches if it carries ANY of them. */
  types?: string[];
  /** Page URLs or prefixes; a node matches if ANY declaring page matches. */
  pages?: string[];
  /** Problem classes; a node matches if it has ANY of them. */
  problems?: EntityProblem[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isEntityProblem(value: string): value is EntityProblem {
  return (ENTITY_PROBLEMS as readonly string[]).includes(value);
}

/** True when no filter would narrow anything. */
export function hasEntityFilters(filters: EntityFilters): boolean {
  return Boolean(
    filters.types?.length || filters.pages?.length || filters.problems?.length
  );
}

/**
 * Entities sharing a type set and a normalised name across two or more keys.
 *
 * This is the finding the whole map exists for: one thing the site declares
 * under several identities, which a search engine reads as several things. It
 * is a property of a PAIR, so unlike every other problem it cannot be decided
 * from one node and has to be computed over the map first.
 */
function splitIdentityKeys(map: EntityMap): Set<string> {
  const byIdentity = new Map<string, string[]>();
  for (const node of map.nodes) {
    if (!node.name) continue;
    // JSON.stringify of the parts, never a delimiter join: `@type` is a
    // site-controlled string, so types ["A+B"] and ["A","B"] would otherwise
    // produce the same signature and be reported as one split identity. Same
    // signature as the engine's diff, deliberately.
    const identity = JSON.stringify([
      [...new Set(node.types)].sort(compareStrings),
      node.name.trim().replace(/\s+/g, " ").toLowerCase(),
    ]);
    const keys = byIdentity.get(identity);
    if (keys) keys.push(node.key);
    else byIdentity.set(identity, [node.key]);
  }
  const out = new Set<string>();
  for (const keys of byIdentity.values()) {
    if (keys.length > 1) for (const key of keys) out.add(key);
  }
  return out;
}

/**
 * Keys of every entity declared on a page matching one of the patterns.
 *
 * The map's per-page `declares` is the only UNCAPPED record of which entity is
 * on which page: a node's own `pages` is capped at 50 in the document, so an
 * entity declared on the 51st matching page is invisible to it.
 *
 * Empty when the map carries no pages, which is what a publish projection and
 * a pre-#2091 export both look like.
 */
function keysOnMatchingPages(map: EntityMap, patterns: string[]): Set<string> {
  const keys = new Set<string>();
  for (const page of map.pages) {
    if (
      !patterns.some(
        (pattern) => page.url === pattern || page.url.includes(pattern)
      )
    ) {
      continue;
    }
    for (const key of page.declares) keys.add(key);
  }
  return keys;
}

function matchesOwnPages(node: EntityMapNode, patterns: string[]): boolean {
  return node.pages.some((page) =>
    patterns.some((pattern) => page === pattern || page.includes(pattern))
  );
}

function matchesProblem(
  node: EntityMapNode,
  problems: EntityProblem[],
  split: Set<string>
): boolean {
  return problems.some((problem) => {
    switch (problem) {
      case "no-id":
        // Declared on several pages with nothing to reconcile them by. A
        // one-page entity without an `@id` is ordinary, not a problem.
        return node.id === null && node.pages.length + node.morePages > 1;
      case "conflict":
        return node.conflicts.length > 0;
      case "dangling":
        return node.danglingRefs > 0;
      case "single-page":
        return node.pages.length + node.morePages === 1;
      case "split-identity":
        return split.has(node.key);
    }
    // Unreachable for a valid EntityProblem — the switch is exhaustive over the
    // union and the CLI rejects anything else before it gets here. Present
    // because the linter cannot see that, and falling through silently would
    // make an unknown problem match everything rather than nothing.
    return false;
  });
}

/**
 * Apply the filters, returning a map containing only the matching entities.
 *
 * Edges follow their endpoints, and the summary is RECOMPUTED over what
 * survived — a filtered view that kept the whole site's counts would be
 * actively misleading, since the first thing a reader does with
 * `--problem conflict` is look at the conflict count.
 *
 * `pages` is left whole: it describes the crawl, not the selection, and
 * `pagesWithoutEntities` means nothing once entities have been filtered out.
 */
export function filterEntityMap(
  map: EntityMap,
  filters: EntityFilters
): EntityMap {
  if (!hasEntityFilters(filters)) return map;

  const split = filters.problems?.includes("split-identity")
    ? splitIdentityKeys(map)
    : new Set<string>();
  const pageKeys = filters.pages?.length
    ? keysOnMatchingPages(map, filters.pages)
    : new Set<string>();

  const nodes = map.nodes.filter((node) => {
    if (filters.types?.length) {
      const wanted = filters.types.map((type) => type.toLowerCase());
      if (!node.types.some((type) => wanted.includes(type.toLowerCase())))
        return false;
    }
    if (filters.pages?.length) {
      // The UNION of the two records, never one or the other. Each is
      // incomplete in a different way — the page index is absent from a
      // clipped export, the node's own list is truncated past 50 — so taking
      // either alone drops entities that are genuinely on the page.
      const onPage =
        pageKeys.has(node.key) || matchesOwnPages(node, filters.pages);
      if (!onPage) return false;
    }
    if (
      filters.problems?.length &&
      !matchesProblem(node, filters.problems, split)
    )
      return false;
    return true;
  });

  const keys = new Set(nodes.map((node) => node.key));
  // A dangling edge is kept when its SOURCE survived: its target is not a node
  // by definition, so requiring both ends would drop every one of them.
  const edges = map.edges.filter(
    (edge) => keys.has(edge.source) && (edge.dangling || keys.has(edge.target))
  );

  const typeCounts = new Map<string, number>();
  let nodesWithStableId = 0;
  let pageLocalCount = 0;
  let nodesWithoutIdCount = 0;
  let conflictCount = 0;
  for (const node of nodes) {
    if (node.id) nodesWithStableId += 1;
    if (node.pageLocal) pageLocalCount += 1;
    if (node.conflicts.length > 0) conflictCount += 1;
    if (!node.id && node.pages.length + node.morePages > 1)
      nodesWithoutIdCount += 1;
    for (const type of node.types) {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + node.occurrences);
    }
  }

  return {
    ...map,
    summary: {
      ...map.summary,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((edge) => edge.dangling).length,
      nodesWithStableId,
      stableIdShare: nodes.length === 0 ? 0 : nodesWithStableId / nodes.length,
      pageLocalCount,
      nodesWithoutIdCount,
      conflictCount,
      countsByType: Object.fromEntries(
        [...typeCounts.entries()].sort((a, b) => compareStrings(a[0], b[0]))
      ),
    },
    nodes,
    edges,
  };
}

/**
 * Find one entity by `@id`, key or name.
 *
 * Tried in that order and exactly before loosely, so a site with an entity
 * literally named after another's `@id` cannot shadow it. The name match is
 * case-insensitive because nobody types a display name exactly.
 */
export function findEntity(
  map: EntityMap,
  query: string
): EntityMapNode | null {
  const needle = query.trim();
  if (!needle) return null;

  return (
    map.nodes.find((node) => node.id === needle) ??
    map.nodes.find((node) => node.key === needle) ??
    map.nodes.find((node) => node.key === `id:${needle}`) ??
    map.nodes.find(
      (node) => node.name?.toLowerCase() === needle.toLowerCase()
    ) ??
    map.nodes.find((node) =>
      node.name?.toLowerCase().includes(needle.toLowerCase())
    ) ??
    null
  );
}

/** Split a repeatable, comma-separated CLI flag into its values. */
export function splitListFlag(raw: string | string[] | undefined): string[] {
  return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
