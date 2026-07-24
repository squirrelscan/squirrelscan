// Severity-first issue ordering + "Recommendation" label for info severity +
// per-group scores in the report summary (AX task #4):
//   1. groupIssuesByCategory sorts rules by effective severity first
//      (error → recommendation/info → warning), existing tiebreakers after.
//   2. Human renderers (text/markdown/html) label info severity "recommendation"
//      / "Recommendation"; machine renderers (llm/json/xml) keep raw "info".
//   3. text/markdown/html summaries surface all 4 group scores (incl. the
//      "ai" group, displayed as "Agents") without scrolling to category detail.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { groupIssuesByCategory } from "../src/grouping";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderLlm } from "../src/output/llm";
import { renderJson } from "../src/output/json";
import { renderXml } from "../src/output/xml";
import { renderHtml } from "../src/output/html";

function rule(
  id: string,
  category: string,
  severity: "error" | "warning" | "info",
  checks: ReportRuleResult["checks"],
  weight = 5
): ReportRuleResult {
  return {
    meta: { id, name: id, description: "", category, scope: "page", severity, weight },
    checks,
  };
}

const fail = (msg: string) => ({ name: "c", status: "fail" as const, message: msg });
const warn = (msg: string) => ({ name: "c", status: "warn" as const, message: msg });

describe("groupIssuesByCategory severity-first ordering (#4)", () => {
  test("error leads, then recommendation (info), then warning — equal weight/subcategory", () => {
    const results: Record<string, ReportRuleResult> = {
      "core/warn-rule": rule("core/warn-rule", "core", "warning", [warn("slow")]),
      "core/info-rule": rule("core/info-rule", "core", "info", [warn("could improve")]),
      "core/err-rule": rule("core/err-rule", "core", "error", [fail("broken")]),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped[0].rules.map((r) => r.id)).toEqual([
      "core/err-rule",
      "core/info-rule",
      "core/warn-rule",
    ]);
    expect(grouped[0].rules.map((r) => r.severity)).toEqual(["error", "info", "warning"]);
  });

  test("severity is the PRIMARY key — outranks weight", () => {
    const results: Record<string, ReportRuleResult> = {
      // Higher-weight warning must still sort after a lower-weight info rule.
      "core/heavy-warn": rule("core/heavy-warn", "core", "warning", [warn("x")], 20),
      "core/light-info": rule("core/light-info", "core", "info", [warn("y")], 1),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped[0].rules.map((r) => r.id)).toEqual(["core/light-info", "core/heavy-warn"]);
  });

  test("existing tiebreakers (subcategory, weight, id) still apply within a severity", () => {
    const failCheck = [fail("x")];
    const results: Record<string, ReportRuleResult> = {
      "core/bbb": rule("core/bbb", "core", "error", failCheck, 5),
      "core/aaa": rule("core/aaa", "core", "error", failCheck, 5),
      "core/zzz": rule("core/zzz", "core", "error", failCheck, 9),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped[0].rules.map((r) => r.id)).toEqual(["core/zzz", "core/aaa", "core/bbb"]);
  });
});

describe("groupIssuesByCategory categories are severity-ordered (#1017)", () => {
  test("a category with an error outranks a warning-only category, even at lower topic priority", () => {
    // "gaps" (priority 15) has an error; "content" (priority 80) has only a
    // warning. Severity must win over the topic-priority table.
    const results: Record<string, ReportRuleResult> = {
      "content/warn-rule": rule("content/warn-rule", "content", "warning", [warn("thin")]),
      "gaps/err-rule": rule("gaps/err-rule", "gaps", "error", [fail("missing")]),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped.map((c) => c.code)).toEqual(["gaps", "content"]);
  });

  test("a recommendation-only (info) category outranks a warning-only category", () => {
    // Matches the rule-level rank: error → recommendation/info → warning.
    const results: Record<string, ReportRuleResult> = {
      "content/warn-rule": rule("content/warn-rule", "content", "warning", [warn("thin")]),
      "gaps/info-rule": rule("gaps/info-rule", "gaps", "info", [warn("could improve")]),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped.map((c) => c.code)).toEqual(["gaps", "content"]);
  });

  test("categories tied on severity still fall back to the topic-priority table", () => {
    // Both categories have an error present; "core" (95) must still lead
    // "gaps" (15) since severity is tied.
    const results: Record<string, ReportRuleResult> = {
      "gaps/err-rule": rule("gaps/err-rule", "gaps", "error", [fail("missing")]),
      "core/err-rule": rule("core/err-rule", "core", "error", [fail("missing title")]),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped.map((c) => c.code)).toEqual(["core", "gaps"]);
  });
});

