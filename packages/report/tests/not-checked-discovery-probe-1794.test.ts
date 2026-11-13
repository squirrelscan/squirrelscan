// #1794: a rule whose discovery probe was not approved, not sent or refused is listed under `notChecked`
// with outcome `coverage_gap` and its reason code, in the JSON report, even when the rule is info severity.

import { describe, expect, test } from "bun:test";

import { DISCOVERY_PROBE_SKIP_REASONS } from "@squirrelscan/core-contracts";

import { notCheckedRules } from "../src/not-checked";
import { renderJson } from "../src/output/json";
import type { AuditReport } from "../src/types";

function report(severity: "info" | "warning", skipReason: string): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-13T10:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {
      "ax/agents-md": {
        meta: {
          id: "ax/agents-md",
          name: "AGENTS.md",
          description: "AGENTS.md",
          category: "ax",
          scope: "site",
          severity,
          weight: 1,
        },
        checks: [
          {
            name: "agents-md-present",
            status: "skipped",
            message: "AGENTS.md not checked: path not approved ([crawler] discovery_probe_paths)",
            value: "not-checked",
            skipReason,
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

describe("discovery probe not-checked reasons", () => {
  for (const reason of DISCOVERY_PROBE_SKIP_REASONS) {
    test(`${reason} on an info rule is a not-checked coverage gap with its own hint`, () => {
      const [rule] = notCheckedRules(report("info", reason));
      expect(rule).toMatchObject({ ruleId: "ax/agents-md", reason, outcome: "coverage_gap" });
      expect(rule?.hint.length).toBeGreaterThan(20);
      const json = JSON.parse(renderJson(report("info", reason))) as {
        notChecked?: Array<{ ruleId: string; reason: string; outcome: string }>;
      };
      expect(json.notChecked).toEqual([
        expect.objectContaining({ ruleId: "ax/agents-md", reason, outcome: "coverage_gap" }),
      ]);
    });
  }

  test("another not-checked reason on an info rule is still left out", () => {
    expect(notCheckedRules(report("info", "external-links-not-checked"))).toEqual([]);
  });

  test("a warning-severity rule is listed as before", () => {
    expect(notCheckedRules(report("warning", "discovery-probe-refused"))).toHaveLength(1);
  });
});
