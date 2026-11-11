// What became of a rule on a page or an audit: one typed outcome, and the one table that says what each
// coded skip reason means (#1661).
//
// A rule's outcome used to be encoded as `status: "skipped"` plus a `skipReason` string plus
// `details.errored`, and four predicates re-read that encoding in different places. Each coded reason is
// written down here once, with how far its verdict reaches and whether a report must say it was not
// checked; the predicates, the not-checked set and `classifyRuleOutcome` all read this table, so a new
// reason with no entry fails the test that lists them, instead of being misclassified quietly.
//
// Leaf module, no imports: the reason strings are literals, tied to their named constants by
// tests/rule-outcome-1661.test.ts.

/**
 * - `ran`: the check ran and said something (pass, warn, fail, an ordinary info).
 * - `not_applicable`: it has nothing to look at here (a noindex page, a contact page, no images). Clean, not a gap.
 * - `coverage_gap`: it did not look at all of what it should have, so "no finding" proves nothing.
 * - `timed_out`: the rule ran past its time budget.
 * - `errored`: the rule threw. Squirrel's defect, not the page's.
 * - `disabled`: it was left out on purpose (a waived page, a private target the run never probes).
 */
export const RULE_OUTCOMES = [
  "ran",
  "not_applicable",
  "coverage_gap",
  "timed_out",
  "errored",
  "disabled",
] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

export interface SkipReasonClass {
  outcome: Exclude<RuleOutcome, "ran" | "errored">;
  /** `rule`: the verdict covers every check of the rule on the page. `check`: only the check that skipped. */
  scope: "rule" | "check";
  /** Every report renders it as a visible "Not checked" line, and it never resolves an open finding. */
  notChecked: boolean;
}

const gap = (notChecked: boolean, scope: "rule" | "check" = "check"): SkipReasonClass => ({
  outcome: "coverage_gap",
  scope,
  notChecked,
});

/** Every coded `skipReason`. A reason that is free text (a sentence) is not in it. */
export const SKIP_REASON_CLASSES: Readonly<Record<string, SkipReasonClass>> = {
  // The runner's gates: a rule-wide "does not apply" verdict.
  noindex: { outcome: "not_applicable", scope: "rule", notChecked: false },
  "page-type": { outcome: "not_applicable", scope: "rule", notChecked: false },
  // One check with nothing to look at on this page.
  "not-applicable": { outcome: "not_applicable", scope: "check", notChecked: false },
  // A rule abandoned for its time budget; `details.errored` turns it into `errored`.
  "rule-timed-out": { outcome: "timed_out", scope: "rule", notChecked: true },
  // A page the parser could not read: nothing was looked at.
  "unread-page": gap(false, "rule"),
  // A rule that stopped at a work cap before it had seen the whole page.
  "scan-truncated": gap(false),
  "tls-certificate-not-checked": gap(true),
  "external-links-not-checked": gap(true),
  "link-targets-not-fetched": gap(true),
  "external-links-over-cap": gap(true),
  "external-links-out-of-time": gap(true),
  // A targeted run (#1777) fetched only the URLs it was given: a whole-site rule has nothing to judge.
  "targeted-run": gap(true, "rule"),
  // Prose rather than an id: published reports already carry this exact text.
  "Crawl capped before the frontier was exhausted": gap(true),
  // Left out on purpose.
  ignored: { outcome: "disabled", scope: "check", notChecked: false },
  "private-target": { outcome: "disabled", scope: "rule", notChecked: false },
};

/** The class of a coded skip reason, or undefined for free text, an empty reason or an unknown one. */
export function skipReasonClass(reason: string | undefined): SkipReasonClass | undefined {
  return reason !== undefined && Object.hasOwn(SKIP_REASON_CLASSES, reason)
    ? SKIP_REASON_CLASSES[reason]
    : undefined;
}

/**
 * A check that says part of the site was NOT read (#1749): a coded coverage-gap skip (`unread-page`,
 * `scan-truncated`, ...) or a check named `*-unscanned`, `*-omitted` or `*-unfetched` (a rule that found less
 * than it could, whatever its status). Dropping one reads as "clean" to a comparison, so the publish capper
 * keeps every one, like the not-checked skips.
 */
export function isCoverageGapCheck(check: {
  name: string;
  status: string;
  skipReason?: string | undefined;
}): boolean {
  if (check.status === "skipped") return skipReasonClass(check.skipReason)?.outcome === "coverage_gap";
  return /-(unscanned|omitted|unfetched)$/.test(check.name);
}

/** The slice of a check {@link classifyRuleOutcome} reads. */
export interface ClassifiableCheck {
  status: string;
  skipReason?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * The outcome of one check. A check that is not skipped ran. A skipped check is classified by its coded
 * reason, and a `rule-timed-out` skip whose `details.errored` is set is `errored`, not `timed_out`. A
 * skip with free text or no reason is `not_applicable`: it names nothing the rule failed to cover, and
 * the engine's page-level logic, not this classification, decides whether another check's evaluation
 * makes it a gap.
 */
export function classifyRuleOutcome(check: ClassifiableCheck): RuleOutcome {
  if (check.status !== "skipped") return "ran";
  const cls = skipReasonClass(check.skipReason);
  if (!cls) return "not_applicable";
  if (cls.outcome === "timed_out" && check.details?.errored === true) return "errored";
  return cls.outcome;
}
