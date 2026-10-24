// Where an element sits on a classified page: its region and its section.
//
// The question a consumer asks is about ONE element: which part of the page is
// this link in (is it in a comment thread?), which part holds this finding
// (name the fix's place on the page). Labels sit
// on candidate nodes, at most 400 per page, so the answer is read from the
// element's nearest labelled ancestor:
//
//   region:  the nearest ancestor-or-self node with a region answer (markup,
//            or a model answer over its class threshold); null when none is;
//   section: the comments rule's thread when the element sits in one (it wins,
//            as in classifyDocument, and needs no candidate: big threads are
//            often past the cap), else the nearest node with a section answer.
//
//   const elements: unknown[] = [];
//   const result = classifyDocument(document, url, { model, elementsOut: elements });
//   const place = elementPlacer(result, elements);
//   place(anchor); // { region: {label: "content_block", ...}, section: {label: "comments", ...} }

import { commentRule } from "./comments-rule";
import type { NodePrediction, PageClassification, SectionPrediction, Source } from "./predict";
import type { RegionLabel } from "./rules-fallback";

export interface RegionPlacement {
  label: RegionLabel;
  confidence: number;
  source: Source;
  /** The node that answered, and its tag. */
  nodeId: number;
  tag: string;
  /** Element steps from the placed element up to that node (0 = itself). */
  hops: number;
}

export interface SectionPlacement extends SectionPrediction {
  /** The node that answered, or for the comments rule its matched container;
   *  null when that container is outside the walk (inside <svg>, <template>
   *  and the like). */
  nodeId: number | null;
  hops: number;
}

export interface Placement {
  region: RegionPlacement | null;
  section: SectionPlacement | null;
  /**
   * A comment thread sits above the element but too far up for the rule to name (a hostile page
   * can nest one arbitrarily deep). Region and section are then both null on purpose: the element
   * is in a thread of unknown extent, so a consumer must say "unknown", never fall back to a
   * region such as page content.
   */
  truncated?: true;
}

interface Walkable {
  parentElement?: Walkable | null;
}

/**
 * A lookup from element to placement for one classified page. `elements` is
 * the walk `classifyDocument` filled through `elementsOut` (index = nodeId).
 * An element from another parse of the page gets no region and no model
 * section (none of its ancestors are in the walk); the comments rule still
 * reads its markup, with a null nodeId. The page must not change while the
 * placer is in use: the rule's lookups are memoized for its life.
 */
export function elementPlacer(
  result: PageClassification,
  elements: readonly unknown[],
): (element: unknown) => Placement {
  const idOf = new Map<unknown, number>();
  for (let i = 0; i < elements.length; i++) idOf.set(elements[i], i);
  const byId = new Map<number, NodePrediction>();
  for (const node of result.nodes) byId.set(node.nodeRef.nodeId, node);
  const rule = commentRule();

  return (element: unknown): Placement => {
    let region: RegionPlacement | null = null;
    let section: SectionPlacement | null = null;
    const found = element ? rule.lookup(element as Element) : null;
    if (found && "truncated" in found) return { region: null, section: null, truncated: true };
    const match = found;
    if (match) {
      section = {
        label: match.label,
        confidence: 1,
        source: "rules",
        evidence: match.token,
        nodeId: idOf.get(match.container) ?? null,
        hops: match.hops,
      };
    }
    let el = element as Walkable | null | undefined;
    for (let hops = 0; el && (region === null || section === null); hops++) {
      const id = idOf.get(el);
      const node = id === undefined ? undefined : byId.get(id);
      if (node) {
        if (region === null && node.label !== "unknown") {
          region = {
            label: node.label,
            confidence: node.confidence,
            source: node.source,
            nodeId: id!,
            tag: node.nodeRef.tag,
            hops,
          };
        }
        if (section === null && node.section) section = { ...node.section, nodeId: id!, hops };
      }
      el = el.parentElement;
    }
    return { region, section };
  };
}
