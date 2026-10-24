// One block, one line.
//
// On squirrelscan.com the install block produced SEVEN repeated-subtree groups,
// one per platform button, across 14 pages: seven lines describing a single
// edit to a single component. Grouping got the components right and the output
// still read as seven problems.
//
// A rollup is a presentation unit over groups that are demonstrably the same
// repair: same rule, same check, same attribution, the same component root, the
// same defect kind, and the SAME affected pages. Anything less is left alone,
// because merging groups whose page sets differ would invent a claim about
// where the defect appears.

import type { ComponentFixGroup } from "./component-fix-groups";

/** Distinct defect values to name inside a rolled-up block before counting. */
export const ROLLUP_MAX_DISTINCT_VALUES = 3;

/**
 * Which rollup level produced a unit.
 *
 * - `root` — the same component root, the same pages. Strong: one block.
 * - `family` — the same component FAMILY across structural variants, unioned
 *   over their pages. Weaker: two templates render the nav differently, so this
 *   asserts only that the same repair covers both.
 */
export type ComponentFixRollupLevel = "root" | "family";

export interface ComponentFixRollup {
  level: ComponentFixRollupLevel;
  /** Structural variants merged into this unit. 1 for a root-level rollup. */
  variantCount: number;
  /** The groups this unit stands for, in their original order. */
  groups: ComponentFixGroup[];
  /** Ids of those groups, for the JSON cross-reference. */
  groupIds: string[];
  /** The representative, for region/slot/attribution wording. */
  representative: ComponentFixGroup;
  /** Pages the whole unit affects. Identical to every member's, by construction. */
  affectedPages: string[];
  affectedPageCount: number;
  /** Faulty elements in the block: the sum of the members' occurrences. */
  elementCount: number;
  /** Distinct defect values across the members, in first-seen order. */
  distinctValues: string[];
  /** Distinct values beyond {@link ROLLUP_MAX_DISTINCT_VALUES}. */
  additionalValues: number;
}

/**
 * The component a group belongs to.
 *
 * `componentRootKey` is supplied by the grouping stage; it is read optionally so
 * this module works before that field exists and degrades to "no rollup" rather
 * than guessing a root from the locator, which would merge unrelated blocks.
 */
function componentRootKey(group: ComponentFixGroup): string | undefined {
  return (group as { componentRootKey?: string }).componentRootKey;
}

/** The value a defect is about, as a short string for the rolled-up list. */
function defectValue(group: ComponentFixGroup): string {
  const { values } = group.defect;
  const preferred = values.normalizedText ?? values.text ?? values.reason ?? values.year;
  return preferred === undefined ? group.defect.kind : String(preferred);
}

function pageSetKey(group: ComponentFixGroup): string {
  return [...group.affectedPages].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\u0000");
}

/**
 * Collapse groups that are one repair into single units, preserving order.
 *
 * Groups without a component root, or alone in their bucket, come back as
 * one-member units so callers can render a single list without special cases.
 */
export function componentFixRollups(groups: readonly ComponentFixGroup[]): ComponentFixRollup[] {
  const buckets = new Map<string, ComponentFixGroup[]>();
  const order: string[] = [];

  groups.forEach((group, index) => {
    const root = componentRootKey(group);
    // No root key, no claim that two groups are the same component. Each such
    // group gets a bucket of its own, keyed by position so it cannot merge.
    const key =
      root === undefined
        ? `solo\u0000${index}`
        : [
            group.ruleId,
            group.check.name,
            group.check.status,
            group.attribution,
            root,
            group.defect.kind,
            pageSetKey(group),
          ].join("\u0001");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(group);
    else {
      buckets.set(key, [group]);
      order.push(key);
    }
  });

  return order.map((key) => {
    const members = buckets.get(key)!;
    const representative = members[0]!;
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const member of members) {
      const value = defectValue(member);
      if (seen.has(value)) continue;
      seen.add(value);
      distinct.push(value);
    }
    return {
      level: "root" as const,
      variantCount: 1,
      groups: members,
      groupIds: members.map((member) => member.id),
      representative,
      affectedPages: representative.affectedPages,
      affectedPageCount: representative.affectedPageCount,
      elementCount: members.reduce((sum, member) => sum + member.occurrences.length, 0),
      distinctValues: distinct.slice(0, ROLLUP_MAX_DISTINCT_VALUES),
      additionalValues: Math.max(0, distinct.length - ROLLUP_MAX_DISTINCT_VALUES),
    };
  });
}

