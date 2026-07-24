import { writeReportFile } from "@/reports/utils";

import type { DiffChange, DiffReport, IssueInstance } from "../types";

import { version } from "../../../../package.json";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indent(level: number): string {
  return " ".repeat(level);
}

function formatIssue(issue: IssueInstance, level: number): string[] {
  const lines: string[] = [];
  const attrs = [
    `fp="${escapeXml(issue.fingerprint)}"`,
    `rule="${escapeXml(issue.ruleId)}"`,
    `severity="${issue.severity}"`,
    `status="${issue.status}"`,
    `check="${escapeXml(issue.checkName)}"`,
    `category="${escapeXml(issue.category)}"`,
    `weight="${issue.weight}"`,
  ].join(" ");

  lines.push(`${indent(level)}<issue ${attrs}>`);
  lines.push(`${indent(level + 1)}${escapeXml(issue.message)}`);

  const label = issue.target.label ? ` (${issue.target.label})` : "";
  lines.push(
    `${indent(level + 1)}Target: ${issue.target.type} ${escapeXml(
      issue.target.id
    )}${escapeXml(label)}`
  );

  if (issue.sourcePages && issue.sourcePages.length > 0) {
    const sources = issue.sourcePages.map((s) => escapeXml(s)).join(", ");
    lines.push(
      `${indent(level + 1)}Sources (${issue.sourcePages.length}): ${sources}`
    );
  }

  if (issue.meta && Object.keys(issue.meta).length > 0) {
    const metaParts = Object.entries(issue.meta)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}: ${escapeXml(String(v))}`)
      .join(", ");
    lines.push(`${indent(level + 1)}Meta: ${metaParts}`);
  }

  lines.push(`${indent(level)}</issue>`);
  return lines;
}

function formatChange(change: DiffChange, level: number): string[] {
  const lines: string[] = [];
  const attrs = [
    `type="${change.changeType}"`,
    `fp="${escapeXml(change.after.fingerprint)}"`,
    `rule="${escapeXml(change.after.ruleId)}"`,
    `severity="${change.after.severity}"`,
    `status="${change.after.status}"`,
    `check="${escapeXml(change.after.checkName)}"`,
  ].join(" ");

  lines.push(`${indent(level)}<change ${attrs}>`);
  lines.push(
    `${indent(level + 1)}${escapeXml(change.before.status)}→${escapeXml(
      change.after.status
    )}: ${escapeXml(change.after.message)}`
  );
  lines.push(`${indent(level + 1)}Before:`);
  lines.push(...formatIssue(change.before, level + 2));
  lines.push(`${indent(level + 1)}After:`);
  lines.push(...formatIssue(change.after, level + 2));
  lines.push(`${indent(level)}</change>`);

  return lines;
}

export function generateDiffLlm(diff: DiffReport, outputPath?: string): void {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<diff version="${escapeXml(version)}">`);

  const baselineId = diff.baseline.id ?? "";
  const currentId = diff.current.id ?? "";

  lines.push(
    `${indent(1)}<baseline id="${escapeXml(
      baselineId
    )}" url="${escapeXml(diff.baseline.baseUrl)}" date="${escapeXml(
      diff.baseline.timestamp
    )}" pages="${diff.baseline.totalPages}" score="${
      diff.baseline.score?.overall ?? "N/A"
    }" grade="${diff.baseline.score?.grade ?? ""}"/>`
  );
  lines.push(
    `${indent(1)}<current id="${escapeXml(
      currentId
    )}" url="${escapeXml(diff.current.baseUrl)}" date="${escapeXml(
      diff.current.timestamp
    )}" pages="${diff.current.totalPages}" score="${
      diff.current.score?.overall ?? "N/A"
    }" grade="${diff.current.score?.grade ?? ""}"/>`
  );

  lines.push(
    `${indent(1)}<summary added="${diff.summary.added}" removed="${
      diff.summary.removed
    }" changed="${diff.summary.changed}" regressions="${
      diff.summary.regressions
    }" improvements="${diff.summary.improvements}"/>`
  );

  lines.push(`${indent(1)}<added>`);
  for (const issue of diff.added) {
    lines.push(...formatIssue(issue, 2));
  }
  lines.push(`${indent(1)}</added>`);

  lines.push(`${indent(1)}<removed>`);
  for (const issue of diff.removed) {
    lines.push(...formatIssue(issue, 2));
  }
  lines.push(`${indent(1)}</removed>`);

  lines.push(`${indent(1)}<changed>`);
  for (const change of diff.changed) {
    lines.push(...formatChange(change, 2));
  }
  lines.push(`${indent(1)}</changed>`);

  lines.push("</diff>");

  const content = lines.join("\n");

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`Diff report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
