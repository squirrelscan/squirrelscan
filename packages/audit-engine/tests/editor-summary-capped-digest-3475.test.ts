// squirrelscan/repo#3475: the queued editor-summary task builds its digest from the
// STORED, capped report. The capper keeps at most `classesPerRule` issue classes
// per rule and counts the rest only in `checkTallies`, so a digest taken from the
// kept classes alone shrank the occurrences and could re-rank the top issues
// against the digest the container builds from its full report.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { buildEditorSummaryRequest } from "@squirrelscan/report/editor-summary";

import { capReportForPublish, type CappableReport } from "../src/publish-cap";

const SITE = "https://shop.example.test";
const PAGES = 700;

function ruleMeta(id: string, weight: number) {
  return {
    id,
    name: id,
    description: "d",
    solution: "s",
    category: "images",
    scope: "page" as const,
    severity: "error" as const,
    weight,
  };
}

/** `names` check names (one issue class each), each failing on `failing` of `pages` pages. */
function classes(names: number, failing: (k: number) => number, pages = 30): CheckResult[] {
  const checks: CheckResult[] = [];
  for (let k = 0; k < names; k++) {
    for (let p = 0; p < pages; p++) {
      checks.push({
        name: `check-${k}`,
        status: p < failing(k) ? "fail" : "pass",
        message: "m",
        pageUrl: `${SITE}/p/${p}`,
      } as CheckResult);
    }
  }
  return checks;
}

function deepChecks(): CheckResult[] {
  return Array.from({ length: PAGES }, (_, p) => ({
    name: "deep",
    status: "fail",
    message: "m",
    pageUrl: `${SITE}/p/${p}`,
  })) as CheckResult[];
}

function report(): CappableReport & Record<string, unknown> {
  return {
    baseUrl: `${SITE}/`,
    timestamp: "2026-10-11T00:00:00.000Z",
    totalPages: PAGES,
    passed: 0,
    warnings: 0,
    failed: 0,
    pages: Array.from({ length: PAGES }, (_, i) => ({ url: `${SITE}/p/${i}`, statusCode: 200 })),
    siteChecks: [],
    ruleResults: {
      // 40 classes: past `classesPerRule` (25), so 15 are counted but not kept.
      // True total 880.
      "images/wide": { meta: ruleMeta("images/wide", 6), checks: classes(40, (k) => 20 + (k % 5)) },
      // One class, 700 failures: below the wide rule's true total, above what
      // the capped wide rule keeps.
      "images/deep": { meta: ruleMeta("images/deep", 6), checks: deepChecks() },
    },
  } as unknown as CappableReport & Record<string, unknown>;
}

const occurrences = (r: unknown) =>
  Object.fromEntries(
    buildEditorSummaryRequest(r as never, { auditId: "a" }).topIssues.map((i) => [
      i.ruleId,
      i.occurrences,
    ]),
  );
const ranking = (r: unknown) =>
  buildEditorSummaryRequest(r as never, { auditId: "a" }).topIssues.map((i) => i.ruleId);

describe("editor summary digest from a capped report (#3475)", () => {
  test("occurrences and ranking match the digest of the same report uncapped", () => {
    const full = report();
    const capped = capReportForPublish(full) as unknown as Record<string, unknown>;
    expect((capped.detail as { capped: boolean }).capped).toBe(true);
    // The fixture really loses classes: without the tallies the wide rule shrinks.
    const kept = (capped.ruleResults as Record<string, { checks: unknown[] }>)["images/wide"]!
      .checks.length;
    expect(kept).toBeLessThan(40);

    expect(occurrences(capped)).toEqual(occurrences(full));
    expect(occurrences(full)).toEqual({ "images/wide": 880, "images/deep": 700 });
    expect(ranking(capped)).toEqual(ranking(full));
    expect(ranking(full)).toEqual(["images/wide", "images/deep"]);
  });

  test("an uncapped report's digest is unchanged", () => {
    const full = report();
    expect(occurrences(full)).toEqual({ "images/wide": 880, "images/deep": 700 });
  });
});
