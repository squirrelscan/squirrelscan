// `coverage.openPages` (#1759, schema 1.19): how many known pages with open findings a smart audit
// re-verified and how many it left carried, and why. Said in the coverage line, the LLM report and
// the JSON report, and never from a figure that is not a count.

import { describe, expect, test } from "bun:test";

import { coverageLine, openPagesNote } from "../src/coverage";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import type { AuditReport } from "../src/types";

const report = (openPages?: unknown, carriedFindings = 0): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: 10,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    coverage: { auditedPages: 10, knownPages: 40, carriedFindings, ...(openPages ? { openPages } : {}) },
  }) as unknown as AuditReport;

describe("openPagesNote", () => {
  test("names the two kinds of carried page apart", () => {
    expect(openPagesNote({ reverified: 28, carried: 12, skippedByBudget: 9, noLongerLinked: 3 })).toBe(
      "28 pages with open findings re-verified, 12 left carried: 9 skipped by the page budget, 3 no longer linked",
    );
  });
  test("says nothing was left carried, and drops a split of zero", () => {
    expect(openPagesNote({ reverified: 1, carried: 0 })).toBe("1 page with open findings re-verified, none left carried");
  });
  test("counts only, no split, when the crawl's frontier was not known", () => {
    expect(openPagesNote({ reverified: 2, carried: 5 })).toBe("2 pages with open findings re-verified, 5 left carried");
  });
  test("a stored report's figures are read as counts or not at all", () => {
    expect(openPagesNote({ reverified: "7; DROP", carried: -3, skippedByBudget: 1.5 } as never)).toBeNull();
    expect(openPagesNote(undefined)).toBeNull();
  });
});

describe("where the counts are said", () => {
  test("the coverage line carries them", () => {
    expect(coverageLine(report({ reverified: 5, carried: 3, skippedByBudget: 2, noLongerLinked: 1 }, 3))).toBe(
      "Coverage: audited 10 of 40 known pages (3 findings carried forward; 5 pages with open findings re-verified, 3 left carried: 2 skipped by the page budget, 1 no longer linked).",
    );
  });
  test("a report without them reads as before", () => {
    expect(coverageLine(report(undefined, 3))).toBe("Coverage: audited 10 of 40 known pages (3 findings carried forward).");
  });
  test("the LLM report has attributes, only for counts above zero", () => {
    const out = renderLlm(report({ reverified: 5, carried: 3, skippedByBudget: 3 }, 3));
    expect(out).toContain('open-pages-reverified="5" open-pages-carried="3" open-pages-skipped-by-budget="3"/>');
    expect(out).not.toContain("no-longer-linked");
  });
  test("the JSON report copies the object and says schema 1.19", () => {
    const json = JSON.parse(renderJson(report({ reverified: 5, carried: 3, noLongerLinked: 3 }, 3))) as {
      meta: { schemaVersion: string; coverage: unknown };
    };
    expect(json.meta.schemaVersion).toBe("1.19");
    expect(json.meta.coverage).toMatchObject({ openPages: { reverified: 5, carried: 3, noLongerLinked: 3 } });
  });
});
