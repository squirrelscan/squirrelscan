// What became of every rule in an audit, and what it covered (#1747, #1741 part 2).
//
// `notChecked` says which checks were skipped and `executedRules` which rules produced a check, but a consumer
// comparing two audits (a diff, an issue tracker, an agent deciding whether its fix worked) needs the positive
// statement per rule: this rule RAN over this much, or it did not. "No finding" from a rule that did not run is
// not a fix. Derived from the rule results, so it is the same on a fresh report and on one rebuilt from a store.

import { RULE_TIMED_OUT_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";

import type { AuditReport, CheckResult, ReportRuleResult } from "./types";

export type RuleRunStatus = "ran" | "skipped" | "timed_out";

/** What a rule covered: the pages a page rule examined, or the origin a site rule judged. */
export type RuleRunScope = { pages: number } | { origin: string; targeted?: true };

export interface RuleRun {
  ruleId: string;
  status: RuleRunStatus;
  scope: RuleRunScope;
  /** The coded skip reason of a rule that did not run (`rule-timed-out`, `targeted-run`, ...), when it had one. */
  reason?: string;
}

type RuleRunInput = Pick<AuditReport, "ruleResults" | "totalPages" | "baseUrl"> &
  Partial<Pick<AuditReport, "scanScope">>;

/** A check this audit produced and judged: not skipped, and not a finding carried over from an earlier audit. */
const judged = (c: CheckResult): boolean => c.status !== "skipped" && c.provenance !== "carried";

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/** The pages a skipped check names: its `pageUrl` and its `pages` list. */
function skippedPagesOf(checks: readonly CheckResult[]): Set<string> {
  const pages = new Set<string>();
  for (const c of checks) {
    if (c.status !== "skipped") continue;
    if (c.pageUrl) pages.add(c.pageUrl);
    for (const p of c.pages ?? []) pages.add(p);
  }
  return pages;
}

function entries(ruleResults: RuleRunInput["ruleResults"]): Array<[string, ReportRuleResult]> {
  return ruleResults instanceof Map
    ? Array.from((ruleResults as Map<string, ReportRuleResult>).entries())
    : Object.entries(ruleResults ?? {});
}

/**
 * One row per rule that has at least one check, sorted by id. `ran`: the rule produced a judged check (a clean
 * pass counts: "ran and found nothing" is a status, not an absence). `timed_out`: every check skipped and one
 * of them for the time budget. `skipped`: every check skipped for another reason. A page rule that ran
 * covers every audited page except the ones it skipped (a noindex page, an unreadable one); a site rule covers
 * the origin. A rule with no check at all is not listed: nothing says whether it ran (the convention that a
 * rule that ran emits one is pinned by a test).
 */
export function ruleRuns(report: RuleRunInput): RuleRun[] {
  const origin = originOf(report.baseUrl);
  // A targeted run (#1777): a site rule that ran judged the listed pages, not the origin.
  const siteScope: RuleRunScope =
    report.scanScope?.targeted !== undefined ? { origin, targeted: true } : { origin };
  const rows: RuleRun[] = [];
  for (const [ruleId, rule] of entries(report.ruleResults)) {
    const checks = rule?.checks ?? [];
    if (checks.length === 0) continue;
    const isPage = rule.meta?.scope === "page";
    const ran = checks.some(judged);
    if (ran) {
      const skipped = skippedPagesOf(checks).size;
      rows.push({
        ruleId,
        status: "ran",
        scope: isPage ? { pages: Math.max(0, (report.totalPages ?? 0) - skipped) } : siteScope,
      });
      continue;
    }
    const timedOut = checks.some((c) => c.skipReason === RULE_TIMED_OUT_SKIP_REASON);
    const reason = timedOut ? RULE_TIMED_OUT_SKIP_REASON : checks.find((c) => c.skipReason)?.skipReason;
    rows.push({
      ruleId,
      status: timedOut ? "timed_out" : "skipped",
      scope: isPage ? { pages: 0 } : siteScope,
      ...(reason ? { reason } : {}),
    });
  }
  return rows.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

/** The run of one rule, or undefined when the report lists none (see {@link ruleRuns}). */
export function ruleRunOf(report: RuleRunInput, ruleId: string): RuleRun | undefined {
  return ruleRuns(report).find((r) => r.ruleId === ruleId);
}