/**
 * "7 links with generic text "download"".
 *
 * The count is DISTINCT ELEMENT SLOTS, i.e. the groups in the rollup, not the
 * occurrence total. The real install block is 7 slots on 14 pages: reporting
 * "98 links" described the observations rather than the fix, and the fix is
 * seven links in one block. The occurrence total stays in JSON, where it is
 * evidence rather than an instruction.
 *
 * No "in one shared block" suffix: every surface already prints that in the
 * prefix around this phrase, so saying it here made the line say it twice.
 */
export function describeRollupDefect(rollup: ComponentFixRollup): string {
  const { representative, distinctValues, additionalValues } = rollup;
  const elementCount = rollup.groups.length;
  const noun =
    representative.defect.kind === "stale-copyright"
      ? elementCount === 1
        ? "copyright notice"
        : "copyright notices"
      : elementCount === 1
        ? "link"
        : "links";
  const what =
    representative.defect.kind === "stale-copyright"
      ? "behind the current year"
      : representative.defect.kind === "link-text-empty"
        ? "with no accessible text"
        : "with generic text";
  const values = distinctValues.map((value) => `"${value}"`).join(", ");
  const tail = additionalValues > 0 ? `${values} (+${additionalValues} more)` : values;
  return values.length === 0
    ? `${elementCount} ${noun} ${what}`
    : `${elementCount} ${noun} ${what} ${tail}`;
}


/** Stable comparison key for a defect's VALUES, not just its kind. */
function defectValuesKey(group: ComponentFixGroup): string {
  return Object.entries(group.defect.values)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}\u0002${String(value)}`)
    .join("\u0003");
}

/** The distinct repair slots a unit covers, as a sorted list. */
function slotSet(unit: ComponentFixRollup): string[] {
  return [...new Set(unit.groups.map((group) => group.semanticSlot))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function componentFamilyKey(group: ComponentFixGroup): string | undefined {
  return (group as { componentFamilyKey?: string }).componentFamilyKey;
}

/**
 * Merge root-level units that are the same component in different STRUCTURAL
 * VARIANTS, unioning their pages.
 *
 * A WordPress main nav exists in two variants across page templates, so one
 * generic "log in" link printed as four separate groups over 34 pages. The
 * family key says those are the same component; the defect values say it is the
 * same defect; and equal SLOT COUNTS say the variants carry the same repair
 * targets. Differing slot counts mean the variants are not interchangeable, so
 * they stay apart rather than claiming a fix that one of them does not have.
 *
 * Runs AFTER {@link componentFixRollups}: root merging is the stronger claim
 * and must not be pre-empted by this one.
 */
export function componentFamilyRollups(
  units: readonly ComponentFixRollup[],
): ComponentFixRollup[] {
  const buckets = new Map<string, ComponentFixRollup[]>();
  const order: string[] = [];

  units.forEach((unit, index) => {
    const group = unit.representative;
    const family = componentFamilyKey(group);
    const slots = slotSet(unit);
    // No family key, no claim that two variants are one component.
    const key =
      family === undefined
        ? `solo\u0000${index}`
        : [
            group.ruleId,
            group.check.name,
            group.check.status,
            group.attribution,
            family,
            group.defect.kind,
            defectValuesKey(group),
            // Equal slot COUNT is the interchangeability test; the locators
            // themselves differ between variants by construction.
            String(slots.length),
          ].join("\u0001");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(unit);
    else {
      buckets.set(key, [unit]);
      order.push(key);
    }
  });

  return order.map((key) => {
    const members = buckets.get(key)!;
    if (members.length === 1) return members[0]!;
    const groups = members.flatMap((member) => member.groups);
    const pages = [...new Set(members.flatMap((member) => member.affectedPages))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const member of members) {
      for (const value of member.distinctValues) {
        if (seen.has(value)) continue;
        seen.add(value);
        distinct.push(value);
      }
    }
    return {
      level: "family" as const,
      variantCount: members.length,
      groups,
      groupIds: groups.map((group) => group.id),
      representative: members[0]!.representative,
      affectedPages: pages,
      affectedPageCount: pages.length,
      elementCount: members.reduce((sum, member) => sum + member.elementCount, 0),
      distinctValues: distinct.slice(0, ROLLUP_MAX_DISTINCT_VALUES),
      additionalValues: Math.max(0, distinct.length - ROLLUP_MAX_DISTINCT_VALUES),
    };
  });
}
