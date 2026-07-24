import { writeReportFile } from "@/reports/utils";

import type { DiffChange, DiffReport, IssueInstance } from "../types";

function formatIssue(issue: IssueInstance): string {
  const label = issue.target.label ? ` (${issue.target.label})` : "";
  const target = `${issue.target.type}:${issue.target.id}${label}`;
  const status = issue.status === "fail" ? "ERROR" : "WARN";
  return `${status} ${issue.ruleId} ${issue.checkName} - ${issue.message} [${target}] (${issue.fingerprint})`;
}

function formatChange(change: DiffChange): string {
  const label = change.after.target.label
    ? ` (${change.after.target.label})`
    : "";
  const target = `${change.after.target.type}:${change.after.target.id}${label}`;
  const transition = `${change.before.status}→${change.after.status}`;
  return `${change.changeType.toUpperCase()} ${change.after.ruleId} ${change.after.checkName} ${transition} - ${change.after.message} [${target}] (${change.after.fingerprint})`;
}

function renderSection(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [title, "(none)", ""];
  }
  return [title, ...lines.map((line) => `- ${line}`), ""];
}

export function renderDiffText(diff: DiffReport): string {
  const lines: string[] = [];

  lines.push(
    "================================================================================"
  );
  lines.push("SQUIRRELSCAN DIFF REPORT");
  lines.push(
    `${diff.baseline.baseUrl} → ${diff.current.baseUrl} • ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.changed} changed`
  );
  lines.push(
    "================================================================================"
  );
  lines.push("");

  lines.push("SUMMARY");
  lines.push(
    `Added: ${diff.summary.added} | Removed: ${diff.summary.removed} | Changed: ${diff.summary.changed} | Regressions: ${diff.summary.regressions} | Improvements: ${diff.summary.improvements}`
  );
  lines.push("");

  lines.push(...renderSection("ADDED", diff.added.map(formatIssue)));
  lines.push(...renderSection("REMOVED", diff.removed.map(formatIssue)));
  lines.push(...renderSection("CHANGED", diff.changed.map(formatChange)));

  return lines.join("\n");
}

export function generateDiffText(diff: DiffReport, outputPath?: string): void {
  const content = renderDiffText(diff);
  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`Diff report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
