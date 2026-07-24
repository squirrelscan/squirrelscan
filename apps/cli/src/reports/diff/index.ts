import type { SeverityLevel } from "@/reports/filters";
import type {
  AuditReport,
  CheckItem,
  CheckResult,
  ReportRuleResult,
} from "@/types";

import { getScoreGrade } from "@/audit/scoring";

import type {
  DiffChange,
  DiffChangeType,
  DiffOptions,
  DiffReport,
  DiffSide,
  IssueInstance,
} from "./types";

import {
  fingerprintForIssue,
  normalizeTargetId,
  type IssueTargetType,
} from "./fingerprint";

function shouldIncludeCheck(
  check: CheckResult,
  severity?: SeverityLevel
): check is CheckResult & { status: "fail" | "warn" } {
  if (check.status !== "fail" && check.status !== "warn") return false;
  if (!severity || severity === "all") return true;
  if (severity === "error") return check.status === "fail";
  return check.status === "warn";
}

function buildMeta(
  check: CheckResult,
  item?: CheckItem
): Record<string, unknown> | undefined {
  if (item?.meta && check.details) {
    return { ...check.details, ...item.meta };
  }
  return item?.meta ?? check.details ?? undefined;
}

function buildIssueInstance(
  report: AuditReport,
  ruleId: string,
  rule: ReportRuleResult,
  check: CheckResult,
  targetType: IssueTargetType,
  targetIdRaw: string,
  targetLabel?: string,
  sourcePages?: string[],
  meta?: Record<string, unknown>
): IssueInstance {
  const targetId = normalizeTargetId(targetIdRaw, report.baseUrl);
  const fingerprint = fingerprintForIssue(
    ruleId,
    check.name,
    targetType,
    targetId
  );

  return {
    fingerprint,
    ruleId,
    ruleName: rule.meta.name,
    category: rule.meta.category,
    severity: rule.meta.severity,
    weight: rule.meta.weight,
    checkName: check.name,
    status: check.status as "fail" | "warn",
    message: check.message,
    target: {
      type: targetType,
      id: targetId,
      label: targetLabel,
    },
    sourcePages,
    meta,
  };
}

export function buildIssueInstances(
  report: AuditReport,
  severity?: SeverityLevel
): IssueInstance[] {
  const instances: IssueInstance[] = [];
  const ruleEntries: Array<[string, ReportRuleResult]> =
    report.ruleResults instanceof Map
      ? Array.from(report.ruleResults.entries())
      : Object.entries(report.ruleResults);

  for (const [ruleId, rule] of ruleEntries) {
    for (const check of rule.checks) {
      if (!shouldIncludeCheck(check, severity)) continue;

      if (check.items && check.items.length > 0) {
        for (const item of check.items) {
          instances.push(
            buildIssueInstance(
              report,
              ruleId,
              rule,
              check,
              "item",
              item.id,
              item.label,
              item.sourcePages,
              buildMeta(check, item)
            )
          );
        }
        continue;
      }

      if (check.pages && check.pages.length > 0) {
        for (const page of check.pages) {
          instances.push(
            buildIssueInstance(
              report,
              ruleId,
              rule,
              check,
              "page",
              page,
              undefined,
              undefined,
              buildMeta(check)
            )
          );
        }
        continue;
      }

      if (check.pageUrl) {
        instances.push(
          buildIssueInstance(
            report,
            ruleId,
            rule,
            check,
            "page",
            check.pageUrl,
            undefined,
            undefined,
            buildMeta(check)
          )
        );
        continue;
      }

      instances.push(
        buildIssueInstance(
          report,
          ruleId,
          rule,
          check,
          "check",
          check.name,
          undefined,
          undefined,
          buildMeta(check)
        )
      );
    }
  }

  return instances;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    );
    return `{${entries
      .map(([k, v]) => `${k}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return String(value);
}

function issuesDiffer(a: IssueInstance, b: IssueInstance): boolean {
  if (a.status !== b.status) return true;
  if (a.message !== b.message) return true;
  return stableStringify(a.meta) !== stableStringify(b.meta);
}

