// Accessibility checklist (repo#3094): one row per WCAG 2.2 Level A and AA success criterion, with what the
// rules found for it on this audit. It is a starting point for a manual review, never a conformance claim:
// automated checks cover part of WCAG, so every row still needs a manual check.
//
// The criteria and their titles come from the one WCAG table (`@squirrelscan/core-contracts/wcag`), and the
// rule-to-criterion map is each rule's `meta.wcag`. The caller passes the rule metas in, so this package does
// not depend on the rules package.

import { classifyRuleOutcome } from "@squirrelscan/core-contracts/rule-outcome";
import {
  WCAG_CRITERIA,
  type WcagCriterion,
  type WcagLevel,
  type WcagVersion,
} from "@squirrelscan/core-contracts/wcag";

import type { AuditReport } from "./types";

/** A rule's id and the criteria its `meta.wcag` declares; rules with none are ignored. */
export interface WcagChecklistRule {
  id: string;
  wcag?: readonly WcagCriterion[];
}

/**
 * What the rules found for a criterion on this audit:
 * - `finding`: a rule mapped to it ran and reported a warning or failure;
 * - `no-finding`: rules mapped to it ran and reported none;
 * - `not-run`: rules are mapped to it, but none ran on this audit (a rule that ran and found nothing to
 *   check on any page, a `not_applicable` outcome, did run);
 * - `no-rule`: no rule is mapped to it.
 */
export type WcagChecklistStatus = "finding" | "no-finding" | "not-run" | "no-rule";

export const WCAG_CHECKLIST_STATUS_LABELS: Record<WcagChecklistStatus, string> = {
  finding: "Rules found an issue",
  "no-finding": "Rules found no issue",
  "not-run": "Rules did not run",
  "no-rule": "No rule covers it",
};

export const WCAG_CHECKLIST_DISCLAIMER =
  "Automated checks cover only part of WCAG. This checklist lists what the audit rules found for each WCAG 2.2 Level A and AA success criterion; it is not a conformance claim or an accessibility statement. A criterion where the rules found no issue can still fail in ways they cannot see, and passing every automated check does not mean a site conforms to WCAG. Every criterion still needs a manual check, including with assistive technology.";

export const WCAG_CHECKLIST_NOTES: readonly string[] = [
  "Criteria are WCAG 2.2 Level A and AA. 4.1.1 Parsing is obsolete in WCAG 2.2 and left out.",
  "Rules found an issue: a rule mapped to the criterion reported a warning or failure, a lead to check rather than a verdict. Rules found no issue: the rules mapped to it ran and reported nothing. Rules did not run: rules are mapped to it, but none ran on this audit (excluded, filtered by --wcag-level, timed out or errored). Re-run without the exclusion to check it. No rule covers it: no audit rule is mapped to it.",
];

const MANUAL_CHECK = "Still needed";

export interface WcagChecklistRow {
  sc: string;
  title: string;
  level: WcagLevel;
  /** The WCAG version that introduced the criterion. */
  version: WcagVersion;
  status: WcagChecklistStatus;
  /** Rules mapped to the criterion that ran. */
  rules: string[];
  /** Rules mapped to the criterion that did not run on this audit. */
  notRun: string[];
  /** Rules that ran and reported a warning or failure. */
  findings: string[];
}

/** The WCAG 2.2 Level A and AA criteria, in document order. */
function checklistCriteria(): { sc: string; title: string; level: WcagLevel; version: WcagVersion }[] {
  return Object.entries(WCAG_CRITERIA)
    .filter(([, entry]) => entry.level !== "AAA")
    .map(([sc, entry]) => ({ sc, ...entry }));
}

