// pub#2086: the "Exposed Sensitive Files" not-checked note named the probe flag twice (once in the
// rule's message, once in the skip-reason hint). The rule's message no longer carries it.

import { describe, expect, test } from "bun:test";

import { notCheckedLines } from "../src/not-checked";
import type { AuditReport } from "../src/types";

function report(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-20T10:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {
      "security/exposed-files": {
        meta: {
          id: "security/exposed-files",
          name: "Exposed Sensitive Files",
          description: "d",
          category: "security",
          scope: "site",
          severity: "error",
          weight: 5,
        },
        checks: [
          {
            name: "exposed-files-not-checked",
            status: "skipped",
            message:
              "Exposed sensitive files not checked: probing is passive, and this rule only probes at aggressive.",
            skipReason: "probe-level-too-low",
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

describe("probe-level not-checked note (pub#2086)", () => {
  test("names --probe aggressive exactly once", () => {
    const [line] = notCheckedLines(report());
    expect(line).toBeDefined();
    expect(line!.split("--probe aggressive").length - 1).toBe(1);
  });
});
