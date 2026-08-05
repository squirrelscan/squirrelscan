// #1536 — issues are ordered by SEVERITY across the whole report, not within
// each category. Before this, severity was the innermost sort key, so a
// renderer concatenating categories interleaved them: crawl's errors AND
// warnings both landed above a11y's errors.

import { describe, expect, test } from "bun:test";
import type { AuditReport, ReportRuleResult } from "../src/types";

import { groupIssuesByCategory, flattenIssuesBySeverity } from "../src/grouping";
import { renderJson } from "../src/output/json";
import { renderText } from "../src/output/text";
import { renderHtml } from "../src/output/html";
import { renderMarkdown } from "../src/output/markdown";
import { renderXml } from "../src/output/xml";
import { renderLlm } from "../src/output/llm";

function rule(
  id: string,
  category: string,
  severity: "error" | "warning" | "info",
  checks: ReportRuleResult["checks"],
): ReportRuleResult {
  return {
    meta: { id, name: id, description: "", category, scope: "page", severity, weight: 5 },
    checks,
  };
}

const fail = (msg: string) => ({ name: "c", status: "fail" as const, message: msg });
const warn = (msg: string) => ({ name: "c", status: "warn" as const, message: msg });

// Two categories that each carry an error AND a warning — the exact shape that
// interleaved before #1536. `perf/warn` also fails a meta-severity "error" rule
// with a warn-only check, i.e. an effective warning.
function mixedSeverities(): Record<string, ReportRuleResult> {
  return {
    "core/err": rule("core/err", "core", "error", [fail("no title")]),
    "core/warn": rule("core/warn", "core", "warning", [warn("short title")]),
    "core/rec": rule("core/rec", "core", "info", [warn("consider a subtitle")]),
    "perf/err": rule("perf/err", "perf", "error", [fail("slow LCP")]),
    "perf/warn": rule("perf/warn", "perf", "error", [warn("chunky bundle")]),
  };
}

function report(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2024-01-15T10:30:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 3,
    failed: 2,
    ruleResults: mixedSeverities(),
  } as unknown as AuditReport;
}

describe("flattenIssuesBySeverity (#1536)", () => {
  test("orders every issue by severity first, across categories", () => {
    const flat = flattenIssuesBySeverity(groupIssuesByCategory(mixedSeverities()));
    expect(flat.map((r) => r.severity)).toEqual([
      "error",
      "error",
      "info",
      "warning",
      "warning",
    ]);
  });

  test("groups a severity's issues by category rather than interleaving them", () => {
    const flat = flattenIssuesBySeverity(groupIssuesByCategory(mixedSeverities()));
    const errors = flat.filter((r) => r.severity === "error");
    expect(errors.map((r) => r.id)).toEqual(["core/err", "perf/err"]);
    // Category context survives the flattening — renderers label each rule with it.
    expect(errors[0].categoryName).toBe("Core SEO");
    expect(errors[0].group).toBe("seo");
  });

  test("a meta-severity error whose checks only warned sorts as a warning", () => {
    const flat = flattenIssuesBySeverity(groupIssuesByCategory(mixedSeverities()));
    const perfWarn = flat.find((r) => r.id === "perf/warn");
    expect(perfWarn?.severity).toBe("warning");
    expect(flat.indexOf(perfWarn!)).toBeGreaterThan(
      flat.findIndex((r) => r.severity === "info"),
    );
  });
});

// Every renderer emits the SAME order. Asserted by index-of comparison rather
// than an exact snapshot so the tests survive copy changes.
describe("renderers emit one global severity order (#1536)", () => {
  const cases: Array<[string, (r: AuditReport) => string]> = [
    ["json", (r) => renderJson(r)],
    ["text", (r) => renderText(r)],
    ["html", (r) => renderHtml(r)],
    ["markdown", (r) => renderMarkdown(r)],
    ["xml", (r) => renderXml(r)],
    ["llm", (r) => renderLlm(r)],
  ];

  for (const [name, render] of cases) {
    test(`${name}: both errors precede the recommendation, which precedes both warnings`, () => {
      const out = render(report());
      const at = (id: string) => out.indexOf(id);
      expect(at("core/err")).toBeGreaterThanOrEqual(0);
      expect(at("perf/err")).toBeLessThan(at("core/rec"));
      expect(at("core/err")).toBeLessThan(at("core/rec"));
      expect(at("core/rec")).toBeLessThan(at("core/warn"));
      expect(at("core/rec")).toBeLessThan(at("perf/warn"));
    });
  }
});
