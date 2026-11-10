// `outcome` on the JSON report's skipped and not-checked entries (#1661): an agent reads the typed
// outcome instead of parsing the reason string, and a rule that threw is told apart from one that ran
// out of time.

import { describe, expect, test } from "bun:test";

import { renderJson } from "../src/output/json";
import { parseSkippedChecks, restoreSkippedChecks } from "../src/skipped";
import type { AuditReport, ReportRuleResult } from "../src/types";

function report(ruleResults: Record<string, ReportRuleResult>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults,
  };
}

function rule(id: string, checks: ReportRuleResult["checks"], category = "security"): ReportRuleResult {
  return {
    meta: { id, name: id, description: id, category, scope: "page", severity: "warning", weight: 1 },
    checks,
  };
}

const skip = (name: string, skipReason: string, details?: Record<string, unknown>, pageUrl = "https://example.com/a") =>
  ({ name, status: "skipped" as const, message: "", skipReason, pageUrl, ...(details ? { details } : {}) });

describe("outcome in skippedChecks", () => {
  test("a timed-out rule, a rule that threw and a scan cut each carry their own outcome", () => {
    const parsed = JSON.parse(
      renderJson(
        report({
          "security/slow": rule("security/slow", [skip("security/slow-error", "rule-timed-out", { pages: 2 })]),
          "security/broken": rule("security/broken", [skip("security/broken-error", "rule-timed-out", { errored: true, pages: 1 })]),
          "content/long": rule("content/long", [skip("hidden-text", "scan-truncated")], "content"),
        }),
      ),
    );
    const byRule = Object.fromEntries(
      (parsed.skippedChecks as Array<{ ruleId: string; reason: string; outcome: string }>).map((s) => [s.ruleId, [s.reason, s.outcome]]),
    );
    expect(byRule).toEqual({
      "security/slow": ["rule-timed-out", "timed_out"],
      "security/broken": ["rule-errored", "errored"],
      "content/long": ["scan-truncated", "coverage_gap"],
    });
  });

  test("the existing fields are unchanged", () => {
    const parsed = JSON.parse(
      renderJson(report({ "content/long": rule("content/long", [skip("hidden-text", "scan-truncated")], "content") })),
    );
    expect(parsed.skippedChecks[0]).toEqual({
      ruleId: "content/long",
      name: "content/long",
      check: "hidden-text",
      reason: "scan-truncated",
      outcome: "coverage_gap",
      pages: ["https://example.com/a"],
      pagesCount: 1,
      pagesHasMore: false,
    });
  });
});

describe("outcome in notChecked", () => {
  test("a timed-out rule is timed_out and a rule that threw is errored", () => {
    const parsed = JSON.parse(
      renderJson(
        report({
          "security/slow": rule("security/slow", [skip("security/slow-error", "rule-timed-out", { pages: 2 })]),
          "security/broken": rule("security/broken", [skip("security/broken-error", "rule-timed-out", { errored: true, pages: 1 })]),
        }),
      ),
    );
    const byRule = Object.fromEntries(
      (parsed.notChecked as Array<{ ruleId: string; outcome: string }>).map((r) => [r.ruleId, r.outcome]),
    );
    expect(byRule).toEqual({ "security/slow": "timed_out", "security/broken": "errored" });
  });

  test("a rule-wide coded not-checked reason is a coverage_gap", () => {
    const parsed = JSON.parse(
      renderJson(
        report({
          "security/tls-certificate": rule(
            "security/tls-certificate",
            [{ name: "tls", status: "skipped", message: "no handshake", skipReason: "tls-certificate-not-checked" }],
          ),
        }),
      ),
    );
    expect(parsed.notChecked[0].outcome).toBe("coverage_gap");
  });
});

describe("a saved report read back", () => {
  test("outcome is derived from the reason, not trusted from the file", () => {
    const entries = parseSkippedChecks([
      { ruleId: "security/slow", name: "slow", check: "x", reason: "rule-timed-out", outcome: "ran", pages: [], pagesCount: 0 },
      { ruleId: "security/broken", name: "broken", check: "x", reason: "rule-errored", pages: [], pagesCount: 0 },
    ]);
    expect(entries.map((e) => e.outcome)).toEqual(["timed_out", "errored"]);
  });

  test("an errored entry restores as the rule-timed-out skip with details.errored, which classifies as errored", () => {
    const results: Record<string, ReportRuleResult> = {};
    restoreSkippedChecks(
      results,
      parseSkippedChecks([{ ruleId: "security/broken", name: "broken", check: "x", reason: "rule-errored", pages: ["https://example.com/a"], pagesCount: 1 }]),
      (id, name) => ({ id, name, description: name, category: "security", scope: "page", severity: "warning", weight: 1 }),
    );
    const parsed = JSON.parse(renderJson(report(results)));
    expect(parsed.skippedChecks[0].outcome).toBe("errored");
  });
});
