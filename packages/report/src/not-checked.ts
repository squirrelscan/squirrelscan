// Checks that did not run for this audit (repo#2729). Shared across the CLI
// console and every report renderer.
//
// When external link checking is off (the Quick level, --offline,
// `[external_links] enabled = false`, a website setting), an audit found more
// external links than its limit, or the crawl did not follow links, the link
// rules emit a `skipped` check with a NOT_CHECKED skip reason. Skipped checks
// are neither passes nor findings, so the issue list leaves them out and the
// score never counts them. Left at that, a Quick audit reads as "no broken
// links" when nothing was checked. This turns each one into a visible "Not
// checked" line with the reason and what to run instead.

import {
  CRAWL_CAPPED_SKIP_REASON,
  EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
  EXTERNAL_LINKS_OUT_OF_TIME_SKIP_REASON,
  EXTERNAL_LINKS_OVER_CAP_SKIP_REASON,
  LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
  NOT_CHECKED_SKIP_REASONS,
  RULE_TIMED_OUT_SKIP_REASON,
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
    "Turn external link checks on to check them: in the CLI pass --external-links (or drop --no-external-links, --offline, or external_links.enabled = false); in the cloud they are a website setting.",
  [LINK_TARGETS_NOT_FETCHED_SKIP_REASON]:
    "Turn internal link checks back on (they are off with --no-internal-links or internal_links.enabled = false), raise internal_links.max_targets, or run a Surface or Full audit, which follows links, to check them.",
  [EXTERNAL_LINKS_OVER_CAP_SKIP_REASON]:
    "Raise the limit with external_links.max_links, or audit more pages, to check them.",
  [EXTERNAL_LINKS_OUT_OF_TIME_SKIP_REASON]:
    "Run the audit again to check them.",
  [RULE_TIMED_OUT_SKIP_REASON]:
    "A timed-out rule did not check those pages, so no finding there is not a clean result. Run the audit again, or raise [rules] time_budget_ms if the machine was busy.",
  // #1144: the inbound-link rules on a crawl that stopped at its page cap.
  [CRAWL_CAPPED_SKIP_REASON]:
    "Raise the page limit (--max-pages, or crawler.max_pages) so the crawl reaches every page, to check them.",
};

const DEFAULT_HINT = "Run a Surface or Full audit to check them.";

/**
 * The internal link hint for a check that says why its targets were not
 * fetched (`details.notFetched`, pub#726): turning the checks back on only
 * when they were off, raising `internal_links.max_targets` only when the
 * limit left targets out. A check from an older engine has no breakdown and
 * keeps the full hint.
 */
function linkTargetsHint(details: Record<string, unknown> | undefined): string {
  const notFetched = details?.notFetched;
  if (typeof notFetched !== "object" || notFetched === null) {
    return HINTS[LINK_TARGETS_NOT_FETCHED_SKIP_REASON]!;
  }
  const causes = notFetched as Record<string, unknown>;
  const present = Object.keys(causes).filter((key) => causes[key]);
  // The check skipped them on purpose, and a crawl stays inside the same scope
  // and robots.txt, so only the action and token links can still be reached.
  if (present.length === 1 && present[0] === "skipped") {
    return "A Surface or Full audit, which follows links, can reach the ones inside the crawl scope and allowed by robots.txt.";
  }
  const steps: string[] = [];
  if (causes.off) {
    steps.push(
      "turn internal link checks back on (they are off with --no-internal-links or internal_links.enabled = false)",
    );
  }
  if (causes.overLimit) steps.push("raise internal_links.max_targets");
  steps.push("run a Surface or Full audit, which follows links,");
  const text =
    steps.length === 1 ? steps[0]! : `${steps.slice(0, -1).join(", ")}, or ${steps.at(-1)}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} to check them.`;
}

function hintFor(check: { skipReason?: string; details?: Record<string, unknown> }): string {
  if (check.skipReason === LINK_TARGETS_NOT_FETCHED_SKIP_REASON)
    return linkTargetsHint(check.details);
  return (check.skipReason && HINTS[check.skipReason]) || DEFAULT_HINT;
}