// A report carrying one rule per severity plus all 4 group scores, for the
// display-label and summary-group assertions below.
function reportAcrossSeverities(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-08T00:00:00.000Z",
    totalPages: 2,
    passed: 0,
    warnings: 2,
    failed: 1,
    ruleResults: {
      "core/err-rule": rule("core/err-rule", "core", "error", [fail("broken title")]),
      "core/info-rule": rule("core/info-rule", "core", "info", [warn("could add schema")]),
      "core/warn-rule": rule("core/warn-rule", "core", "warning", [warn("slow image")]),
    },
    healthScore: {
      overall: 60,
      categories: [],
      groups: [
        { group: "seo", name: "SEO", score: 55, passed: 0, warnings: 2, failed: 1, total: 3 },
        {
          group: "performance",
          name: "Performance",
          score: 80,
          passed: 1,
          warnings: 0,
          failed: 0,
          total: 1,
        },
        {
          group: "security",
          name: "Security",
          score: 90,
          passed: 1,
          warnings: 0,
          failed: 0,
          total: 1,
        },
        { group: "ai", name: "AI Readiness", score: 40, passed: 0, warnings: 1, failed: 0, total: 1 },
      ],
      errorCount: 1,
      warningCount: 2,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

describe("Recommendation label for info severity — human renderers only (#4)", () => {
  test("text: renders [recommendation] for info, [error]/[warning] unchanged", () => {
    const out = renderText(reportAcrossSeverities());
    expect(out).toContain("[recommendation] core/info-rule");
    expect(out).toContain("[error] core/err-rule");
    expect(out).toContain("[warning] core/warn-rule");
    expect(out).not.toContain("[info]");
  });

  test("markdown: renders *[Recommendation]* badge for info, ERROR/WARN badges unchanged", () => {
    const md = renderMarkdown(reportAcrossSeverities());
    expect(md).toContain("*[Recommendation]*");
    expect(md).toContain("**[ERROR]**");
    expect(md).toContain("**[WARN]**");
    expect(md).not.toContain("[INFO]");
  });

  test("llm: keeps the raw info severity attribute", () => {
    const out = renderLlm(reportAcrossSeverities());
    expect(out).toContain('severity="info"');
    expect(out).not.toContain("recommendation");
  });

  test("json: keeps the raw info severity value", () => {
    const parsed = JSON.parse(renderJson(reportAcrossSeverities()));
    const infoIssue = parsed.issues.find((i: { ruleId: string }) => i.ruleId === "core/info-rule");
    expect(infoIssue.severity).toBe("info");
    expect(JSON.stringify(parsed)).not.toContain("recommendation");
  });

  test("xml: keeps the raw info severity attribute", () => {
    const out = renderXml(reportAcrossSeverities());
    expect(out).toContain('severity="info"');
    expect(out).not.toContain("recommendation");
  });

  test("html: renders 'recommendation' text for info severity, class name stays raw", () => {
    const html = renderHtml(reportAcrossSeverities());
    // Visible text is the label; the className stays the raw severity so the
    // existing .rule-severity.info CSS color rule still applies.
    expect(html).toContain('class="rule-severity info">recommendation</span>');
    expect(html).toContain('class="rule-severity error">error</span>');
    expect(html).toContain('class="rule-severity warning">warning</span>');
    expect(html).not.toContain(">info</span>");
  });
});

describe("SUMMARY surfaces all 4 group scores incl. Agent Experience (#4, #626)", () => {
  test("text: SUMMARY block lists every group's score", () => {
    const out = renderText(reportAcrossSeverities());
    const summaryBlock = out.split("SUMMARY")[1].split("ISSUES")[0];
    expect(summaryBlock).toContain("SEO: 55/100");
    expect(summaryBlock).toContain("Performance: 80/100");
    expect(summaryBlock).toContain("Security: 90/100");
    // Name derives from the group CODE ("ai" → "Agents"), not the stored name.
    expect(summaryBlock).toContain("Agents: 40/100");
    expect(summaryBlock).not.toContain("AI Readiness");
  });

  test("markdown: Summary section lists every group's score", () => {
    const md = renderMarkdown(reportAcrossSeverities());
    const summaryBlock = md.split("## Summary")[1].split("## Issues")[0];
    expect(summaryBlock).toContain("**SEO:** 55/100");
    expect(summaryBlock).toContain("**Performance:** 80/100");
    expect(summaryBlock).toContain("**Security:** 90/100");
    expect(summaryBlock).toContain("**Agents:** 40/100");
    expect(summaryBlock).not.toContain("AI Readiness");
  });

  test("text: omits group lines entirely when healthScore has no groups (back-compat)", () => {
    const r = reportAcrossSeverities();
    delete (r.healthScore as { groups?: unknown }).groups;
    const out = renderText(r);
    const summaryBlock = out.split("SUMMARY")[1].split("ISSUES")[0];
    expect(summaryBlock).not.toContain("/100");
  });

  test("html: the group-scores summary already renders all 4 groups incl. Agent Experience", () => {
    const html = renderHtml(reportAcrossSeverities());
    expect(html).toContain('class="group-scores"');
    expect((html.match(/class="group-circle"/g) || []).length).toBe(4);
    // Short label from the group CODE ("ai" → "Agents"); full title on hover.
    expect(html).toContain(">Agents</div>");
    expect(html).toContain('title="Agent Experience"');
    expect(html).not.toContain("AI Readiness");
  });
});
