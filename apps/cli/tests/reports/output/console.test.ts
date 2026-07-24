// Tests for the console (default) report renderer (#1017): the 4 top-level
// group scores + severity-first category ordering, matching text.ts/markdown.ts.

import { describe, expect, test, spyOn } from "bun:test";

import type { AuditReport, ReportRuleResult, RuleCategory } from "@/types";

import {
  generateConsoleReport,
  type ConsoleReportOptions,
} from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");

function capture(report: AuditReport, opts?: ConsoleReportOptions): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report, opts);
  } finally {
    spy.mockRestore();
  }
  return strip(lines.join("\n"));
}

function rule(
  id: string,
  category: RuleCategory,
  severity: "error" | "warning" | "info",
  checks: ReportRuleResult["checks"]
): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "",
      category,
      scope: "page",
      severity,
      weight: 5,
    },
    checks,
  };
}

const fail = (msg: string) => ({
  name: "c",
  status: "fail" as const,
  message: msg,
});
const warn = (msg: string) => ({
  name: "c",
  status: "warn" as const,
  message: msg,
});

describe("generateConsoleReport", () => {
  test("omits Group Breakdown when healthScore has no groups (back-compat)", () => {
    const out = capture(createMinimalReport());
    expect(out).not.toContain("Group Breakdown:");
  });

  test("renders the 4 top-level group scores as a Group Breakdown (#1017)", () => {
    const report = createMinimalReport();
    report.healthScore!.groups = [
      {
        group: "seo",
        name: "SEO",
        score: 70,
        passed: 5,
        warnings: 2,
        failed: 1,
        total: 8,
      },
      {
        group: "performance",
        name: "Performance",
        score: 90,
        passed: 3,
        warnings: 0,
        failed: 0,
        total: 3,
      },
      {
        group: "security",
        name: "Security",
        score: 100,
        passed: 2,
        warnings: 0,
        failed: 0,
        total: 2,
      },
      // Stale stored name ("AI Readiness") — display must derive from the
      // group code, not the stored name, so renames apply retroactively.
      {
        group: "ai",
        name: "AI Readiness",
        score: 40,
        passed: 0,
        warnings: 1,
        failed: 0,
        total: 1,
      },
    ];

    const out = capture(report);
    expect(out).toContain("Group Breakdown:");
    expect(out).toContain("SEO");
    expect(out).toContain("Performance");
    expect(out).toContain("Security");
    expect(out).toContain("Agents");
    expect(out).not.toContain("AI Readiness");

    // Group Breakdown precedes the finer Category Breakdown (matches
    // text.ts/markdown.ts ordering).
    const groupIdx = out.indexOf("Group Breakdown:");
    const categoryIdx = out.indexOf("Category Breakdown:");
    expect(groupIdx).toBeGreaterThan(-1);
    expect(categoryIdx).toBeGreaterThan(groupIdx);
  });

  test("ISSUES section orders categories by severity, matching cloud ordering (#1017)", () => {
    const report = createMinimalReport();
    // "content" (topic priority 80) has only a warning; "gaps" (priority 15)
    // has an error. Severity must win over the topic-priority table.
    report.ruleResults = {
      "content/warn-rule": rule("content/warn-rule", "content", "warning", [
        warn("thin content"),
      ]),
      "gaps/err-rule": rule("gaps/err-rule", "gaps", "error", [
        fail("missing keyword coverage"),
      ]),
    };

    const out = capture(report);
    // Match the box-header prefix so "Content" doesn't false-match inside
    // "Keyword & Content Gaps" (gaps' display name contains "Content").
    const gapsIdx = out.indexOf("┌ Keyword & Content Gaps");
    const contentIdx = out.indexOf("┌ Content");
    expect(gapsIdx).toBeGreaterThan(-1);
    expect(contentIdx).toBeGreaterThan(-1);
    expect(gapsIdx).toBeLessThan(contentIdx);
  });

  // #1067
  describe("summaryOnly", () => {
    function reportWithIssues(): AuditReport {
      const report = createMinimalReport();
      report.ruleResults = {
        "content/warn-rule": rule("content/warn-rule", "content", "warning", [
          warn("thin content"),
        ]),
        "gaps/err-rule": rule("gaps/err-rule", "gaps", "error", [
          fail("missing keyword coverage"),
        ]),
      };
      return report;
    }

    test("keeps header, score, category counts, and footer", () => {
      const out = capture(reportWithIssues(), { summaryOnly: true });
      expect(out).toContain("SQUIRRELSCAN REPORT");
      expect(out).toContain("Health Score:");
      expect(out).toContain("ISSUES");
      expect(out).toContain("passed");
    });

    test("drops per-rule detail and affected-page lists", () => {
      const out = capture(reportWithIssues(), { summaryOnly: true });
      expect(out).not.toContain("content/warn-rule");
      expect(out).not.toContain("gaps/err-rule");
      expect(out).not.toContain("thin content");
      expect(out).not.toContain("missing keyword coverage");
    });

    test("full (non-summary) report still includes per-rule detail", () => {
      const out = capture(reportWithIssues());
      expect(out).toContain("thin content");
      expect(out).toContain("missing keyword coverage");
    });

    test("category box open/close stays balanced under --summary (no dangling border)", () => {
      const out = capture(reportWithIssues(), { summaryOnly: true });
      const headers = (out.match(/┌/g) ?? []).length;
      const footers = (out.match(/└/g) ?? []).length;
      expect(headers).toBeGreaterThan(0);
      expect(headers).toBe(footers);
    });
  });

  // #1066
  describe("partial audit line (rule filter)", () => {
    test("no ruleFilter → no partial-audit line", () => {
      const out = capture(createMinimalReport());
      expect(out).not.toContain("partial audit");
    });

    test("empty enable/disable → no partial-audit line", () => {
      const out = capture(createMinimalReport(), {
        ruleFilter: { enable: [], disable: [] },
      });
      expect(out).not.toContain("partial audit");
    });

    test("--rule-include shows included categories and N of M scored", () => {
      const report = createMinimalReport();
      report.healthScore!.categories = [
        {
          category: "ax",
          name: "Agent Experience",
          score: 90,
          passed: 3,
          warnings: 0,
          failed: 0,
          total: 3,
        },
      ];
      const out = capture(report, {
        ruleFilter: { enable: ["ax/*", "perf/*"], disable: [] },
      });
      expect(out).toContain("partial audit: included ax, perf");
      expect(out).toMatch(/scored on 1 of \d+ categories/);
    });

    test("--rule-exclude shows excluded categories, no scored-count (categories can be absent for reasons other than the filter)", () => {
      const out = capture(createMinimalReport(), {
        ruleFilter: { enable: [], disable: ["images/*", "social/*"] },
      });
      expect(out).toContain("partial audit: excluded images, social");
      expect(out).not.toContain("scored on");
    });

    test("both flags set → include and exclude sides both shown", () => {
      const out = capture(createMinimalReport(), {
        ruleFilter: { enable: ["ax/*", "perf/*"], disable: ["perf/some-rule"] },
      });
      expect(out).toContain(
        "partial audit: included ax, perf; excluded perf/some-rule"
      );
    });
  });
});