function changeTypeFor(
  before: IssueInstance,
  after: IssueInstance
): DiffChangeType {
  if (before.status === "warn" && after.status === "fail") return "regression";
  if (before.status === "fail" && after.status === "warn") return "improvement";
  return "change";
}

function sortIssues(issues: IssueInstance[]): IssueInstance[] {
  const severityRank: Record<string, number> = {
    error: 3,
    warning: 2,
    info: 1,
  };

  return [...issues].sort((a, b) => {
    const sevDiff =
      (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const weightDiff = b.weight - a.weight;
    if (weightDiff !== 0) return weightDiff;
    const ruleDiff = a.ruleId.localeCompare(b.ruleId);
    if (ruleDiff !== 0) return ruleDiff;
    const checkDiff = a.checkName.localeCompare(b.checkName);
    if (checkDiff !== 0) return checkDiff;
    return a.target.id.localeCompare(b.target.id);
  });
}

function sortChanges(changes: DiffChange[]): DiffChange[] {
  const sorted = [...changes];
  return sorted.sort((a, b) => {
    const sevRank: Record<string, number> = {
      error: 3,
      warning: 2,
      info: 1,
    };
    const sevDiff =
      (sevRank[b.after.severity] ?? 0) - (sevRank[a.after.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const weightDiff = b.after.weight - a.after.weight;
    if (weightDiff !== 0) return weightDiff;
    const ruleDiff = a.after.ruleId.localeCompare(b.after.ruleId);
    if (ruleDiff !== 0) return ruleDiff;
    return a.after.target.id.localeCompare(b.after.target.id);
  });
}

function buildSide(report: AuditReport): DiffSide {
  // A failed/0-page side has no score — keep it null (N/A), never coerce to 0,
  // else a diff shows a bogus "-85 point / F regression" for a failed run (#586).
  const overall = report.healthScore?.overall ?? null;
  return {
    id: report.crawlId,
    baseUrl: report.baseUrl,
    timestamp: report.timestamp,
    totalPages: report.totalPages,
    score: {
      overall,
      grade: overall === null ? "N/A" : getScoreGrade(overall),
    },
  };
}

export function diffReports(
  baseline: AuditReport,
  current: AuditReport,
  options: DiffOptions = {}
): DiffReport {
  const baselineIssues = buildIssueInstances(baseline, options.severity);
  const currentIssues = buildIssueInstances(current, options.severity);

  const baselineMap = new Map<string, IssueInstance>();
  for (const issue of baselineIssues) {
    if (!baselineMap.has(issue.fingerprint)) {
      baselineMap.set(issue.fingerprint, issue);
    }
  }

  const currentMap = new Map<string, IssueInstance>();
  for (const issue of currentIssues) {
    if (!currentMap.has(issue.fingerprint)) {
      currentMap.set(issue.fingerprint, issue);
    }
  }

  const added: IssueInstance[] = [];
  const removed: IssueInstance[] = [];
  const changed: DiffChange[] = [];

  for (const [fingerprint, issue] of currentMap) {
    const baselineIssue = baselineMap.get(fingerprint);
    if (!baselineIssue) {
      added.push(issue);
      continue;
    }
    if (issuesDiffer(baselineIssue, issue)) {
      changed.push({
        before: baselineIssue,
        after: issue,
        changeType: changeTypeFor(baselineIssue, issue),
      });
    }
  }

  for (const [fingerprint, issue] of baselineMap) {
    if (!currentMap.has(fingerprint)) {
      removed.push(issue);
    }
  }

  const sortedAdded = sortIssues(added);
  const sortedRemoved = sortIssues(removed);
  const sortedChanged = sortChanges(changed);

  const regressions = sortedChanged.filter(
    (c) => c.changeType === "regression"
  ).length;
  const improvements = sortedChanged.filter(
    (c) => c.changeType === "improvement"
  ).length;

  return {
    baseline: buildSide(baseline),
    current: buildSide(current),
    summary: {
      added: sortedAdded.length,
      removed: sortedRemoved.length,
      changed: sortedChanged.length,
      regressions,
      improvements,
    },
    added: sortedAdded,
    removed: sortedRemoved,
    changed: sortedChanged,
  };
}

export function isSameBaseUrl(a: AuditReport, b: AuditReport): boolean {
  return a.baseUrl === b.baseUrl;
}
