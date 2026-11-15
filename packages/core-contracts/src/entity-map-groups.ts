// Structural grouping for a summarized entity map (#407).
//
// A byte budget that samples a catalogue re-shows the same shape hundreds of
// times and then reports the rest as dropped. Grouping states the shape once,
// with its true count, and keeps a few real nodes as exemplars.
//
// Contract: a group is NEVER a node. It lives in `EntityMap.groups`, a separate
// array, so any consumer that only reads `nodes` and `edges` cannot render a
// group as one entity named after many. The exemplars are ordinary nodes that
// stay in `nodes`; `exemplars` lists their keys.

import type { EntityMap, EntityMapGroup, EntityMapNode } from "./entity-map";

/** Group key: sorted type set, sorted outgoing predicate set, page-local flag. */
export function groupSignature(node: EntityMapNode, predicates: readonly string[]): string {
  const types = [...new Set(node.types)].sort().join("|");
  const preds = [...new Set(predicates)].sort().join("|");
  return `${types}#${preds}#${node.pageLocal ? "local" : "site"}`;
}

/** Outgoing predicate set per node key. */
function outgoingPredicates(map: EntityMap): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const edge of map.edges) {
    const list = out.get(edge.source);
    if (list) list.push(edge.predicate);
    else out.set(edge.source, [edge.predicate]);
  }
  return out;
}

export interface NodeGroups {
  /** Signature of every node, by key. */
  signatureOf: Map<string, string>;
  /** Members per signature, only for groups of at least `minGroupSize`. */
  members: Map<string, EntityMapNode[]>;
}

/** Partition a map's nodes by structural signature. */
export function groupNodes(map: EntityMap, minGroupSize: number): NodeGroups {
  const predicates = outgoingPredicates(map);
  const signatureOf = new Map<string, string>();
  const all = new Map<string, EntityMapNode[]>();
  for (const node of map.nodes) {
    const signature = groupSignature(node, predicates.get(node.key) ?? []);
    signatureOf.set(node.key, signature);
    const list = all.get(signature);
    if (list) list.push(node);
    else all.set(signature, [node]);
  }
  const members = new Map<string, EntityMapNode[]>();
  for (const [signature, list] of all) {
    if (list.length >= minGroupSize) members.set(signature, list);
  }
  return { signatureOf, members };
}

/**
 * The group records for a projection. `count` is the true member count in the
 * full map; `exemplars` are the members that survived into `kept`.
 */
export function buildGroups(
  map: EntityMap,
  groups: NodeGroups,
  kept: readonly EntityMapNode[],
): EntityMapGroup[] {
  const predicates = outgoingPredicates(map);
  const keptKeys = new Set(kept.map((node) => node.key));
  const out: EntityMapGroup[] = [];
  for (const [signature, list] of groups.members) {
    const exemplars = list.filter((node) => keptKeys.has(node.key)).map((node) => node.key);
    const first = list[0]!;
    out.push({
      kind: "group",
      signature,
      types: [...new Set(first.types)].sort(),
      predicates: [...new Set(predicates.get(first.key) ?? [])].sort(),
      pageLocal: first.pageLocal,
      count: list.length,
      occurrences: list.reduce((sum, node) => sum + node.occurrences, 0),
      exemplars: exemplars.sort(),
      omitted: list.length - exemplars.length,
    });
  }
  return out.sort(
    (a, b) =>
      b.count - a.count || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0),
  );
}
