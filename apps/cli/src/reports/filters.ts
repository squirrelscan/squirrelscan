// Category/severity filtering for reports

import type { AuditReport, CheckResult } from "@/types";

import { normalizeCategoryCode, type RuleCategory } from "@/rules/categories";

export type SeverityLevel = "error" | "warning" | "all";

/**
 * Filter report by categories.
 * Filters ruleResults (the authoritative source for grouped reports).
 * page.checks and siteChecks are not filtered since they lack ruleId context.
 */
export function filterByCategory(
  report: AuditReport,
  categories: RuleCategory[]
): AuditReport {
  // Normalize both sides so a legacy stored "adblock" matches "blocking" and
  // an "adblock" request still filters renamed reports.
  const categorySet = new Set<string>(categories.map(normalizeCategoryCode));

  // Filter ruleResults - this is what groupIssuesByCategory uses
  const filteredRuleResults = Object.fromEntries(
    Object.entries(report.ruleResults).filter(([_, result]) =>
      categorySet.has(normalizeCategoryCode(result.meta.category))
    )
  );

  return {
    ...report,
    ruleResults: filteredRuleResults,
  };
}

// Filter report by severity level
export function filterBySeverity(
  report: AuditReport,
  level: SeverityLevel
): AuditReport {
  if (level === "all") return report;

  const shouldInclude = (check: CheckResult): boolean => {
    if (level === "error") {
      return check.status === "fail";
    }
    return check.status === "fail" || check.status === "warn";
  };

  // Filter page checks
  const filteredPages = report.pages.map((page) => ({
    ...page,
    checks: page.checks.filter(shouldInclude),
  }));

  // Filter site checks
  const filteredSiteChecks = report.siteChecks.filter(shouldInclude);

  return {
    ...report,
    pages: filteredPages,
    siteChecks: filteredSiteChecks,
  };
}
