// Entity-map change tracking (#2092, epic #2061 section 9).
//
// A pure function over two finished maps, shared by the CLI's `--diff`, the
// cloud's history view and the MCP tools. No I/O, no clock beyond the stamp on
// the result.
//
// The hard part is not the set arithmetic, it is not lying about it. Two audits
// of the same site rarely cover the same pages: a smaller crawl, a changed page
// cap, a section that started 404ing. Naive set difference reports every entity
// on a page that simply was not visited as "removed", which reads as "the site
// deleted its structured data" and is the single most misleading thing this
// output can say. So an entity is only `removed` when every page that declared
// it was crawled again; otherwise it lands in `notCrawled`.

import {
  ENTITY_MAP_DIFF_FORMAT,
  ENTITY_MAP_DIFF_VERSION,
  type EntityMap,
  type EntityMapDiff,
  type EntityMapDiffConflict,
  type EntityMapDiffDangling,
  type EntityMapDiffIdChange,
  type EntityMapDiffMetric,
  type EntityMapDiffNode,
  type EntityMapDiffOccurrence,
  type EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";

export interface DiffEntityMapsOptions {
  /**
   * Smallest occurrence change worth reporting. 1 means "any change", which is
   * what a diff of two audits usually wants; a history view over months may
   * want more.
   */
  occurrenceThreshold?: number;
  /** Overrides `new Date().toISOString()`. Tests pin it to compare two runs. */
  generatedAt?: string;
}

/** Stable, locale-independent ordering. `localeCompare` is not portable. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toDiffNode(node: EntityMapNode): EntityMapDiffNode {
  return {
    key: node.key,
    id: node.id,
    types: node.types,
    name: node.name,
    occurrences: node.occurrences,
  };
}

/**
 * The identity an entity keeps across gaining or losing an `@id`.
 *
 * Its key changes in that case, by construction — the key IS the `@id` when
 * there is one. Sorted type set plus normalised name is what survives, and it
 * is the same normalisation the builder uses for a synthetic key, so the two
 * agree about what "the same entity" means.
 */
function identityOf(node: EntityMapNode): string | null {
  if (!node.name) return null;
  const types = [...new Set(node.types)].sort(compareStrings);
  // JSON.stringify of the parts, never a delimiter join: `@type` is a
  // site-controlled string, so types ["A+B"] and ["A","B"] would otherwise
  // produce the same signature and pair two unrelated entities.
  return JSON.stringify([types, node.name.trim().replace(/\s+/g, " ").toLowerCase()]);
}

/** Every page a map saw, including the ones that declared nothing. */
function pageSet(map: EntityMap): Set<string> {
  return new Set(map.pages.map((page) => page.url));
}

/**
 * A test for "every page that declared this entity was crawled again".
 *
 * The answer has to come from `map.pages[].declares`, not from `node.pages`:
 * a node's page list is CAPPED in the document and `morePages` counts the rest,
 * so an entity declared on 101 pages carries a 50-page sample. Deciding on the
 * sample calls it removed the moment those 50 are recrawled, no matter what the
 * other 51 now say — the exact false "the site deleted its structured data"
 * this module exists to avoid.
 *
 * Returns false whenever coverage cannot be PROVEN, which is the safe direction:
 * an unproven case is reported as not-crawled, saying less rather than more.
 */
function buildCoverageTest(
  older: EntityMap,
  newerPages: Set<string>
): (node: EntityMapNode) => boolean {
  const declaringPages = buildDeclaringPages(older);
  return (node: EntityMapNode): boolean => {
    const pages = declaringPages(node);
    return pages !== null && pages.every((url) => newerPages.has(url));
  };
}

/**
 * Every page that declared a node, or null when that cannot be established.
 *
 * The answer has to come from `map.pages[].declares`, not from `node.pages`:
 * a node's page list is CAPPED in the document and `morePages` counts the rest,
 * so an entity declared on 101 pages carries a 50-page sample. Deciding on the
 * sample calls it removed the moment those 50 are recrawled, no matter what the
 * other 51 now say — the exact false "the site deleted its structured data"
 * this module exists to avoid.
 *
 * Null whenever the set cannot be PROVEN, which is the safe direction: every
 * caller treats null as "say less".
 */
function buildDeclaringPages(
  map: EntityMap
): (node: EntityMapNode) => string[] | null {
  // A clipped page list (a publish projection caps it) looks exactly like a
  // complete one, so compare it against the count the crawl reported.
  const pageIndexIsComplete =
    map.pages.length > 0 && map.pages.length >= map.summary.pagesTotal;

  const declaredOn = new Map<string, string[]>();
  if (pageIndexIsComplete) {
    for (const page of map.pages) {
      for (const key of page.declares) {
        const pages = declaredOn.get(key);
        if (pages) pages.push(page.url);
        else declaredOn.set(key, [page.url]);
      }
    }
  }

  return (node: EntityMapNode): string[] | null => {
    const indexed = declaredOn.get(node.key);
    // Trusted only when it accounts for every page the NODE claims, including
    // the ones trimmed off its list. The two disagree only in a document
    // someone assembled by hand, and there the conservative answer is right.
    if (indexed && indexed.length >= node.pages.length + node.morePages) {
      return indexed;
    }
    // No usable index. The node's own list is authoritative only when nothing
    // was trimmed off it.
    if (node.morePages > 0) return null;
    return node.pages.length > 0 ? node.pages : null;
  };
}

/**
 * A test for "the entity that replaced this one is declared where it used to be".
 *
 * Recrawling the broken pages is necessary but not sufficient. An audit can
 * visit /a and /b, find the anonymous entity gone from both because the markup
 * was DELETED rather than fixed, and pair it with a properly identified entity
 * that appeared on /c. Page coverage alone calls that a proven fix; it is a
 * regression on /a and /b plus an addition on /c.
 *
 * So the replacement has to be declared on every page the original was. Null
 * anywhere in the evidence chain means partial, for the same reason as above.
 */
function buildReplacementTest(
  older: EntityMap,
  newer: EntityMap
): (before: EntityMapNode, after: EntityMapNode) => boolean {
  const olderDeclaringPages = buildDeclaringPages(older);
  const newerDeclaringPages = buildDeclaringPages(newer);

  return (before: EntityMapNode, after: EntityMapNode): boolean => {
    const was = olderDeclaringPages(before);
    const now = newerDeclaringPages(after);
    if (was === null || now === null) return false;
    const nowSet = new Set(now);
    return was.every((url) => nowSet.has(url));
  };
}

/**
 * The identity of one edge.
 *
 * JSON.stringify of the parts, not a delimiter join: every part is a
 * site-controlled string, so any separator can appear inside one and make two
 * different edges share a key.
 */
function edgeKey(edge: { source: string; predicate: string; target: string }): string {
  return JSON.stringify([edge.source, edge.predicate, edge.target]);
}

function metric(before: number, after: number): EntityMapDiffMetric {
  return { before, after, delta: after - before };
}

/**
 * Compare two entity maps.
 *
 * `older` and `newer` are whole documents; pass them in chronological order.
 * The result is deterministic apart from `generatedAt`: every list is sorted by
 * a stable key.
 */
export function diffEntityMaps(
  older: EntityMap,
  newer: EntityMap,
  options: DiffEntityMapsOptions = {},
): EntityMapDiff {
  const threshold = Math.max(1, options.occurrenceThreshold ?? 1);

  const olderNodes = new Map(older.nodes.map((node) => [node.key, node] as const));
  const newerNodes = new Map(newer.nodes.map((node) => [node.key, node] as const));
  const olderPages = pageSet(older);
  const newerPages = pageSet(newer);
  // Built BEFORE the identity block, not after it: an entity matched as an id
  // change never reaches the added/removed/notCrawled split below, so this is
  // the only place its coverage can be established.
  const fullyRecrawled = buildCoverageTest(older, newerPages);
  const replacedEverywhere = buildReplacementTest(older, newer);

  // ── identity changes ─────────────────────────────────────────────
  // Resolved first: a node that gained an `@id` is NOT an add plus a remove,
  // and counting it as both would double-report the site's most common fix.
  //
  // Only entities that vanished under their old key on one side and appeared
  // under a new one on the other are candidates — an entity still present under
  // the same key did not change identity, and must not be consumed as a match
  // for something else that merely shares its name.
  const groupByIdentity = (
    nodes: readonly EntityMapNode[],
    survived: (key: string) => boolean
  ): Map<string, EntityMapNode[]> => {
    const out = new Map<string, EntityMapNode[]>();
    for (const node of nodes) {
      if (survived(node.key)) continue;
      const identity = identityOf(node);
      if (!identity) continue;
      const group = out.get(identity);
      if (group) group.push(node);
      else out.set(identity, [node]);
    }
    return out;
  };
  const olderCandidates = groupByIdentity(older.nodes, (key) => newerNodes.has(key));
  const newerCandidates = groupByIdentity(newer.nodes, (key) => olderNodes.has(key));

  const gainedId: EntityMapDiffIdChange[] = [];
  const lostId: EntityMapDiffIdChange[] = [];
  const matchedOlder = new Set<string>();
  const matchedNewer = new Set<string>();

  // Insertion order is `older.nodes` order, so this is deterministic.
  for (const [identity, befores] of olderCandidates) {
    const afters = newerCandidates.get(identity);
    if (!afters) continue;
    // Two entities that look identical cannot be paired without guessing, and a
    // wrong pairing invents a rename AND a deletion at once. An ambiguous group
    // stays unmatched and its members fall through to added/removed, which says
    // less but says nothing false.
    if (befores.length !== 1 || afters.length !== 1) continue;
    const before = befores[0]!;
    const node = afters[0]!;

    // Matching on identity says the SAME entity now carries an `@id`. It does
    // not say the pages that were broken are the pages that were fixed: an
    // audit that visited /c and /d can pair them against an id-less entity last
    // seen on /a and /b and report a clean fix while /a and /b still emit the
    // old markup. The pairing is still right — it is the same entity — so the
    // honest move is to report it and qualify it, not to drop it back into
    // added plus removed.
    //
    // BOTH tests, because either alone can be satisfied by a site that is not
    // fixed. Recrawling /a and /b proves nothing if the markup was deleted
    // there and the identified entity turned up on /c; finding it on /c proves
    // nothing about /a and /b if those were never revisited.
    const coverage =
      fullyRecrawled(before) && replacedEverywhere(before, node)
        ? "proven"
        : "partial";

    if (node.id !== null && before.id === null) {
      gainedId.push({
        beforeKey: before.key,
        afterKey: node.key,
        types: node.types,
        name: node.name,
        id: node.id,
        coverage,
      });
    } else if (node.id === null && before.id !== null) {
      lostId.push({
        beforeKey: before.key,
        afterKey: node.key,
        types: node.types,
        name: node.name,
        id: before.id,
        coverage,
      });
    } else {
      continue;
    }
    matchedOlder.add(before.key);
    matchedNewer.add(node.key);
  }

  // ── added / removed / not-crawled ────────────────────────────────
  const added: EntityMapDiffNode[] = [];
  for (const node of newer.nodes) {
    if (olderNodes.has(node.key) || matchedNewer.has(node.key)) continue;
    added.push(toDiffNode(node));
  }

  const removed: EntityMapDiffNode[] = [];
  const notCrawled: EntityMapDiffNode[] = [];
  for (const node of older.nodes) {
    if (newerNodes.has(node.key) || matchedOlder.has(node.key)) continue;
    // Only a proven full recrawl can turn "absent" into "removed". Everything
    // else is conservative: it can call a genuinely removed entity "not
    // crawled" (says less), never the reverse.
    (fullyRecrawled(node) ? removed : notCrawled).push(toDiffNode(node));
  }

  // ── occurrence deltas ────────────────────────────────────────────
  const occurrenceDeltas: EntityMapDiffOccurrence[] = [];
  for (const node of newer.nodes) {
    const before = olderNodes.get(node.key);
    if (!before) continue;
    const delta = node.occurrences - before.occurrences;
    if (Math.abs(delta) < threshold) continue;
    occurrenceDeltas.push({
      key: node.key,
      name: node.name,
      types: node.types,
      before: before.occurrences,
      after: node.occurrences,
      delta,
    });
  }

  // ── conflicts ────────────────────────────────────────────────────
  // Per (entity, property), not per entity: a node that swapped one conflicting
  // property for another has both a new and a resolved finding, and collapsing
  // them to "still conflicted" would hide the fix and the regression together.
  const conflictPairs = (map: EntityMap): Map<string, { node: EntityMapNode; property: string }> => {
    const out = new Map<string, { node: EntityMapNode; property: string }>();
    for (const node of map.nodes) {
      for (const conflict of node.conflicts) {
        out.set(JSON.stringify([node.key, conflict.property]), { node, property: conflict.property });
      }
    }
    return out;
  };
  const olderConflicts = conflictPairs(older);
  const newerConflicts = conflictPairs(newer);

  const newConflicts: EntityMapDiffConflict[] = [];
  for (const [id, entry] of newerConflicts) {
    if (olderConflicts.has(id)) continue;
    newConflicts.push({ key: entry.node.key, name: entry.node.name, property: entry.property });
  }
  const resolvedConflicts: EntityMapDiffConflict[] = [];
  for (const [id, entry] of olderConflicts) {
    if (newerConflicts.has(id)) continue;
    // A conflict on an entity that simply was not crawled again is not a fix.
    if (!newerNodes.has(entry.node.key)) continue;
    // Nor is one whose disagreeing value lived on a page the newer crawl did
    // not visit. A conflict needs two declarations to exist, so surviving on
    // ONE of its pages tells you nothing about whether it was reconciled.
    if (!fullyRecrawled(entry.node)) continue;
    resolvedConflicts.push({ key: entry.node.key, name: entry.node.name, property: entry.property });
  }

  // ── dangling references ──────────────────────────────────────────
  const olderDangling = new Map(
    older.edges.filter((edge) => edge.dangling).map((edge) => [edgeKey(edge), edge] as const),
  );
  const newerDangling = new Map(
    newer.edges.filter((edge) => edge.dangling).map((edge) => [edgeKey(edge), edge] as const),
  );

  const newDangling: EntityMapDiffDangling[] = [];
  for (const [id, edge] of newerDangling) {
    if (olderDangling.has(id)) continue;
    newDangling.push({ source: edge.source, predicate: edge.predicate, target: edge.target });
  }
  const resolvedDangling: EntityMapDiffDangling[] = [];
  for (const [id, edge] of olderDangling) {
    if (newerDangling.has(id)) continue;
    // Same rule as conflicts: gone because the source was not crawled is not a
    // fix, so only count it when the source entity is still there AND every
    // page that declared the source was visited again. The reference lives in
    // one page's markup, and an edge's own `pages` is not always populated
    // (a map reassembled from the project store leaves it empty), so the
    // source's declaring pages are the evidence set that can be relied on.
    const source = olderNodes.get(edge.source);
    if (!newerNodes.has(edge.source) || !source || !fullyRecrawled(source)) continue;
    resolvedDangling.push({ source: edge.source, predicate: edge.predicate, target: edge.target });
  }

  // ── summary ──────────────────────────────────────────────────────
  const summaryDelta: Record<string, EntityMapDiffMetric> = {};
  for (const key of Object.keys(newer.summary).sort(compareStrings)) {
    if (key === "countsByType") continue;
    const before = (older.summary as unknown as Record<string, number>)[key] ?? 0;
    const after = (newer.summary as unknown as Record<string, number>)[key] ?? 0;
    if (typeof before !== "number" || typeof after !== "number") continue;
    summaryDelta[key] = metric(before, after);
  }

  const pagesOnlyInOlder = [...olderPages].filter((url) => !newerPages.has(url)).sort(compareStrings);
  const pagesOnlyInNewer = [...newerPages].filter((url) => !olderPages.has(url)).sort(compareStrings);

  const byKey = (a: { key: string }, b: { key: string }) => compareStrings(a.key, b.key);
  const byAfterKey = (a: EntityMapDiffIdChange, b: EntityMapDiffIdChange) =>
    compareStrings(a.afterKey, b.afterKey);
  const byConflict = (a: EntityMapDiffConflict, b: EntityMapDiffConflict) =>
    compareStrings(a.key, b.key) || compareStrings(a.property, b.property);
  const byEdge = (a: EntityMapDiffDangling, b: EntityMapDiffDangling) =>
    compareStrings(a.source, b.source) ||
    compareStrings(a.target, b.target) ||
    compareStrings(a.predicate, b.predicate);

  return {
    format: ENTITY_MAP_DIFF_FORMAT,
    version: ENTITY_MAP_DIFF_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    older: {
      site: older.site,
      generatedAt: older.generatedAt,
      nodeCount: older.summary.nodeCount,
      pagesTotal: older.summary.pagesTotal,
    },
    newer: {
      site: newer.site,
      generatedAt: newer.generatedAt,
      nodeCount: newer.summary.nodeCount,
      pagesTotal: newer.summary.pagesTotal,
    },
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    notCrawled: notCrawled.sort(byKey),
    gainedId: gainedId.sort(byAfterKey),
    lostId: lostId.sort(byAfterKey),
    occurrenceDeltas: occurrenceDeltas.sort(byKey),
    newConflicts: newConflicts.sort(byConflict),
    resolvedConflicts: resolvedConflicts.sort(byConflict),
    newDangling: newDangling.sort(byEdge),
    resolvedDangling: resolvedDangling.sort(byEdge),
    summaryDelta,
    pagesOnlyInOlder,
    pagesOnlyInNewer,
  };
}
