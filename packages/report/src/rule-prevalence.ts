// Cross-site rule prevalence (squirrelscan/repo#2491).
//
// A finding that fires on nearly every site carries little information, so the
// report ranks it below distinctive findings of the same severity. Nothing is
// hidden or re-scored: ordering and one explanatory line only.
//
// The figures live in `rule-prevalence.json`, generated from a stored corpus run
// by `apps/cli/scripts/rule-prevalence.ts` (refresh it with that script).

import data from "./rule-prevalence.json";

/** Prevalence above this share of corpus sites counts as near-universal. */
export const NEAR_UNIVERSAL_PREVALENCE = 0.7;

export interface RulePrevalenceData {
  /** ISO date of the corpus run the figures come from; empty when never generated. */
  generatedAt: string;
  /** Number of sites in that corpus. */
  sites: number;
  /** Rule id to the share (0..1) of corpus sites where it produced a finding. */
  prevalence: Record<string, number>;
  /** Rules deliberately left above the threshold: rule id to the reason. */
  kept: Record<string, string>;
}

const PREVALENCE = data as RulePrevalenceData;

/** Share (0..1) of corpus sites where the rule fires, or undefined when unknown. */
export function rulePrevalence(
  ruleId: string,
  source: RulePrevalenceData = PREVALENCE,
): number | undefined {
  return Object.hasOwn(source.prevalence, ruleId) ? source.prevalence[ruleId] : undefined;
}

export function isNearUniversal(ruleId: string, source: RulePrevalenceData = PREVALENCE): boolean {
  const p = rulePrevalence(ruleId, source);
  return p !== undefined && p > NEAR_UNIVERSAL_PREVALENCE;
}

/** The "why this ranks lower" line shown under a near-universal rule. */
export function prevalenceNote(
  ruleId: string,
  source: RulePrevalenceData = PREVALENCE,
): string | undefined {
  const p = rulePrevalence(ruleId, source);
  if (p === undefined || p <= NEAR_UNIVERSAL_PREVALENCE) return undefined;
  return `Ranked lower: this finding appears on ${Math.round(p * 100)}% of sites we audited, so it tells you less about this site than the findings above it.`;
}