/**
 * Rules with a check that did not run this audit, sorted by name (then id).
 * One entry per rule, from its first not-checked check. Info-severity rules
 * are left out: they summarize what another rule reports (links/dead-links
 * restates links/broken-external-links), so listing them would say the same
 * thing twice. Empty for reports written before repo#2729.
 */
/** A rule abandoned for its time budget on at least one page (pub#970). */
export interface TimedOutRule {
  ruleId: string;
  name: string;
  category: string;
  /** Pages it did not check. */
  pages: number;
  budgetMs?: number;
}

/**
 * Rules that ran past their time budget in this audit, from their skipped
 * `rule-timed-out` checks. The page count is the `<rule>-timeouts` row's
 * `pagesNotChecked` (the final count) when the report has it, else the most the
 * skipped rows themselves say, else the rows counted.
 */
export function timedOutRules(report: NotCheckedReportShape): TimedOutRule[] {
  const out: TimedOutRule[] = [];
  for (const ruleId of Object.keys(report.ruleResults)) {
    const result = report.ruleResults[ruleId];
    if (!result) continue;
    const skipped = result.checks.filter(
      (c) => c.status === "skipped" && c.skipReason === RULE_TIMED_OUT_SKIP_REASON,
    );
    if (skipped.length === 0) continue;
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const summary = result.checks.find((c) => c.name === `${ruleId}-timeouts`);
    // The summary's count is final. Without it (a published report may have cut the
    // row) the most any skipped row says: a fold keeps the pages it covered in
    // `occurrences` / `pagesTruncated`, a live row its running `pages`, else the
    // rows themselves.
    const pages =
      num(summary?.details?.pagesNotChecked) ??
      Math.max(
        skipped.length,
        ...skipped.map((c) =>
          Math.max(
            num(c.details?.pages) ?? 0,
            num(c.details?.occurrences) ?? 0,
            num(c.details?.pagesTruncated) ?? 0,
            c.pages?.length ?? 0,
          ),
        ),
      );
    out.push({
      ruleId,
      name: result.meta.name,
      category: result.meta.category,
      pages,
      budgetMs: num(skipped[0]!.details?.budgetMs),
    });
  }
  return out;
}

/** "Leaked Secrets timed out on 2 pages (exceeded its 1000 ms time budget)". */
export function timedOutMessage(rule: TimedOutRule): string {
  const budget = rule.budgetMs !== undefined ? ` (exceeded its ${rule.budgetMs} ms time budget)` : "";
  return `${rule.name} timed out on ${rule.pages} page${rule.pages === 1 ? "" : "s"}${budget}`;
}

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
    const timedOut =
      check.skipReason === RULE_TIMED_OUT_SKIP_REASON
        ? timedOutRules({ ruleResults: { [ruleId]: result } })[0]
        : undefined;
    out.push({
      ruleId,
      name: result.meta.name,
      check: check.name,
      reason: check.skipReason,
      // A timeout names the rule and the pages it did not check.
      message: timedOut ? timedOutMessage(timedOut) : check.message,
      hint: hintFor(check),
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
 * A not-checked rule as one list item under a "Not checked" heading, e.g.
 *   "Broken External Links. External link checking was off for this audit, so 12 external link(s)
 *   on the audited pages were not checked. Turn external link checks on to check them: ..."
 * The same sentence as {@link notCheckedLine} without its "Not checked: " lead-in.
 */
export function notCheckedDetailLine(rule: NotCheckedRule): string {
  return `${rule.name}. ${sentence(rule.message)} ${rule.hint}`;
}

/** {@link notCheckedDetailLine} for every not-checked rule; empty when none. */
export function notCheckedDetailLines(report: NotCheckedReportShape): string[] {
  return notCheckedRules(report).map(notCheckedDetailLine);
}

/**
 * One line per not-checked rule, e.g.
 *   "Not checked: Broken External Links. External link checking was off for
 *   this audit, so 12 external link(s) on the audited pages were not checked.
 *   Run a Surface or Full audit with external link checks on to check them."
 */
export function notCheckedLine(rule: NotCheckedRule): string {
  return `Not checked: ${notCheckedDetailLine(rule)}`;
}

/** {@link notCheckedLine} for every not-checked rule; empty when none. */
export function notCheckedLines(report: NotCheckedReportShape): string[] {
  return notCheckedRules(report).map(notCheckedLine);
}
