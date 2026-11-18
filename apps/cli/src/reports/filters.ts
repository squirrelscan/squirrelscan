// Category/severity filtering for reports

import type { AuditReport, CheckResult } from "@/types";

import {
  getCategoriesInGroup,
  GROUP_CODES,
  isValidGroup,
  normalizeCategoryCode,
  type RuleCategory,
  type RuleGroup,
} from "@/rules/categories";

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

/** Parse a comma-separated `--group` value; unknown ids come back in `invalid`. */
export function parseGroupArg(value: string): {
  groups: RuleGroup[];
  invalid: string[];
} {
  const ids = value
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter((g) => g.length > 0);
  return {
    groups: ids.filter(isValidGroup),
    invalid: ids.filter((g) => !isValidGroup(g)),
  };
}

export const VALID_GROUPS_TEXT = GROUP_CODES.join(", ");

/** Keep only issues from categories in the given rule groups (#626). */
export function filterByGroup(
  report: AuditReport,
  groups: RuleGroup[]
): AuditReport {
  return filterByCategory(
    report,
    groups.flatMap((g) => getCategoriesInGroup(g))
  );
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
