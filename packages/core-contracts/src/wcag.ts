// WCAG success criteria as data (repo#3093). One table owns each criterion's
// title, conformance level and the WCAG version that introduced it, so a rule
// declares only the criterion number and cannot state the wrong level.
// Source: https://www.w3.org/TR/WCAG22/ (Level and "new in" markers).

export type WcagLevel = "A" | "AA" | "AAA";
export type WcagVersion = "2.0" | "2.1" | "2.2";

/** One success criterion a rule's findings map to. */
export interface WcagCriterion {
  sc: string;
  level: WcagLevel;
  version: WcagVersion;
}

interface WcagEntry {
  title: string;
  level: WcagLevel;
  version: WcagVersion;
}

/**
 * Every WCAG 2.2 Level A and AA success criterion (repo#3094, the accessibility checklist lists them all),
 * in document order, plus the AAA criteria a rule cites (2.3.3, 2.4.9, 2.5.5); add an AAA row when a rule cites a
 * new one. No 4.1.1 Parsing: WCAG 2.2 removed it.
 */
export const WCAG_CRITERIA: Readonly<Record<string, WcagEntry>> = {
  "1.1.1": { title: "Non-text Content", level: "A", version: "2.0" },
  "1.2.1": { title: "Audio-only and Video-only (Prerecorded)", level: "A", version: "2.0" },
  "1.2.2": { title: "Captions (Prerecorded)", level: "A", version: "2.0" },
  "1.2.3": { title: "Audio Description or Media Alternative (Prerecorded)", level: "A", version: "2.0" },
  "1.2.4": { title: "Captions (Live)", level: "AA", version: "2.0" },
  "1.2.5": { title: "Audio Description (Prerecorded)", level: "AA", version: "2.0" },
  "1.3.1": { title: "Info and Relationships", level: "A", version: "2.0" },
  "1.3.2": { title: "Meaningful Sequence", level: "A", version: "2.0" },
  "1.3.3": { title: "Sensory Characteristics", level: "A", version: "2.0" },
  "1.3.4": { title: "Orientation", level: "AA", version: "2.1" },
  "1.3.5": { title: "Identify Input Purpose", level: "AA", version: "2.1" },
  "1.4.1": { title: "Use of Color", level: "A", version: "2.0" },
  "1.4.2": { title: "Audio Control", level: "A", version: "2.0" },
  "1.4.3": { title: "Contrast (Minimum)", level: "AA", version: "2.0" },
  "1.4.4": { title: "Resize Text", level: "AA", version: "2.0" },
  "1.4.5": { title: "Images of Text", level: "AA", version: "2.0" },
  "1.4.10": { title: "Reflow", level: "AA", version: "2.1" },
  "1.4.11": { title: "Non-text Contrast", level: "AA", version: "2.1" },
  "1.4.12": { title: "Text Spacing", level: "AA", version: "2.1" },
  "1.4.13": { title: "Content on Hover or Focus", level: "AA", version: "2.1" },
  "2.1.1": { title: "Keyboard", level: "A", version: "2.0" },
  "2.1.2": { title: "No Keyboard Trap", level: "A", version: "2.0" },
  "2.1.4": { title: "Character Key Shortcuts", level: "A", version: "2.1" },
  "2.2.1": { title: "Timing Adjustable", level: "A", version: "2.0" },
  "2.2.2": { title: "Pause, Stop, Hide", level: "A", version: "2.0" },
  "2.3.1": { title: "Three Flashes or Below Threshold", level: "A", version: "2.0" },
  "2.3.3": { title: "Animation from Interactions", level: "AAA", version: "2.1" },
  "2.4.1": { title: "Bypass Blocks", level: "A", version: "2.0" },
  "2.4.2": { title: "Page Titled", level: "A", version: "2.0" },
  "2.4.3": { title: "Focus Order", level: "A", version: "2.0" },
  "2.4.4": { title: "Link Purpose (In Context)", level: "A", version: "2.0" },
  "2.4.5": { title: "Multiple Ways", level: "AA", version: "2.0" },
  "2.4.6": { title: "Headings and Labels", level: "AA", version: "2.0" },
  "2.4.7": { title: "Focus Visible", level: "AA", version: "2.0" },
  "2.4.9": { title: "Link Purpose (Link Only)", level: "AAA", version: "2.0" },
  "2.4.11": { title: "Focus Not Obscured (Minimum)", level: "AA", version: "2.2" },
  "2.5.1": { title: "Pointer Gestures", level: "A", version: "2.1" },
  "2.5.2": { title: "Pointer Cancellation", level: "A", version: "2.1" },
  "2.5.3": { title: "Label in Name", level: "A", version: "2.1" },
  "2.5.4": { title: "Motion Actuation", level: "A", version: "2.1" },
  "2.5.5": { title: "Target Size (Enhanced)", level: "AAA", version: "2.1" },
  "2.5.7": { title: "Dragging Movements", level: "AA", version: "2.2" },
  "2.5.8": { title: "Target Size (Minimum)", level: "AA", version: "2.2" },
  "3.1.1": { title: "Language of Page", level: "A", version: "2.0" },
  "3.1.2": { title: "Language of Parts", level: "AA", version: "2.0" },
  "3.2.1": { title: "On Focus", level: "A", version: "2.0" },
  "3.2.2": { title: "On Input", level: "A", version: "2.0" },
  "3.2.3": { title: "Consistent Navigation", level: "AA", version: "2.0" },
  "3.2.4": { title: "Consistent Identification", level: "AA", version: "2.0" },
  "3.2.6": { title: "Consistent Help", level: "A", version: "2.2" },
  "3.3.1": { title: "Error Identification", level: "A", version: "2.0" },
  "3.3.2": { title: "Labels or Instructions", level: "A", version: "2.0" },
  "3.3.3": { title: "Error Suggestion", level: "AA", version: "2.0" },
  "3.3.4": { title: "Error Prevention (Legal, Financial, Data)", level: "AA", version: "2.0" },
  "3.3.7": { title: "Redundant Entry", level: "A", version: "2.2" },
  "3.3.8": { title: "Accessible Authentication (Minimum)", level: "AA", version: "2.2" },
  "4.1.2": { title: "Name, Role, Value", level: "A", version: "2.0" },
  "4.1.3": { title: "Status Messages", level: "AA", version: "2.1" },
};