/** One row per WCAG 2.2 A/AA criterion, with what the rules mapped to it found on this audit. */
export function buildWcagChecklist(
  report: Pick<AuditReport, "ruleResults">,
  rules: Iterable<WcagChecklistRule>,
): WcagChecklistRow[] {
  const byCriterion = new Map<string, string[]>();
  for (const rule of rules) {
    for (const criterion of rule.wcag ?? []) {
      const ids = byCriterion.get(criterion.sc) ?? [];
      if (!ids.includes(rule.id)) ids.push(rule.id);
      byCriterion.set(criterion.sc, ids);
    }
  }
  return checklistCriteria().map((criterion) => {
    const mapped = (byCriterion.get(criterion.sc) ?? []).sort();
    const ran: string[] = [];
    const notRun: string[] = [];
    const findings: string[] = [];
    for (const ruleId of mapped) {
      const checks = report.ruleResults[ruleId]?.checks ?? [];
      // A rule that ran and had nothing to check (a `not_applicable` outcome on every page) answered too.
      if (
        !checks.some((check) => {
          const outcome = classifyRuleOutcome(check);
          return outcome === "ran" || outcome === "not_applicable";
        })
      ) {
        notRun.push(ruleId);
        continue;
      }
      ran.push(ruleId);
      if (checks.some((check) => check.status === "warn" || check.status === "fail")) findings.push(ruleId);
    }
    const status: WcagChecklistStatus =
      mapped.length === 0
        ? "no-rule"
        : ran.length === 0
          ? "not-run"
          : findings.length > 0
            ? "finding"
            : "no-finding";
    return { ...criterion, status, rules: ran, notRun, findings };
  });
}

export function wcagChecklistCounts(rows: readonly WcagChecklistRow[]): Record<WcagChecklistStatus, number> {
  const counts: Record<WcagChecklistStatus, number> = {
    finding: 0,
    "no-finding": 0,
    "not-run": 0,
    "no-rule": 0,
  };
  for (const row of rows) counts[row.status]++;
  return counts;
}

function cell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

/** Whether any rule declares a WCAG criterion: with none, every row would read "No rule covers it". */
export function hasWcagDeclarations(rules: Iterable<WcagChecklistRule>): boolean {
  for (const rule of rules) if ((rule.wcag?.length ?? 0) > 0) return true;
  return false;
}

/** The checklist as markdown lines, disclaimer first. Brand-neutral, so white-label reports keep it. */
export function wcagChecklistMarkdownLines(rows: readonly WcagChecklistRow[], headingLevel = 2): string[] {
  const h = "#".repeat(headingLevel);
  const counts = wcagChecklistCounts(rows);
  const lines: string[] = [
    `${h} Accessibility checklist`,
    "",
    // A plain paragraph, not a blockquote: a `>` line would swallow the lines below it (#190).
    `**Not a conformance claim.** ${WCAG_CHECKLIST_DISCLAIMER}`,
    "",
    `Of ${rows.length} WCAG 2.2 A/AA criteria: rules found an issue on ${counts.finding}, found no issue on ${counts["no-finding"]}, did not run on ${counts["not-run"]}, and no rule covers ${counts["no-rule"]}. All ${rows.length} still need a manual check.`,
    "",
  ];
  for (const note of WCAG_CHECKLIST_NOTES) lines.push(`- ${note}`);
  lines.push(
    "",
    "| Criterion | Level | What the rules found | Rules that ran | Rules that did not run | Rules with findings | Manual check |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of rows) {
    lines.push(
      `| ${row.sc} ${cell(row.title)} | ${row.level} | ${WCAG_CHECKLIST_STATUS_LABELS[row.status]} | ${cell(row.rules.join(", ") || "none")} | ${cell(row.notRun.join(", ") || "none")} | ${cell(row.findings.join(", ") || "none")} | [ ] ${MANUAL_CHECK} |`,
    );
  }
  lines.push("");
  return lines;
}

/** A spreadsheet runs a cell starting with these as a formula; prefix a quote so report text cannot. */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The checklist as CSV for a manual review pass: one row per criterion, with empty reviewer columns. */
export function wcagChecklistCsv(rows: readonly WcagChecklistRow[]): string {
  const header = [
    "criterion",
    "title",
    "level",
    "rules_found",
    "rules_ran",
    "rules_not_run",
    "rules_with_findings",
    "manual_check",
    "manual_result",
    "reviewer_notes",
  ];
  const out = [header.join(",")];
  for (const row of rows) {
    out.push(
      [
        row.sc,
        row.title,
        row.level,
        WCAG_CHECKLIST_STATUS_LABELS[row.status],
        row.rules.join(" "),
        row.notRun.join(" "),
        row.findings.join(" "),
        MANUAL_CHECK,
        "",
        "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${out.join("\n")}\n`;
}

/** The checklist as a standalone markdown document for a review pass. */
export function wcagChecklistMarkdown(rows: readonly WcagChecklistRow[]): string {
  return `${wcagChecklistMarkdownLines(rows, 1).join("\n")}\n`;
}
