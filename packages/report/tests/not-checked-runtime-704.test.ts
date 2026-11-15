// #704: reliability/js-errors on pages the cloud render recorded no runtime data for is listed as
// "Not checked" with its reason and a hint, never left out so the rule reads as clean.

import { describe, expect, test } from "bun:test";

import { RUNTIME_NOT_RECORDED_SKIP_REASON } from "@squirrelscan/core-contracts";

import { notCheckedLines, notCheckedRules } from "../src/not-checked";
import { renderJson } from "../src/output/json";
import type { AuditReport } from "../src/types";

const MESSAGE = "Partial check: 3 page(s) had no runtime data from the renderer";

function report(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-20T10:00:00.000Z",
    totalPages: 4,
    passed: 0,
    warnings: 0,
    failed: 1,
    ruleResults: {
      "reliability/js-errors": {
        meta: {
          id: "reliability/js-errors",
          name: "JavaScript Errors and Failed Runtime Requests",
          description: "js-errors description",
          category: "reliability",
          scope: "site",
          severity: "error",
          weight: 6,
        },
        checks: [
          {
            name: "js-errors",
            status: "fail",
            message: "1 uncaught JavaScript error(s) thrown from first-party scripts",
          },
          {
            name: "unchecked-pages",
            status: "skipped",
            message: MESSAGE,
            skipReason: RUNTIME_NOT_RECORDED_SKIP_REASON,
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

describe("reliability/js-errors pages without runtime data (#704)", () => {
  test("they are collected as not checked with the reason, message and a hint", () => {
    const [rule] = notCheckedRules(report());
    expect(rule).toMatchObject({
      ruleId: "reliability/js-errors",
      check: "unchecked-pages",
      reason: RUNTIME_NOT_RECORDED_SKIP_REASON,
      outcome: "coverage_gap",
      message: MESSAGE,
    });
    expect(rule?.hint).toContain("no runtime data");
    expect(notCheckedLines(report())[0]).toStartWith(
      "Not checked: JavaScript Errors and Failed Runtime Requests.",
    );
  });

  test("the JSON report lists them under notChecked", () => {
    const json = JSON.parse(renderJson(report() as never) as string) as {
      notChecked?: Array<{ ruleId: string; reason: string }>;
    };
    expect(json.notChecked).toEqual([
      expect.objectContaining({
        ruleId: "reliability/js-errors",
        reason: RUNTIME_NOT_RECORDED_SKIP_REASON,
      }),
    ]);
  });
});
