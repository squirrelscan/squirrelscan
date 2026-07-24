import type { RuleRunResult } from "./types";

/**
 * Accumulate a single rule's run result (for one page or the site scope) into a
 * `ruleId -> RuleRunResult` map, in O(checks-this-call).
 *
 * The report adapters previously merged with `checks: [...existing.checks, ...new]`
 * on every page, which COPIES the whole accumulated array each time — O(N²) across
 * N pages and the dominant report-assembly cost at scale (see #264). This appends
 * in place instead, turning the accumulation into O(N).
 *
 * Two subtleties this encapsulates:
 *  - First insert stores a PRIVATE copy of the checks array. Callers share the
 *    source `result.checks` array by reference with their per-page storage
 *    (`pageRuleResults` / `siteRuleResults`); appending into the original would
 *    corrupt those per-page views once a second page arrives for the same rule.
 *  - Subsequent inserts loop-push (not arg-spread) to avoid call-stack limits on
 *    very large check arrays.
 */
export function mergeRuleRunResult(
  map: Map<string, RuleRunResult>,
  ruleId: string,
  result: RuleRunResult
): void {
  const existing = map.get(ruleId);
  if (existing) {
    for (const check of result.checks) existing.checks.push(check);
  } else {
    map.set(ruleId, { meta: result.meta, checks: [...result.checks] });
  }
}
