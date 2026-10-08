// Skipped checks for the JSON report (#518).
//
// A check the rule could not finish evaluating is neither a pass nor a finding.
// The grouped issue list drops it (it keeps only fail/warn), so a consumer that
// reads "no issue" as clean would treat a page the rule never fully looked at as
// fine. This collects those evaluation gaps into their own list.
//
// Version one lists only scan-limit skips (`scan-truncated`). `reason` is carried
// on every entry so other skip reasons can be added without a shape change.

import { SCAN_TRUNCATED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import type { ReportRuleResult } from "./types";

/** Skip reasons listed in the report. Extend here to widen coverage. */
const LISTED_SKIP_REASONS: ReadonlySet<string> = new Set([SCAN_TRUNCATED_SKIP_REASON]);

export interface SkippedCheck {
  ruleId: string;
  /** Rule display name. */
  name: string;
  /** Check name within the rule, e.g. "hidden-text". */
  check: string;
  /** Why the check did not evaluate, e.g. "scan-truncated". */
  reason: string;
  /** Skipped page URLs: a sample when `pagesHasMore`. */
  pages: string[];
  /** Authoritative number of skipped pages. */
  pagesCount: number;
  /** `pagesCount` > `pages.length`: a folded skip whose page list was clipped. */
  pagesHasMore: boolean;
}

/**
 * Skipped checks grouped by rule, check name and reason. A per-page skip
 * contributes its `pageUrl`; a folded aggregate contributes every page in
 * `pages`. Entries are ordered by rule id, then check name, then reason, and
 * pages are sorted, so the output is stable across runs.
 */
export function collectSkippedChecks(
  ruleResults: Record<string, ReportRuleResult>,
): SkippedCheck[] {
  const out: SkippedCheck[] = [];
  for (const ruleId of Object.keys(ruleResults).sort()) {
    const result = ruleResults[ruleId];
    if (!result) continue;
    const groups = new Map<
      string,
      { check: string; reason: string; pages: Set<string>; total: number }
    >();
    for (const check of result.checks) {
      const reason = check.skipReason;
      if (check.status !== "skipped" || reason === undefined || !LISTED_SKIP_REASONS.has(reason)) {
        continue;
      }
      const key = `${check.name}\u0000${reason}`;
      let group = groups.get(key);
      if (!group) {
        group = { check: check.name, reason, pages: new Set(), total: 0 };
        groups.set(key, group);
      }
      const before = group.pages.size;
      if (check.pageUrl) group.pages.add(check.pageUrl);
      for (const page of check.pages ?? []) group.pages.add(page);
      // A fold clips `pages` and stamps the true total; pages it no longer lists
      // still count. Added per check, so it can only overstate across checks that
      // overlap on the pages they list (they would not, one skip per page).
      const truncated = check.details?.pagesTruncated;
      const listed = group.pages.size - before;
      group.total +=
        typeof truncated === "number" && truncated > listed ? Math.floor(truncated) : listed;
    }
    for (const g of [...groups.values()].sort(
      (a, b) => a.check.localeCompare(b.check) || a.reason.localeCompare(b.reason),
    )) {
      const pages = [...g.pages].sort();
      out.push({
        ruleId,
        name: result.meta.name,
        check: g.check,
        reason: g.reason,
        pages,
        pagesCount: Math.max(g.total, pages.length),
        pagesHasMore: g.total > pages.length,
      });
    }
  }
  return out;
}
