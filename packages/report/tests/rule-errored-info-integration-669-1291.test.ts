// Integration of #1291 (a rule that throws is a skipped check plus a `-errors` summary) with #669/#518
// (info checks and skippedChecks in the reports): the throwing rule is a `rule-errored` skip, and its
// `-errors` summary row is not an info check in either report.

import { describe, expect, test } from "bun:test";

import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import type { AuditReport } from "../src/types";

function row(url: string) {
  return {
    name: "test/probe-error",
    status: "skipped" as const,
    skipReason: "rule-timed-out",
    message: "Rule error: boom (rule not evaluated on this page)",
    details: { errored: true, ruleId: "test/probe", error: "boom" },
    pageUrl: url,
  };
}

const report = {
  baseUrl: "https://e.com",
  timestamp: "2026-10-30T00:00:00.000Z",
  totalPages: 4,
  passed: 0,
  warnings: 0,
  failed: 0,
  ruleResults: {
    "test/probe": {
      meta: { id: "test/probe", name: "Probe", description: "d", category: "core", scope: "page", severity: "error", weight: 3 },
      checks: [
        ...[1, 2, 3, 4].map((i) => row(`https://e.com/${i}`)),
        { name: "test/probe-errors", status: "info", message: "Rule error summary: boom", details: { errored: true, pagesNotChecked: 4, error: "boom" } },
      ],
    },
    "test/noted": {
      meta: { id: "test/noted", name: "Noted", description: "d", category: "core", scope: "page", severity: "warning", weight: 1 },
      checks: [{ name: "noted-check", status: "info", message: "a real note", pageUrl: "https://e.com/1" }],
    },
  },
} as unknown as AuditReport;

describe("a throwing rule across the info-check and skipped-check reports", () => {
  test("JSON lists it as a rule-errored skip and keeps its -errors summary out of infoChecks", () => {
    const json = JSON.parse(renderJson(report));
    const skipped = (json.skippedChecks ?? []).filter((c: { ruleId: string }) => c.ruleId === "test/probe");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((c: { reason: string }) => c.reason === "rule-errored")).toBe(true);
    const infoNames = (json.infoChecks ?? []).map((c: { check: string }) => c.check);
    expect(infoNames).toContain("noted-check");
    expect(infoNames.some((n: string) => n.endsWith("-errors"))).toBe(false);
    expect(json.issues).toEqual([]);
  });

  test("the LLM info-checks block omits the -errors summary", () => {
    const llm = renderLlm(report, { includeInfo: true } as never);
    expect(llm).toContain("noted-check");
    expect(llm).not.toContain("probe-errors");
    expect(llm).not.toContain("Rule error summary");
  });
});
