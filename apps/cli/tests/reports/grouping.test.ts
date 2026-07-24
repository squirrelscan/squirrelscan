import { describe, expect, test } from "bun:test";

import type { ReportRuleResult } from "../../src/types";

import { groupIssuesByCategory } from "../../src/reports/grouping";

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
    expect(result[0].failCount).toBe(2);
    expect(result[0].warnCount).toBe(0);
    expect(result[0].rules.length).toBe(1);
    expect(result[0].rules[0].checks.length).toBe(1);
    expect(result[0].rules[0].checks[0].count).toBe(2);
  });

  test("sorts categories by priority", () => {
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
    expect(result[0].code).toBe("core");
    expect(result[1].code).toBe("security");
  });

  test("merges checks with same name+status into single entry with items", () => {
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
    expect(checks[0].items?.map((i) => i.id)).toEqual(["/page-a", "/page-b"]);
  });

  test("buckets invalid category codes under Other", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "other/rule": {
        meta: {
          id: "other/rule",
          name: "Other Rule",
          description: "Rule in other category",
          category: "other",
          scope: "page",
          severity: "error",
          weight: 5,
        },
        checks: [{ name: "check", status: "fail", message: "Fail" }],
      },
    };

    const result = groupIssuesByCategory(ruleResults);
    expect(result.length).toBe(1);
    expect(result[0].code).toBe("other");
    expect(result[0].name).toBe("Other");
  });
});