/** Build a rule's criterion entry from its number; throws on an unknown number so a typo fails at load. */
export function wcag(sc: string): WcagCriterion {
  const entry = WCAG_CRITERIA[sc];
  if (!entry) throw new Error(`Unknown WCAG success criterion "${sc}"`);
  return { sc, level: entry.level, version: entry.version };
}

export function wcagTitle(sc: string): string | undefined {
  return WCAG_CRITERIA[sc]?.title;
}

const LEVEL_RANK: Record<WcagLevel, number> = { A: 1, AA: 2, AAA: 3 };

export function isWcagLevel(value: unknown): value is WcagLevel {
  return value === "A" || value === "AA" || value === "AAA";
}

/** Lowest (easiest to meet) level among a rule's criteria; undefined when it declares none. */
export function lowestWcagLevel(criteria: readonly WcagCriterion[] | undefined): WcagLevel | undefined {
  if (!criteria || criteria.length === 0) return undefined;
  return criteria.reduce<WcagLevel>(
    (low, c) => (LEVEL_RANK[c.level] < LEVEL_RANK[low] ? c.level : low),
    criteria[0]!.level,
  );
}

/**
 * Whether a rule's criteria reach `target`: AA keeps level A and AA criteria, A keeps only A, AAA keeps
 * every level. A rule with several criteria stays when any one is at or below the target. True for no
 * criteria; `wcagLevelDisablePatterns` (packages/rules) leaves a rule with none out of a level-narrowed run.
 */
export function meetsWcagTarget(
  criteria: readonly WcagCriterion[] | undefined,
  target: WcagLevel,
): boolean {
  const low = lowestWcagLevel(criteria);
  return low === undefined || LEVEL_RANK[low] <= LEVEL_RANK[target];
}

export const WCAG_LEVELS: readonly WcagLevel[] = ["A", "AA", "AAA"];

/** "2.5.5 Target Size (Enhanced), Level AAA" for one criterion. */
export function wcagLabel(c: WcagCriterion): string {
  const title = wcagTitle(c.sc);
  return `${c.sc}${title ? ` ${title}` : ""}, Level ${c.level}`;
}

/** Count the rules at each easiest level; empty object when none declares criteria. */
export function countByWcagLevel(
  rules: ReadonlyArray<{ wcag?: readonly WcagCriterion[] }>,
): Partial<Record<WcagLevel, number>> {
  const counts: Partial<Record<WcagLevel, number>> = {};
  for (const r of rules) {
    const level = lowestWcagLevel(r.wcag);
    if (level) counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}
