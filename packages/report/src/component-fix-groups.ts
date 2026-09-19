// Conservative, evidence-backed actionable groups for component-aware findings.
// These are additive report views: `occurrences` stays the immutable observed
// evidence; a group only says the supplied component and defect identities agree.

import type { ComponentOccurrence } from "@squirrelscan/core-contracts";
import type { CheckResult } from "./types";

export interface ComponentFixGroup {
  /**
   * `component-fix:<32 hex>` — a 128-bit digest of the canonical identity below,
   * disambiguated with a `-N` suffix if two distinct identities ever collide.
   * The full identity is NOT the id: it runs to ~800 bytes of hashes, and this
   * value rides on every group in every serialized report.
   */
  id: string;
  ruleId: string;
  check: { name: string; status: CheckResult["status"] };
  /** This is derived from observations and never replaces the raw checks. */
  attribution: "observed-component-evidence";
  affectedPages: string[];
  affectedPageCount: number;
  /** Safe repair-target context from the representative observed element. */
  region: ComponentOccurrence["region"];
  element: ComponentOccurrence["element"];
  /** The relative element locator is the semantic repair slot in this slice. */
  semanticSlot: string;
  defect: ComponentOccurrence["defect"];
  /**
   * Complete, traceable occurrence evidence. Serialized reports reference these
   * by position in the owning check rather than repeating them (see the JSON
   * renderer); renderers for humans sample pages only.
   */
  occurrences: ComponentOccurrence[];
}

/** Codepoint order. `localeCompare` is ICU/locale dependent and would make the
 * serialized order of a report depend on the machine that rendered it. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const FNV_128_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV_128_PRIME = 0x0000000001000000000000000000013bn;
const FNV_128_MASK = (1n << 128n) - 1n;
const utf8 = new TextEncoder();

/**
 * FNV-1a, 128-bit, over the UTF-8 bytes of `value`. Pure JS on purpose: this
 * module is imported by browser report consumers, which have no `node:crypto`.
 * 128 bits makes an accidental collision negligible, and `componentFixGroups`
 * still checks for one rather than trusting the arithmetic.
 */
export function componentFixGroupDigest(value: string): string {
  let hash = FNV_128_OFFSET;
  for (const byte of utf8.encode(value)) {
    hash = ((hash ^ BigInt(byte)) * FNV_128_PRIME) & FNV_128_MASK;
  }
  return hash.toString(16).padStart(32, "0");
}

/**
 * Identity intentionally includes every non-page component and defect datum.
 * A message is deliberately absent: matching prose is not component evidence.
 * Rules make uncertain evidence page-specific before it arrives here.
 */
export function componentOccurrenceIdentity(occurrence: ComponentOccurrence): string {
  return stable({
    version: occurrence.version,
    region: occurrence.region,
    family: occurrence.family,
    // STRUCTURE only. `variant.contentHash` is the region's rendered text: it
    // is reported as evidence, but including it here would split one component
    // on any per-page string in the region (a date, a counter, a breadcrumb),
    // which is exactly the merge this feature exists to make.
    variant: { key: occurrence.variant.key, structuralSignature: occurrence.variant.structuralSignature },
    element: occurrence.element,
    defect: occurrence.defect,
  });
}

/**
 * One observation's full identity: the component it belongs to, the page it was
 * seen on, and how it was seen. Two genuinely distinct elements differ in their
 * locator or structural signature and so keep distinct keys; only a re-merge of
 * the very same observation collapses.
 */
export function componentOccurrenceKey(occurrence: ComponentOccurrence): string {
  return stable({
    component: componentOccurrenceIdentity(occurrence),
    pageUrl: occurrence.pageUrl,
    provenance: occurrence.provenance,
  });
}

/**
 * Derive deterministic, evidence-backed fix groups from the complete selected
 * check evidence. Checks without this additive field retain legacy rendering.
 */
export function componentFixGroups(ruleId: string, checks: CheckResult[]): ComponentFixGroup[] {
  const groups = new Map<
    string,
    { occurrences: ComponentOccurrence[]; check: ComponentFixGroup["check"] }
  >();
  for (const check of checks) {
    for (const occurrence of check.componentOccurrences ?? []) {
      // Unknown, article-nested and otherwise uncertain evidence stays in the
      // legacy page-scoped display. It is never promoted to an actionable
      // cross-page component claim merely because its message happens to match.
      if (!occurrence.groupable || occurrence.confidence !== "observed") continue;
      // Read the site the rule recorded rather than re-deriving one here: a
      // second derivation could only disagree with the one that already scoped
      // `family.key`. Keeping it an explicit term means a group cannot span two
      // origins even if the family keys it was handed are indistinct.
      const identity = stable({
        ruleId,
        origin: occurrence.siteOrigin,
        check: { name: check.name, status: check.status },
        component: componentOccurrenceIdentity(occurrence),
      });
      const entry = groups.get(identity) ?? {
        occurrences: [],
        check: { name: check.name, status: check.status },
      };
      // Do not deduplicate observations: the occurrence list is evidence, not
      // a display set, and two observed elements can have identical locators.
      entry.occurrences.push(occurrence);
      groups.set(identity, entry);
    }
  }

  // Assign ids over the identities in codepoint order, so a digest collision
  // between two DISTINCT identities resolves the same way on every run and on
  // every machine rather than by map insertion order.
  const identities = [...groups.keys()].sort(compare);
  const idByIdentity = new Map<string, string>();
  const seenDigests = new Map<string, number>();
  for (const identity of identities) {
    const digest = componentFixGroupDigest(identity);
    const collisions = seenDigests.get(digest) ?? 0;
    seenDigests.set(digest, collisions + 1);
    idByIdentity.set(
      identity,
      collisions === 0 ? `component-fix:${digest}` : `component-fix:${digest}-${collisions}`,
    );
  }

  return identities
    .map((identity) => {
      const entry = groups.get(identity)!;
      // Decorate-sort-undecorate: the key is a canonical serialization of the
      // whole observation, so computing it inside the comparator would rebuild
      // it O(n log n) times. A 1000-occurrence check made that the single
      // hottest path in the rule run.
      const occurrences = entry.occurrences
        .map((occurrence) => ({ occurrence, key: componentOccurrenceKey(occurrence) }))
        .sort((a, b) => compare(a.key, b.key))
        .map((entry) => entry.occurrence);
      const affectedPages = [
        ...new Set(occurrences.map((occurrence) => occurrence.pageUrl)),
      ].sort(compare);
      const representative = occurrences[0]!;
      return {
        id: idByIdentity.get(identity)!,
        ruleId,
        check: entry.check,
        attribution: "observed-component-evidence" as const,
        affectedPages,
        affectedPageCount: affectedPages.length,
        region: representative.region,
        element: representative.element,
        semanticSlot: representative.element.locator,
        defect: representative.defect,
        occurrences,
      };
    })
    .sort((a, b) => compare(a.id, b.id));
}
