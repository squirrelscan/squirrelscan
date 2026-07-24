// Test that grouping by message works correctly for various rule patterns

import { describe, expect, test } from "bun:test";

import type { ReportRuleResult } from "@/types";

import { groupIssuesByCategory } from "@/reports/grouping";

describe("groupIssuesByCategory with message-based grouping", () => {
  test("groups identical messages together", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Test",
          solution: "Test",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 8,
        },
        checks: [
          {
            name: "meta-title",
            status: "warn",
            message: "Title too short (22 chars, min 30)",
            pageUrl: "https://example.com/page1",
            value: null,
          },
          {
            name: "meta-title",
            status: "warn",
            message: "Title too short (22 chars, min 30)",
            pageUrl: "https://example.com/page2",
            value: null,
          },
          {
            name: "meta-title",
            status: "warn",
            message: "Title too short (22 chars, min 30)",
            pageUrl: "https://example.com/page3",
            value: null,
          },
        ],
      },
    };

    const grouped = groupIssuesByCategory(ruleResults);

    expect(grouped.length).toBe(1);
    expect(grouped[0].rules.length).toBe(1);
    expect(grouped[0].rules[0].checks.length).toBe(1);
    expect(grouped[0].rules[0].checks[0].message).toBe(
      "Title too short (22 chars, min 30)"
    );
    expect(grouped[0].rules[0].checks[0].count).toBe(3);
    expect(grouped[0].rules[0].checks[0].pages.length).toBe(3);
  });

  test("separates semantically different messages (short vs long)", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Test",
          solution: "Test",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 8,
        },
        checks: [
          {
            name: "meta-title",
            status: "warn",
            message: "Title too short (22 chars, min 30)",
            pageUrl: "https://example.com/page1",
            value: null,
          },
          {
            name: "meta-title",
            status: "warn",
            message: "Title too long (65 chars, max 60)",
            pageUrl: "https://example.com/page2",
            value: null,
          },
          {
            name: "meta-title",
            status: "warn",
            message: "Title too long (114 chars, max 60)",
            pageUrl: "https://example.com/page3",
            value: null,
          },
        ],
      },
    };

    const grouped = groupIssuesByCategory(ruleResults);

    expect(grouped.length).toBe(1);
    expect(grouped[0].rules.length).toBe(1);
    // "too short" and "too long" are semantically different → 2 groups
    // "too long (65)" and "too long (114)" merge → 1 group with generic message
    expect(grouped[0].rules[0].checks.length).toBe(2);

    const checks = grouped[0].rules[0].checks.sort((a, b) =>
      a.message.localeCompare(b.message)
    );
    expect(checks[0].message).toBe("Title too long (N chars, max N)");
    expect(checks[0].count).toBe(2);
    expect(checks[0].pages.length).toBe(2);
    expect(checks[1].message).toBe("Title too short (22 chars, min 30)");
    expect(checks[1].count).toBe(1);
  });

  test("merges different counts in same rule into one group", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "images/alt-text": {
        meta: {
          id: "images/alt-text",
          name: "Image Alt Text",
          description: "Test",
          solution: "Test",
          category: "images",
          scope: "page",
          severity: "warning",
          weight: 5,
        },
        checks: [
          {
            name: "alt-text-missing",
            status: "fail",
            message: "1 image(s) missing alt attribute",
            pageUrl: "https://example.com/page1",
            value: null,
          },
          {
            name: "alt-text-missing",
            status: "fail",
            message: "3 image(s) missing alt attribute",
            pageUrl: "https://example.com/page2",
            value: null,
          },
          {
            name: "alt-text-missing",
            status: "fail",
            message: "3 image(s) missing alt attribute",
            pageUrl: "https://example.com/page3",
            value: null,
          },
          {
            name: "alt-text-missing",
            status: "fail",
            message: "5 image(s) missing alt attribute",
            pageUrl: "https://example.com/page4",
            value: null,
          },
        ],
      },
    };

    const grouped = groupIssuesByCategory(ruleResults);

    expect(grouped.length).toBe(1);
    expect(grouped[0].rules.length).toBe(1);
    // All checks merge into 1 group (numbers normalized away)
    expect(grouped[0].rules[0].checks.length).toBe(1);

    const check = grouped[0].rules[0].checks[0];
    expect(check.message).toBe("N image(s) missing alt attribute");
    expect(check.count).toBe(4);
    expect(check.pages.length).toBe(4);
    // Auto-generated items from per-page messages (no explicit items)
    expect(check.items?.length).toBe(4);
    expect(check.items?.[0].label).toBe("1 image(s) missing alt attribute");
  });

  test("merges items correctly within same message group", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "adblock/element-hiding": {
        meta: {
          id: "adblock/element-hiding",
          name: "Element Hiding",
          description: "Test",
          solution: "Test",
          category: "blocking",
          scope: "page",
          severity: "warning",
          weight: 3,
        },
        checks: [
          {
            name: "adblock-elements",
            status: "warn",
            message: "2 element(s) match adblock filter rules",
            pageUrl: "https://example.com/page1",
            items: [
              { id: "elem1", label: "Element 1" },
              { id: "elem2", label: "Element 2" },
            ],
          },
          {
            name: "adblock-elements",
            status: "warn",
            message: "2 element(s) match adblock filter rules",
            pageUrl: "https://example.com/page2",
            items: [
              { id: "elem2", label: "Element 2" }, // Duplicate should be deduped
              { id: "elem3", label: "Element 3" },
            ],
          },
        ],
      },
    };

    const grouped = groupIssuesByCategory(ruleResults);

    expect(grouped[0].rules[0].checks.length).toBe(1);
    expect(grouped[0].rules[0].checks[0].count).toBe(2);
    expect(grouped[0].rules[0].checks[0].pages.length).toBe(2);
    // 3 explicit items: elem1, elem2, elem3 (no auto-items since check has explicit items)
    expect(grouped[0].rules[0].checks[0].items?.length).toBe(3);
  });

  test("keeps pass and info statuses separate from warn/fail", () => {
    const ruleResults: Record<string, ReportRuleResult> = {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Test",
          solution: "Test",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 8,
        },
        checks: [
          {
            name: "meta-title",
            status: "pass",
            message: "Title length OK (45 chars)",
            pageUrl: "https://example.com/page1",
            value: null,
          },
          {
            name: "meta-title",
            status: "warn",
            message: "Title too short (22 chars, min 30)",
            pageUrl: "https://example.com/page2",
            value: null,
          },
        ],
      },
    };

    const grouped = groupIssuesByCategory(ruleResults);

    // Only warns/fails are included in grouped output
    expect(grouped.length).toBe(1);
    expect(grouped[0].rules[0].checks.length).toBe(1);
    expect(grouped[0].rules[0].checks[0].status).toBe("warn");
  });
});
