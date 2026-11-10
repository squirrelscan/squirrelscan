// `--resume` outcome in the JSON report (#1658): present only when resume was requested, with the
// reason code and message when a new crawl started instead.

import { describe, expect, test } from "bun:test";

import { renderJson } from "../src/output/json";
import type { AuditReport } from "../src/types";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

describe("renderJson resume outcome (#1658)", () => {
  test("a resume that did not happen carries requested, resumed, reason and message", () => {
    const parsed = JSON.parse(
      renderJson(
        report({
          resume: {
            requested: true,
            resumed: false,
            reason: "crawl-finished",
            message: "previous crawl c1 finished (analyzed), nothing left to resume",
          },
        })
      )
    );
    expect(parsed.meta.resume).toEqual({
      requested: true,
      resumed: false,
      reason: "crawl-finished",
      message: "previous crawl c1 finished (analyzed), nothing left to resume",
    });
  });

  test("a resume that happened has no reason", () => {
    const parsed = JSON.parse(renderJson(report({ resume: { requested: true, resumed: true } })));
    expect(parsed.meta.resume).toEqual({ requested: true, resumed: true });
  });

  test("a run that did not ask to resume has no resume field", () => {
    const parsed = JSON.parse(renderJson(report()));
    expect("resume" in parsed.meta).toBe(false);
  });
});
