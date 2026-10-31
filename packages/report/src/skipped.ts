// Skipped checks for the JSON report (#518).
//
// A check the rule could not finish evaluating is neither a pass nor a finding.
// The grouped issue list drops it (it keeps only fail/warn), so a consumer that
// reads "no issue" as clean would treat a page the rule never fully looked at as
// fine. This collects those evaluation gaps into their own list.
//
// Two reasons are listed: a scan limit (`scan-truncated`) and a rule that ran past
// its time budget on a page (`rule-timed-out`, #518), plus `rule-errored`: the same
// skip row when the rule threw (#1291), which is squirrel's defect, not the page's.
// The skip rows share the reason `rule-timed-out`; `details.errored` tells them apart. `reason` is carried on every
// entry so other skip reasons can be added without a shape change.

import {
  RULE_TIMED_OUT_SKIP_REASON,
  SCAN_TRUNCATED_SKIP_REASON,
} from "@squirrelscan/core-contracts/resolution";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { stripUnsafeLineText } from "@squirrelscan/core-contracts/control-chars";
import type { ReportRuleResult } from "./types";

/** Skip reasons listed in the report. Extend here to widen coverage. */
/** Reported for a skip row of a rule that threw, so it is not read as a timeout (#1291). */
export const RULE_ERRORED_REASON = "rule-errored";

const LISTED_SKIP_REASONS: ReadonlySet<string> = new Set([
  SCAN_TRUNCATED_SKIP_REASON,
  RULE_TIMED_OUT_SKIP_REASON,
  RULE_ERRORED_REASON,
]);

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
      const recorded = check.skipReason;
      // A rule that threw is recorded as a timed-out skip with `details.errored`.
      const reason =
        recorded === RULE_TIMED_OUT_SKIP_REASON && check.details?.errored === true
          ? RULE_ERRORED_REASON
          : recorded;
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
      // A timed-out rule is recorded once for the audit and counts the pages that
      // hit the budget in `details.pages`, which are not always listed by URL.
      const timedOutPages =
        (reason === RULE_TIMED_OUT_SKIP_REASON || reason === RULE_ERRORED_REASON) &&
          typeof check.details?.pages === "number"
          ? Math.floor(check.details.pages)
          : 0;
      group.total = Math.max(
        group.total + listed,
        typeof truncated === "number" && truncated > listed ? group.total + Math.floor(truncated) : 0,
        timedOutPages,
      );
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

/** Most entries, and pages per entry, read back from a saved report (the file is user-supplied). */
const MAX_RESTORED_SKIPPED = 1_000;
const MAX_RESTORED_PAGES = 5_000;
/** Largest page total read back: far past any crawl, so a forged count cannot round-trip into `summary.skipped`. */
const MAX_RESTORED_COUNT = 10_000_000;
/** A rule id as the catalog writes it: `category/name`, lowercase. Anything else (`__proto__`, `constructor`) is not a rule. */
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,60}\/[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * The skipped checks of a saved JSON report, validated (#518). The file is untrusted:
 * an entry needs a string rule id and check name and a listed reason, pages must be
 * strings, counts whole numbers. Anything else is dropped, never rendered.
 */
export function parseSkippedChecks(value: unknown): SkippedCheck[] {
  if (!Array.isArray(value)) return [];
  const out: SkippedCheck[] = [];
  for (const raw of value.slice(0, MAX_RESTORED_SKIPPED)) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (
      typeof e.ruleId !== "string" ||
      typeof e.check !== "string" ||
      typeof e.reason !== "string" ||
      !LISTED_SKIP_REASONS.has(e.reason) ||
      !RULE_ID.test(e.ruleId) ||
      e.check.length > 200
    ) {
      continue;
    }
    const pages = (Array.isArray(e.pages) ? e.pages : [])
      .filter((p): p is string => typeof p === "string" && p.length <= 2_048)
      // The file is untrusted and these reach a terminal: no control characters, no bidi overrides.
      // A URL loses them outright (a space would split it); names below become spaces so words stay apart.
      .map((p) => stripUnsafeLineText(p, ""))
      .slice(0, MAX_RESTORED_PAGES);
    const count = e.pagesCount;
    const pagesCount =
      typeof count === "number" && Number.isSafeInteger(count) && count >= pages.length && count <= MAX_RESTORED_COUNT
        ? count
        : pages.length;
    out.push({
      ruleId: e.ruleId,
      name: typeof e.name === "string" && e.name.length <= 200 ? stripUnsafeLineText(e.name) : e.ruleId,
      check: stripUnsafeLineText(e.check),
      reason: e.reason,
      pages,
      pagesCount,
      pagesHasMore: pagesCount > pages.length,
    });
  }
  return out;
}

/**
 * The skip rows {@link collectSkippedChecks} reads, rebuilt from its output, so
 * `squirrel report --input` shows the same not-checked lines as the audit that wrote
 * the file and re-exporting it keeps `skippedChecks` and `summary.skipped`. One row per
 * entry carrying every listed page; the true page total rides in `details`, which is
 * where {@link collectSkippedChecks} reads it back from. `metaFor` builds the rule
 * entry for a rule that had no issue in the file (a skipped-only rule).
 */
export function restoreSkippedChecks(
  ruleResults: Record<string, ReportRuleResult>,
  skipped: readonly SkippedCheck[],
  metaFor: (ruleId: string, name: string) => ReportRuleResult["meta"],
): void {
  for (const entry of skipped) {
    const errored = entry.reason === RULE_ERRORED_REASON;
    const row: CheckResult = {
      name: entry.check,
      status: "skipped",
      message: "",
      skipReason: errored ? RULE_TIMED_OUT_SKIP_REASON : entry.reason,
      pages: entry.pages,
      details: {
        ...(errored ? { errored: true } : {}),
        ...(entry.pagesHasMore ? { pagesTruncated: entry.pagesCount } : {}),
        ...(entry.reason === RULE_TIMED_OUT_SKIP_REASON || errored ? { pages: entry.pagesCount } : {}),
      },
    };
    const existing = Object.hasOwn(ruleResults, entry.ruleId) ? ruleResults[entry.ruleId] : undefined;
    if (existing) existing.checks.push(row);
    else ruleResults[entry.ruleId] = { meta: metaFor(entry.ruleId, entry.name), checks: [row] };
  }
}
