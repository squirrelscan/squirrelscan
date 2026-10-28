// Turning component fix groups into something that REPLACES output rather than
// adding to it.
//
// The first cut rendered a group block above the legacy `Pages (5/12)` and
// `Items` lines and filled it with `s128:` hashes. That is strictly worse than
// no feature at all: more lines to read, and the added lines carry values no
// reader can act on. A fix group only earns its place when it says the thing
// the legacy lines were approximating — "this is one defect, fix it once" — and
// then takes their place.
//
// Hashes, structural signatures and family/variant keys stay OUT of every
// human and LLM surface. They exist to make grouping decisions reproducible,
// not to be read. JSON keeps them; it is the machine format.

import type { CheckItem } from "./types";
import type { ComponentFixGroup } from "./component-fix-groups";
import type { ComponentFixRollup } from "./component-fix-rollup";
import {
  componentFamilyRollups,
  componentFixRollups,
  describeRollupDefect,
} from "./component-fix-rollup";
import type { GroupedRule } from "./grouping";
import { ruleAffectedPages } from "./affected-pages";

/**
 * How much of a rule's affected-page set its fix groups account for.
 *
 * - `none`   — no groups. Renderers must emit byte-identical legacy output.
 * - `full`   — every affected page is attributed to a group, so the legacy
 *              page/item lines are redundant and are suppressed.
 * - `partial`— groups first, then the remainder, explicitly labelled so a
 *              reader never mistakes "not grouped" for "not affected".
 */
export type FixCoverageMode = "none" | "full" | "partial";

export interface FixCoverage {
  mode: FixCoverageMode;
  groups: ComponentFixGroup[];
  /** Affected pages NOT attributed to any group. Empty when `full`. */
  uncoveredPages: string[];
}

/**
 * Attributions a renderer knows how to phrase. An unknown value renders as
 * nothing at all rather than being narrated with borrowed confidence: a reader
 * on an older build must not be told "fix once" about evidence that did not
 * mean that. Keep in step with `ComponentFixAttribution`.
 */
const RENDERABLE_ATTRIBUTIONS = new Set<string>([
  "observed-component-evidence",
  "repeated-subtree",
]);

/**
 * Whether a group earns a line of its own.
 *
 * A one-page group is not a group. "Fix once, 1 page" says nothing the legacy
 * per-check line did not already say, and real template sites produce them in
 * bulk: one WordPress audit emitted two separate single-page footer groups and
 * a single-page nav group, three lines of pure noise. JSON keeps them, flagged
 * as they are; the human and LLM surfaces do not.
 */
export function isRenderableFixGroup(group: ComponentFixGroup): boolean {
  return group.affectedPageCount >= 2 && RENDERABLE_ATTRIBUTIONS.has(group.attribution);
}

export function ruleFixCoverage(rule: GroupedRule): FixCoverage {
  // Coverage counts only the groups that will actually be RENDERED. Counting a
  // group we then decline to print would suppress the legacy lines for its
  // pages and leave the defect described nowhere at all.
  const groups = (rule.componentFixGroups ?? []).filter(isRenderableFixGroup);
  if (groups.length === 0) return { mode: "none", groups: [], uncoveredPages: [] };

  const covered = new Set<string>();
  for (const group of groups) for (const page of group.affectedPages) covered.add(page);

  const affected = ruleAffectedPages(rule.checks);
  const uncoveredPages = [...affected]
    .filter((page) => !covered.has(page))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // A rule whose pages are unknown (site-scope checks with no page list) cannot
  // be said to be fully covered by anything, so it stays partial rather than
  // silently swallowing the legacy lines.
  if (affected.size === 0) return { mode: "partial", groups, uncoveredPages: [] };
  return { mode: uncoveredPages.length === 0 ? "full" : "partial", groups, uncoveredPages };
}

/**
 * The items still worth listing after the printed groups have spoken, with
 * their source pages narrowed to the ones no group accounted for.
 *
 * In partial coverage the groups already state where the shared defect lives,
 * so repeating an item's full page list re-reports those pages a second time.
 * An item whose every source page is covered is dropped outright; an item with
 * no source pages at all is kept unchanged, because nothing establishes that a
 * group accounted for it.
 */
