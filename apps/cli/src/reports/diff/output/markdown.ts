import { writeReportFile } from "@/reports/utils";

import type { DiffChange, DiffReport, IssueInstance } from "../types";

import { notComparedRows, resolvedByCell } from "../not-compared";

function formatIssue(issue: IssueInstance): string {
  const label = issue.target.label ? ` (${issue.target.label})` : "";
  const target = `${issue.target.type}:${issue.target.id}${label}`;
  const status = issue.status === "fail" ? "error" : "warning";
  const resolved = resolvedByCell(issue);
  return `${issue.ruleId} | ${issue.checkName} | ${status} | ${target}${resolved ? ` (resolved: ${resolved})` : ""} | ${issue.fingerprint}`;
}

function formatChange(change: DiffChange): string {
  const label = change.after.target.label
    ? ` (${change.after.target.label})`
    : "";
  const target = `${change.after.target.type}:${change.after.target.id}${label}`;
  return `${change.after.ruleId} | ${change.after.checkName} | ${change.changeType} | ${change.before.status}→${change.after.status} | ${target} | ${change.after.fingerprint}`;
}

function renderSection(
  title: string,
  rows: string[],
  headerLines: string[]
): string[] {
  if (rows.length === 0) {
    return [`## ${title}`, "", "(none)", ""];
  }

  return [
    `## ${title}`,
    "",
    ...headerLines,
    ...rows.map((row) => `| ${row} |`),
    "",
  ];
}

export function renderDiffMarkdown(diff: DiffReport): string {
  const lines: string[] = [];

  lines.push("# Diff Report");
  lines.push("");
  lines.push(
    `**Base URL:** ${diff.baseline.baseUrl} → ${diff.current.baseUrl}`
  );
  const notCompared = notComparedRows(diff);
  lines.push(
    `**Summary:** ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.changed} changed (Regressions: ${diff.summary.regressions}, Improvements: ${diff.summary.improvements})${notCompared.length > 0 ? `, ${notCompared.length} not compared` : ""}`
  );
  lines.push("");

  const issueHeader = "| Rule | Check | Severity | Target | Fingerprint |";
  const changeHeader =
    "| Rule | Check | Change | Status | Target | Fingerprint |";

  lines.push(
    ...renderSection("Added", diff.added.map(formatIssue), [
      issueHeader,
      "| --- | --- | --- | --- | --- |",
    ])
  );

  lines.push(
    ...renderSection("Removed", diff.removed.map(formatIssue), [
      issueHeader,
      "| --- | --- | --- | --- | --- |",
    ])
  );

  lines.push(
    ...renderSection("Changed", diff.changed.map(formatChange), [
      changeHeader,
      "| --- | --- | --- | --- | --- | --- |",
    ])
  );

  if (notCompared.length > 0) {
    lines.push(
      ...renderSection(
        "Not compared (not counted as fixed)",
        notCompared.map((r) => `${formatIssue(r.issue)} | ${r.text}`),
        [
          "| Rule | Check | Severity | Target | Fingerprint | Why |",
          "| --- | --- | --- | --- | --- | --- |",
        ]
      )
    );
  }

  return lines.join("\n");
}

export function generateDiffMarkdown(
  diff: DiffReport,
  outputPath?: string
): void {
  const content = renderDiffMarkdown(diff);
  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`Diff report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
