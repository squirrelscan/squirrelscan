import type { DiffReport, IssueInstance, NotComparedIssue } from "./types";

/** What each reason says, in the words every diff format uses (#1748). */
const REASON_TEXT: Record<NotComparedIssue["reason"], string> = {
  "different-scope": "the two audits cover different sites",
  "rule-not-run": "the rule did not run in the current audit",
  "rule-skipped": "the rule was skipped in the current audit",
  "rule-timed-out": "the rule timed out in the current audit",
  "rule-not-run-in-baseline": "the rule did not run in the baseline audit",
  "page-not-crawled": "the page was not crawled in the current audit",
  "rule-skipped-on-page": "the rule skipped the page in the current audit",
  "items-capped":
    "the rule listed only some of its items in the current audit, and this one may be among the rest",
  "sampled-report":
    "the current report is a sampled export that cannot show the finding is gone",
  "targeted-run":
    "the current audit covered only the URLs it was given, and this finding names no page",
  "not-evaluated": "the rule did not evaluate it in the current audit",
};

/** A baseline issue stored under a superseded check name whose successors were not checked (#1765). */
const SUPERSEDED_TEXT =
  "the check that replaced it was not run in the current audit";

export interface NotComparedRow {
  issue: IssueInstance;
  /** `reason` code, or `superseded-check-not-run` for a #1765 entry. */
  reason: string;
  /** The reason in words, with the coded skip reason or the page when there is one. */
  text: string;
}

/**
 * Every baseline issue the current report no longer has that is NOT counted as fixed, in one list for the
 * text formats: the ones whose rule did not run over the same scope (#1748) and the ones stored under a
 * superseded check name whose successors were not checked (#1765).
 */
export function notComparedRows(diff: DiffReport): NotComparedRow[] {
  const rows: NotComparedRow[] = (diff.notCompared ?? []).map((n) => ({
    issue: n.issue,
    reason: n.reason,
    text: `${REASON_TEXT[n.reason]}${n.detail ? ` (${n.detail})` : ""}`,
  }));
  for (const issue of diff.notChecked ?? []) {
    rows.push({
      issue,
      reason: "superseded-check-not-run",
      text: SUPERSEDED_TEXT,
    });
  }
  return rows;
}

/** A destination a site chose (its `Location`), made safe to print: no control characters or escape sequences. */
function printable(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
}

/**
 * The page-level reason a `removed` issue is gone (#1759), in words: `now redirects to X (301)` or `now
 * returns 410`. Null when the issue was fixed on its page. The destination is the site's own text, so it
 * is printed without control characters.
 */
export function resolvedByText(issue: IssueInstance): string | null {
  const by = issue.resolvedBy;
  if (!by) return null;
  return by.kind === "redirected"
    ? `now redirects to ${printable(by.to)} (${by.status})`
    : `now returns ${by.status}`;
}

/** The same text inside a markdown table cell: `|` and backticks escaped, so a destination cannot break the row. */
export function resolvedByCell(issue: IssueInstance): string | null {
  const text = resolvedByText(issue);
  return text === null ? null : text.replace(/[\\|`]/g, (c) => `\\${c}`);
}