export function uncoveredItems(
  items: readonly CheckItem[] | undefined,
  coverage: FixCoverage,
): CheckItem[] {
  if (!items || items.length === 0) return [];
  if (coverage.mode === "none") return [...items];
  if (coverage.mode === "full") return [];
  const uncovered = new Set(coverage.uncoveredPages);
  const out: CheckItem[] = [];
  for (const item of items) {
    if (!item.sourcePages || item.sourcePages.length === 0) {
      out.push(item);
      continue;
    }
    const remaining = item.sourcePages.filter((page) => uncovered.has(page));
    if (remaining.length === 0) continue;
    // `pageCount` (pages the item is on, listed or not) loses the pages the groups took, or the
    // rows would count them again as "more pages" the report left out.
    const dropped = new Set(item.sourcePages).size - new Set(remaining).size;
    out.push({
      ...item,
      sourcePages: remaining,
      ...(typeof item.pageCount === "number"
        ? { pageCount: Math.max(0, item.pageCount - dropped) }
        : {}),
    });
  }
  return out;
}

/** Short words for a repair target: "site footer", "navigation in the header". */
export function describeRegion(group: ComponentFixGroup): string {
  const { role, nestedIn } = group.region;
  const slot = regionSlotIndex(group.semanticSlot);
  const base =
    role === "footer"
      ? "site footer"
      : role === "header"
        ? "site header"
        : role === "navigation"
          ? "navigation"
          : role === "main"
            ? "main content"
            : "page";
  const scoped =
    nestedIn === "article"
      ? `${base} inside an article`
      : nestedIn === "main"
        ? `${base} inside the main content`
        : base;
  return slot > 1 ? `${scoped} #${slot}` : scoped;
}

/** `footer:2>footer>ul:1>a:3` -> 2. Absent or unparseable -> 1. */
function regionSlotIndex(semanticSlot: string): number {
  const first = semanticSlot.split(">")[0] ?? "";
  const index = Number(first.split(":")[1]);
  return Number.isFinite(index) && index > 0 ? index : 1;
}

/** Longest a block label may be before it is truncated. */
export const ROOT_LABEL_MAX = 40;

/**
 * ONE human label for the block a group or rollup sits in.
 *
 * Precedence is heading, then aria-label, then id; `undefined` when the group
 * carries no hint, which keeps the wording byte-identical to a report without
 * one. This lives here, and only here, so all five surfaces make the same
 * choice and phrase it the same way; callers escape it for their own format.
 *
 * Read defensively: the field is additive and may not be present yet.
 */
export function describeRoot(unit: ComponentFixGroup | ComponentFixRollup): string | undefined {
  const group = "representative" in unit ? unit.representative : unit;
  const hint = (
    group as { rootHint?: { tag?: string; id?: string; ariaLabel?: string; heading?: string } }
  ).rootHint;
  if (!hint) return undefined;
  const truncate = (value: string) =>
    value.length > ROOT_LABEL_MAX ? `${value.slice(0, ROOT_LABEL_MAX - 1)}\u2026` : value;
  if (hint.heading) return `"${truncate(hint.heading)}"`;
  if (hint.ariaLabel) return `"${truncate(hint.ariaLabel)}"`;
  if (hint.id) return `#${truncate(hint.id)}`;
  return undefined;
}

/**
 * The element's position inside its region, as a short trailing hint. The raw
 * locator stays in JSON; here it is a breadcrumb, not an identifier.
 */
export function describeSlot(group: ComponentFixGroup): string {
  const steps = group.semanticSlot.split(">").slice(1);
  const tail = steps.slice(-2);
  return tail.length > 0 ? tail.join(" > ") : group.semanticSlot;
}

function quote(value: unknown): string {
  return `"${String(value)}"`;
}

/** What is wrong, in the words a person fixing it would use. */
export function describeDefect(group: ComponentFixGroup): string {
  const { kind, values } = group.defect;
  if (kind === "stale-copyright") {
    const year = values.year;
    const current = values.currentYear;
    return current === undefined
      ? `copyright year ${year} is out of date`
      : `copyright year ${year} is behind ${current}`;
  }
  if (kind === "link-text-generic") {
    // `normalizedText` is what the rule emits; `text` covers evidence recorded
    // before that key settled, so the line never silently loses the wording.
    const text = values.normalizedText ?? values.text;
    return text === undefined ? "link text is generic" : `link text ${quote(text)} is generic`;
  }
  if (kind === "link-text-empty") {
    const reason = values.reason;
    return reason === undefined
      ? "link has no accessible text"
      : `link has no accessible text (${reason})`;
  }
  return String(kind);
}

export interface PageSample {
  shown: string[];
  total: number;
  hasMore: boolean;
}

/** A bounded, explicitly labelled page sample. `format` compresses each URL. */
export function fixGroupPages(
  group: ComponentFixGroup,
  limit: number,
  format: (page: string) => string,
): PageSample {
  const shown = group.affectedPages.slice(0, limit).map(format);
  return {
    shown,
    total: group.affectedPageCount,
    hasMore: group.affectedPageCount > shown.length,
  };
}

