// Serialization codec for component-aware evidence (#2307).
//
// The in-memory `ComponentOccurrence` is deliberately self-contained: every
// observation carries its own region/family/variant identity. That is the right
// shape to reason about, and the wrong shape to store — on a real page every
// faulty element in one region repeats the SAME six signatures, so a page with
// 1,000 generic footer links serialized about 1.7 MB of which the overwhelming
// majority was the same three objects copied 1,000 times.
//
// So the contract stays as it is and only the WIRE form is hoisted: the shared
// region/family/variant triples become a per-check `shapes` table and each
// occurrence keeps an index into it plus the parts that genuinely differ per
// element. Readers rehydrate to the full contract, so nothing downstream of a
// read has to know this happened.
//
// This is the only place that knows the packed layout. Every writer (the SQLite
// column, the finding payload, the CLI JSON) and every reader (rowToCheckResult,
// reconstructRuleChecks, carriedFindingToCheck, convertSlimReport) goes through
// these two functions.

import type { ComponentOccurrence } from "./index";

/** Bumped when the packed layout changes in a way a reader must notice. */
export const COMPONENT_EVIDENCE_FORMAT = 1;

/** The per-occurrence identity that repeats across a region's elements. */
export interface ComponentShape {
  region: ComponentOccurrence["region"];
  family: ComponentOccurrence["family"];
  variant: ComponentOccurrence["variant"];
}

/** One observation, minus the shape it shares with its siblings. */
export interface PackedComponentOccurrence {
  /** Index into {@link PackedComponentEvidence.shapes}. */
  shape: number;
  pageUrl: string;
  siteOrigin: string;
  provenance: ComponentOccurrence["provenance"];
  groupable: boolean;
  confidence: ComponentOccurrence["confidence"];
  uncertainReason?: ComponentOccurrence["uncertainReason"];
  element: ComponentOccurrence["element"];
  defect: ComponentOccurrence["defect"];
}

export interface PackedComponentEvidence {
  v: typeof COMPONENT_EVIDENCE_FORMAT;
  shapes: ComponentShape[];
  occurrences: PackedComponentOccurrence[];
}

/** Stable identity for a shape, used only to dedupe within one pack call. */
function shapeKey(occurrence: ComponentOccurrence): string {
  const { region, family, variant } = occurrence;
  return [
    region.role,
    region.nestedIn,
    region.structuralSignature,
    family.key,
    family.structuralSignature,
    variant.key,
    variant.structuralSignature,
    variant.contentHash,
  ].join("\u0000");
}

/**
 * Hoist the shared region/family/variant triples out of `occurrences`.
 *
 * Occurrence ORDER is preserved exactly: serialized consumers index into this
 * array (the CLI JSON's `occurrenceRefs` do), so packing must never reorder.
 */
export function packComponentOccurrences(
  occurrences: readonly ComponentOccurrence[],
): PackedComponentEvidence {
  const shapes: ComponentShape[] = [];
  const indexByKey = new Map<string, number>();
  const packed: PackedComponentOccurrence[] = [];

  for (const occurrence of occurrences) {
    const key = shapeKey(occurrence);
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = shapes.length;
      indexByKey.set(key, index);
      shapes.push({
        region: occurrence.region,
        family: occurrence.family,
        variant: occurrence.variant,
      });
    }
    packed.push({
      shape: index,
      pageUrl: occurrence.pageUrl,
      siteOrigin: occurrence.siteOrigin,
      provenance: occurrence.provenance,
      groupable: occurrence.groupable,
      confidence: occurrence.confidence,
      ...(occurrence.uncertainReason ? { uncertainReason: occurrence.uncertainReason } : {}),
      element: occurrence.element,
      defect: occurrence.defect,
    });
  }

  return { v: COMPONENT_EVIDENCE_FORMAT, shapes, occurrences: packed };
}

function isPacked(value: unknown): value is PackedComponentEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedComponentEvidence>;
  return Array.isArray(candidate.shapes) && Array.isArray(candidate.occurrences);
}

/**
 * Rebuild full occurrences from either form.
 *
 * Tolerates a plain array of complete occurrences — the un-hoisted layout that
 * predates this codec — so a store or report written before it still reads. An
 * unrecognized value, or a row whose `shape` index does not resolve, yields
 * `undefined`/is skipped rather than throwing: evidence is additive, and a
 * malformed blob must never take the surrounding finding down with it.
 */
export function unpackComponentOccurrences(value: unknown): ComponentOccurrence[] | undefined {
  if (value === null || value === undefined) return undefined;

  // Legacy / un-hoisted: already complete occurrences.
  if (Array.isArray(value)) {
    return value.length > 0 ? (value as ComponentOccurrence[]) : undefined;
  }

  if (!isPacked(value)) return undefined;
  const { shapes, occurrences } = value;

  const out: ComponentOccurrence[] = [];
  for (const packed of occurrences) {
    const shape = shapes[packed.shape];
    if (!shape) continue;
    out.push({
      version: 1,
      pageUrl: packed.pageUrl,
      siteOrigin: packed.siteOrigin,
      provenance: packed.provenance,
      groupable: packed.groupable,
      confidence: packed.confidence,
      ...(packed.uncertainReason ? { uncertainReason: packed.uncertainReason } : {}),
      region: shape.region,
      family: shape.family,
      variant: shape.variant,
      element: packed.element,
      defect: packed.defect,
    });
  }
  return out.length > 0 ? out : undefined;
}
