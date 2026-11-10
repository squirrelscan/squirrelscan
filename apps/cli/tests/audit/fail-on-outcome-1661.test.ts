// `--fail-on` tells a rule that threw from one that ran out of time (#1661): both stop a gate on warnings
// from passing quietly over a check that did not run, but the note names which it was.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import {
  evaluateFailOn,
  parseFailOn,
  timedOutSecurityRules,
} from "../../src/audit/fail-on";

function skippedRow(
  id: string,
  category: string,
  details: Record<string, unknown>
) {
  return {
    meta: {
      id,
      name: id,
      description: id,
      category,
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    checks: [
      {
        name: `${id}-error`,
        status: "skipped",
        message: "",
        skipReason: "rule-timed-out",
        pageUrl: "https://example.com/a",
        details: { pages: 1, ...details },
      },
    ],
  };
}

function report(ruleResults: Record<string, unknown>): AuditReport {
  return {
    failed: 0,
    warnings: 0,
    healthScore: { overall: 90, errorCount: 0, warningCount: 0 },
    ruleResults,
  } as unknown as AuditReport;
}

const gate = (r: AuditReport) =>
  evaluateFailOn(parseFailOn(["warnings>0"]).conditions, r);

describe("--fail-on over a rule that did not run", () => {
  test("a security rule that timed out and a rule that threw are listed apart and trip the gate", () => {
    const r = report({
      "security/slow": skippedRow("security/slow", "security", {}),
      "core/broken": skippedRow("core/broken", "core", { errored: true }),
    });
    const rules = timedOutSecurityRules(r);
    expect(rules.map((x) => [x.ruleId, x.errored === true])).toEqual([
      ["security/slow", false],
      ["core/broken", true],
    ]);
    const ev = gate(r);
    expect(ev.trips.length).toBeGreaterThan(0);
    expect(ev.notes.some((n) => n.startsWith("security/slow timed out "))).toBe(
      true
    );
    expect(
      ev.notes.some((n) =>
        n.startsWith("core/broken failed with an internal error ")
      )
    ).toBe(true);
  });

  test("a rule outside security that merely timed out does not count", () => {
    const r = report({ "core/slow": skippedRow("core/slow", "core", {}) });
    expect(timedOutSecurityRules(r)).toEqual([]);
    expect(gate(r).trips).toEqual([]);
  });
});
