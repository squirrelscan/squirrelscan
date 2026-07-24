// Tests for report generation and domain grouping

import { describe, expect, test } from "bun:test";

import type { ReportRuleResult } from "../../src/types";

import { groupIssuesByCategory } from "../../src/reports/grouping";
import { OTHER_CATEGORY, getCategoryName } from "../../src/rules/categories";

describe("groupIssuesByCategory", () => {
  test("returns empty array for empty results", () => {
    const result = groupIssuesByCategory({});
    expect(result).toEqual([]);
  });

  test("returns empty array when no issues", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          { name: "title-exists", status: "pass", message: "Title present" },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result).toEqual([]);
  });

  test("groups single rule with failures", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          { name: "title-exists", status: "fail", message: "Title missing" },
          { name: "title-exists", status: "fail", message: "Title missing" },
          { name: "title-length", status: "pass", message: "Title OK" },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result.length).toBe(1);
    expect(result[0].code).toBe("core");
    expect(result[0].name).toBe("Core SEO");
    expect(result[0].failCount).toBe(2);
    expect(result[0].warnCount).toBe(0);
    expect(result[0].rules.length).toBe(1);
    expect(result[0].rules[0].id).toBe("core/meta-title");
    expect(result[0].rules[0].checks.length).toBe(1); // aggregated
    expect(result[0].rules[0].checks[0].count).toBe(2);
  });

  test("groups multiple rules in same domain", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          { name: "title-exists", status: "fail", message: "Title missing" },
        ],
      },
      "core/canonical": {
        meta: {
          id: "core/canonical",
          name: "Canonical URL",
          description: "Check canonical",
          category: "core",
          scope: "page",
          severity: "warning",
          weight: 8,
        },
        checks: [
          {
            name: "canonical-exists",
            status: "warn",
            message: "Missing canonical",
          },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result.length).toBe(1);
    expect(result[0].code).toBe("core");
    expect(result[0].rules.length).toBe(2);
    expect(result[0].failCount).toBe(1);
    expect(result[0].warnCount).toBe(1);
  });

  test("groups rules across multiple domains", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          { name: "title-exists", status: "fail", message: "Title missing" },
        ],
      },
      "security/https": {
        meta: {
          id: "security/https",
          name: "HTTPS",
          description: "Check HTTPS",
          category: "security",
          scope: "site",
          severity: "error",
          weight: 9,
        },
        checks: [
          { name: "https-enabled", status: "fail", message: "No HTTPS" },
          { name: "https-enabled", status: "fail", message: "No HTTPS" },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result.length).toBe(2);
    // Core has higher priority than security
    expect(result[0].code).toBe("core");
    expect(result[0].failCount).toBe(1);
    expect(result[1].code).toBe("security");
    expect(result[1].failCount).toBe(2);
  });

  test("sorts rules by weight within domain", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/low-weight": {
        meta: {
          id: "core/low-weight",
          name: "Low Weight",
          description: "Low weight rule",
          category: "core",
          scope: "page",
          severity: "warning",
          weight: 2,
        },
        checks: [{ name: "check", status: "warn", message: "Warning" }],
      },
      "core/high-weight": {
        meta: {
          id: "core/high-weight",
          name: "High Weight",
          description: "High weight rule",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [{ name: "check", status: "fail", message: "Error" }],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result[0].rules[0].id).toBe("core/high-weight");
    expect(result[0].rules[1].id).toBe("core/low-weight");
  });

  test("aggregates checks by name and status with different words", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "images/alt-text": {
        meta: {
          id: "images/alt-text",
          name: "Alt Text",
          description: "Check alt text",
          category: "images",
          scope: "page",
          severity: "warning",
          weight: 6,
        },
        checks: [
          {
            name: "alt-issue",
            status: "warn",
            message: "Alt text missing",
          },
          {
            name: "alt-issue",
            status: "warn",
            message: "Alt text too long",
          },
          {
            name: "alt-empty",
            status: "fail",
            message: "Empty alt attribute",
          },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    // Different words in messages keep checks separate
    expect(result[0].rules[0].checks.length).toBe(3);

    const warnChecks = result[0].rules[0].checks.filter(
      (c) => c.name === "alt-issue"
    );
    expect(warnChecks.length).toBe(2);
    expect(warnChecks.every((c) => c.count === 1)).toBe(true);

    const failCheck = result[0].rules[0].checks.find(
      (c) => c.name === "alt-empty"
    );
    expect(failCheck?.count).toBe(1);
    expect(failCheck?.status).toBe("fail");
  });

  test("groups checks with same name+status+message across pages", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          {
            name: "title-length",
            status: "fail",
            message: "Title too short",
            pageUrl: "https://example.com/page1",
            items: [
              {
                id: "https://example.com/page1",
                label: "Short title (18 chars)",
              },
            ],
          },
          {
            name: "title-length",
            status: "fail",
            message: "Title too short",
            pageUrl: "https://example.com/page2",
            items: [
              {
                id: "https://example.com/page2",
                label: "Another short (25 chars)",
              },
            ],
          },
          {
            name: "title-length",
            status: "fail",
            message: "Title too short",
            pageUrl: "https://example.com/page3",
            items: [
              { id: "https://example.com/page3", label: "Tiny (12 chars)" },
            ],
          },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    // Same message groups into a single check with merged items
    expect(result[0].rules[0].checks.length).toBe(1);
    expect(result[0].rules[0].checks[0].message).toBe("Title too short");
    expect(result[0].rules[0].checks[0].count).toBe(3);
  });

  test("merges checks with same name+status and collects items", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "links/internal-links": {
        meta: {
          id: "links/internal-links",
          name: "Internal Links",
          description: "Check internal links",
          category: "links",
          scope: "page",
          severity: "warning",
          weight: 4,
        },
        checks: [
          {
            name: "link-issue",
            status: "warn",
            message: "Problematic link",
            items: [{ id: "/page-a" }],
          },
          {
            name: "link-issue",
            status: "warn",
            message: "Problematic link",
            items: [{ id: "/page-b" }],
          },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    const checks = result[0].rules[0].checks;
    // Checks with same name+status are merged
    expect(checks.length).toBe(1);
    expect(checks[0].count).toBe(2);
    // Items are collected and deduplicated
    expect(checks[0].items?.length).toBe(2);
  });

  test("excludes pass and info checks from output", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          { name: "title-exists", status: "fail", message: "Missing" },
          { name: "title-length", status: "pass", message: "OK" },
          { name: "title-info", status: "info", message: "Info" },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result[0].rules[0].checks.length).toBe(1);
    expect(result[0].rules[0].checks[0].status).toBe("fail");
  });

  test("buckets OTHER_CATEGORY rules correctly", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "other/rule": {
        meta: {
          id: "other/rule",
          name: "Other Rule",
          description: "Rule in other domain",
          category: OTHER_CATEGORY,
          scope: "page",
          severity: "error",
          weight: 5,
        },
        checks: [{ name: "check", status: "fail", message: "Fail" }],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result.length).toBe(1);
    expect(result[0].code).toBe(OTHER_CATEGORY);
    expect(result[0].name).toBe(getCategoryName(OTHER_CATEGORY));
  });

  test("uses category name from CATEGORY_NAMES", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "security/https": {
        meta: {
          id: "security/https",
          name: "HTTPS",
          description: "Check HTTPS",
          category: "security",
          scope: "site",
          severity: "error",
          weight: 9,
        },
        checks: [
          { name: "https-enabled", status: "fail", message: "No HTTPS" },
        ],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result[0].name).toBe("Security");
  });

  test("preserves solution field in grouped rules", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Check meta title",
          solution: "Add a <title> tag to the <head>",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [{ name: "title-exists", status: "fail", message: "Missing" }],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result[0].rules[0].solution).toBe("Add a <title> tag to the <head>");
  });
});
