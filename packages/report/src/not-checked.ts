// Checks that did not run for this audit (repo#2729). Shared across the CLI
// console and every report renderer.
//
// When external link checking is off (Quick level, --offline,
// external_links.enabled = false) or the crawl did not follow links, the link
// rules emit a `skipped` check with a NOT_CHECKED skip reason. Skipped checks
// are neither passes nor findings, so the issue list leaves them out and the
// score never counts them. Left at that, a Quick audit reads as "no broken
// links" when nothing was checked. This turns each one into a visible "Not
// checked" line with the reason and what to run instead.

import {
  EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
  LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
  NOT_CHECKED_SKIP_REASONS,
} from "@squirrelscan/core-contracts";

import type { ReportRuleResult } from "./types";

export interface NotCheckedRule {
  ruleId: string;
  /** Rule display name. */
  name: string;
  /** Check name within the rule, e.g. "broken-external-links". */
  check: string;
  /** Why it did not run, e.g. "external-links-not-checked". */
  reason: string;
  /** The rule's own message: what was not checked, and why. */
  message: string;
  /** What to run to check it. */
  hint: string;
}

/** The slice of a report this needs, so any report-shaped object works. */
export interface NotCheckedReportShape {
  ruleResults: Record<string, ReportRuleResult>;
}

const HINTS: Record<string, string> = {
  [EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON]:
    "Run a Surface or Full audit with external link checks on to check them.",
  [LINK_TARGETS_NOT_FETCHED_SKIP_REASON]:
    "Run a Surface or Full audit, which follows links, to check them.",
};

const DEFAULT_HINT = "Run a Surface or Full audit to check them.";

/**
 * Rules with a check that did not run this audit, sorted by name (then id).
 * One entry per rule, from its first not-checked check. Info-severity rules
 * are left out: they summarize what another rule reports (links/dead-links
 * restates links/broken-external-links), so listing them would say the same
 * thing twice. Empty for reports written before repo#2729.
 */
export function notCheckedRules(report: NotCheckedReportShape): NotCheckedRule[] {
  const out: NotCheckedRule[] = [];
  for (const ruleId of Object.keys(report.ruleResults)) {
    const result = report.ruleResults[ruleId];
    if (!result || result.meta.severity === "info") continue;
    const check = result.checks.find(
      (c) =>
        c.status === "skipped" &&
        c.skipReason !== undefined &&
        NOT_CHECKED_SKIP_REASONS.has(c.skipReason),
    );
    if (!check || check.skipReason === undefined) continue;
    out.push({
      ruleId,
      name: result.meta.name,
      check: check.name,
      reason: check.skipReason,
      message: check.message,
      hint: HINTS[check.skipReason] ?? DEFAULT_HINT,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.ruleId.localeCompare(b.ruleId));
}

/** Ensure a sentence ends with a period, without doubling one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * One line per not-checked rule, e.g.
 *   "Not checked: Broken External Links. External link checking was off for
 *   this audit, so 12 external link(s) on the audited pages were not checked.
 *   Run a Surface or Full audit with external link checks on to check them."
 */
export function notCheckedLine(rule: NotCheckedRule): string {
  return `Not checked: ${rule.name}. ${sentence(rule.message)} ${rule.hint}`;
}

/** {@link notCheckedLine} for every not-checked rule; empty when none. */
export function notCheckedLines(report: NotCheckedReportShape): string[] {
  return notCheckedRules(report).map(notCheckedLine);
}
