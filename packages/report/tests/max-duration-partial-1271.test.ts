// A report cut short by `--max-duration` (#1271) is `partial` with reason code
// `max_duration`, in every format that carries a status.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

const REASON =
  "Stopped at the 60 s time limit (--max-duration): 12 discovered pages were not fetched";

const cut = { seconds: 60, unfetchedPages: 12, pagesNotEvaluated: 0, siteChecksCut: false };

function partialReport(withCut: boolean): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T00:00:00.000Z",
    totalPages: 8,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    healthScore: {
      overall: 90,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 1,
    },
    status: "partial",
    statusReason: REASON,
    ...(withCut ? { statusReasonCode: "max_duration" as const, maxDuration: cut } : {}),
  } as unknown as AuditReport;
}

describe("max_duration partial report", () => {
  test("JSON carries status, reason code and the counts", () => {
    const json = JSON.parse(renderJson(partialReport(true))) as Record<string, unknown>;
    expect(json.status).toBe("partial");
    expect(json.statusReason).toBe(REASON);
    expect(json.statusReasonCode).toBe("max_duration");
    expect(json.maxDuration).toEqual(cut);
  });

  test("JSON of an ordinary partial report gains neither field", () => {
    const json = JSON.parse(renderJson(partialReport(false))) as Record<string, unknown>;
    expect(json.statusReasonCode).toBeUndefined();
    expect(json.maxDuration).toBeUndefined();
  });

  test("text, markdown and llm say it is partial and why", () => {
    expect(renderText(partialReport(true))).toContain(REASON);
    expect(renderMarkdown(partialReport(true))).toContain("--max-duration");
    expect(renderLlm(partialReport(true))).toContain("--max-duration");
  });
});
