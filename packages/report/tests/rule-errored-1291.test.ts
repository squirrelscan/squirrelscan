// #1291: a rule that threw reads as a squirrelscan defect in the "Not checked" list, not as a timeout.

import { describe, expect, test } from "bun:test";

import { renderJson } from "../src/output/json";
import { notCheckedRules, timedOutMessage, timedOutRules } from "../src/not-checked";

const report = {
  ruleResults: {
    "test/probe": {
      meta: { id: "test/probe", name: "Probe", category: "core", severity: "error" },
      checks: [
        { name: "test/probe-error", status: "skipped", skipReason: "rule-timed-out", message: "Rule error: boom (rule not evaluated on this page)", details: { errored: true, error: "boom", pages: 3 } },
        { name: "test/probe-error", status: "skipped", skipReason: "rule-timed-out", message: "Rule error: same", details: { errored: true, pages: 3 } },
        { name: "test/probe-errors", status: "info", message: "m", details: { errored: true, pagesNotChecked: 5, error: "boom" } },
      ],
    },
  },
} as never;

describe("an errored rule in the report", () => {
  test("is listed once with its count and first error, and says it is not the page's fault", () => {
    const [rule] = timedOutRules(report);
    expect(rule).toMatchObject({ ruleId: "test/probe", pages: 5, errored: true, error: "boom" });
    expect(timedOutMessage(rule!)).toBe("Probe hit an internal squirrelscan error on 5 pages and was not evaluated (first error: boom)");
    const [item] = notCheckedRules(report);
    expect(item!.message).toContain("internal squirrelscan error");
    expect(item!.hint).toContain("not a problem with your pages");
    expect(item!.message).not.toContain("time budget");
  });

  test("the JSON report folds the per-page rows into one not-checked entry that lists the pages", () => {
    const row = (u: string) => ({ name: "test/probe-error", status: "skipped", skipReason: "rule-timed-out", message: "Rule error: boom (rule not evaluated on this page)", details: { errored: true, ruleId: "test/probe", error: "boom" }, pageUrl: u });
    const rep = {
      baseUrl: "https://e.com",
      timestamp: "2026-10-30T00:00:00.000Z",
      totalPages: 12,
      passed: 0,
      warnings: 0,
      failed: 0,
      ruleResults: {
        "test/probe": {
          meta: { id: "test/probe", name: "Probe", description: "d", category: "core", scope: "page", severity: "error", weight: 3 },
          checks: [...Array.from({ length: 12 }, (_, i) => row(`https://e.com/${i}`)), { name: "test/probe-errors", status: "info", message: "m", details: { errored: true, pagesNotChecked: 12, error: "boom" } }],
        },
      },
    } as never;
    const json = JSON.parse(renderJson(rep));
    expect(json.issues).toEqual([]); // not a failure
    expect(json.notChecked).toHaveLength(1);
    expect(json.notChecked[0].pages).toHaveLength(10);
    expect(json.notChecked[0].message).toContain("12 pages");
  });
});