/** "12 pages: /, /api, /guides (+9 more)". */
export function formatPageSample(sample: PageSample, noun = "pages"): string {
  const list = sample.shown.join(", ");
  return sample.hasMore
    ? `${sample.total} ${noun}: ${list} (+${sample.total - sample.shown.length} more)`
    : `${sample.total} ${noun}: ${list}`;
}

/**
 * The units a renderer prints: rolled up, or one per group.
 *
 * Wrapping each group as a one-member rollup rather than calling
 * `componentFixRollups` is what `componentRollup: false` does, so the two
 * columns of a before/after comparison differ in exactly one behaviour. It
 * builds the units here instead of adding a parameter to `componentFixRollups`,
 * whose exported signature other renderers depend on.
 */
export function fixUnits(
  groups: readonly ComponentFixGroup[],
  rollupEnabled = true,
): ComponentFixRollup[] {
  // Root first: merging one block's slots is the stronger claim, and the family
  // level then merges those units across structural variants.
  if (rollupEnabled) return componentFamilyRollups(componentFixRollups(groups));
  return groups.map((group) => ({
    level: "root" as const,
    variantCount: 1,
    groups: [group],
    groupIds: [group.id],
    representative: group,
    affectedPages: group.affectedPages,
    affectedPageCount: group.affectedPageCount,
    elementCount: group.occurrences.length,
    distinctValues: [],
    additionalValues: 0,
  }));
}

/**
 * The line for a ROLLUP: one repair, however many faulty elements it contains.
 * A single-member rollup is worded exactly like the group it wraps, so adding
 * rollups changes nothing for reports that have no repeated blocks.
 */
export function fixRollupLine(
  rollup: ComponentFixRollup,
  limit: number,
  format: (page: string) => string,
  /** false when the caller appends its own trailing slot hint (llm does). */
  includeSlot = true,
): string {
  const group = rollup.representative;
  // One group is ONE element, however many pages it repeats on, so its slot
  // still locates the fix. Several groups are several distinct elements, where
  // any one slot describes none of the others.
  if (rollup.groups.length === 1 && rollup.variantCount === 1) {
    return fixGroupLine(group, limit, format, includeSlot);
  }
  // The UNION, not the representative's own pages: a family rollup spans
  // variants, and sampling the representative would under-report its reach.
  const shown = rollup.affectedPages.slice(0, limit).map(format);
  const pages = formatPageSample({
    shown,
    total: rollup.affectedPageCount,
    hasMore: rollup.affectedPageCount > shown.length,
  });
  return `${fixPrefix(group, undefined, rollup.variantCount)}: ${describeRollupDefect(rollup)}, ${
    group.attribution === "repeated-subtree" ? "seen on " : ""
  }${pages}`;
}

/**
 * The single actionable line a fix group exists to produce.
 *
 * The wording tracks the ATTRIBUTION, because the two say different things.
 * Observed landmark evidence supports an instruction ("fix once here").
 * A repeated subtree supports an observation ("likely one shared block"), and
 * phrasing it as an instruction would overstate what was established.
 */
export function fixGroupLine(
  group: ComponentFixGroup,
  limit: number,
  format: (page: string) => string,
  includeSlot = true,
): string {
  const sample = fixGroupPages(group, limit, format);
  return `${fixPrefix(group, includeSlot ? describeSlot(group) : undefined)}: ${describeDefect(group)}, ${
    group.attribution === "repeated-subtree" ? "seen on " : ""
  }${formatPageSample(sample)}`;
}

/**
 * "Fix once in the site footer ("Company links")" or
 * "Likely one shared block ("Install squirrel") in the main content".
 *
 * A block label, when there is one, is the parenthetical; the element slot is
 * the fallback for a single element with no label, and neither appears when a
 * unit spans several elements (no single slot describes them).
 */
function fixPrefix(
  group: ComponentFixGroup,
  slot: string | undefined,
  variantCount = 1,
): string {
  const label = describeRoot(group);
  const region = describeRegion(group);
  // Structural variants are stated, not hidden: the same repair covers two
  // different renderings of the component, and a reader should know that.
  const variants = variantCount > 1 ? `${variantCount} variants` : undefined;
  if (group.attribution === "repeated-subtree") {
    const parts = [label, variants].filter(Boolean).join(", ");
    const anchor = parts ? ` (${parts})` : "";
    const tail = !parts && slot ? ` (${slot})` : "";
    return `Likely one shared block${anchor} in the ${region}${tail}`;
  }
  const parts = [label, variants].filter(Boolean).join(", ");
  const anchor = parts ? ` (${parts})` : slot ? ` (${slot})` : "";
  return `Fix once in the ${region}${anchor}`;
}
