// #669: info-status checks are listed in the JSON report (`infoChecks`) and the
// LLM report (`<info-checks>`), never in `issues`, and never change the score.
// #518: a rule that ran past its time budget is listed in `skippedChecks` with
// reason `rule-timed-out`.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";

function baseReport(ruleResults: Record<string, ReportRuleResult>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T00:00:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 1,
    failed: 2,
    ruleResults,
  };
}

function rule(id: string, name: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: { id, name, description: `${name} description`, category: "crawlability", scope: "site", severity: "warning", weight: 1 },
    checks,
  };
}

const INFO_RULE = rule("crawl/robots-meta-conflict", "Robots conflicts", [
  {
    name: "redundant-noindex",
    status: "info",
    message: "2 page(s) blocked in robots.txt also have noindex",
    pages: ["https://example.com/b", "https://example.com/a"],
  },
  { name: "robots-conflict", status: "pass", message: "No robots meta/robots.txt conflicts detected" },
]);

describe("info checks in the JSON report (#669)", () => {
  const withInfo = baseReport({ "crawl/robots-meta-conflict": INFO_RULE });
  const parsed = JSON.parse(renderJson(withInfo)) as {
    infoChecks?: Array<Record<string, unknown>>;
    issues: Array<{ ruleId: string }>;
    score: unknown;
  };

  test("an info check is listed with its rule, check name, message and sorted pages", () => {
    expect(parsed.infoChecks).toEqual([
      {
        ruleId: "crawl/robots-meta-conflict",
        name: "Robots conflicts",
        check: "redundant-noindex",
        message: "2 page(s) blocked in robots.txt also have noindex",
        pages: ["https://example.com/a", "https://example.com/b"],
        pagesCount: 2,
        pagesHasMore: false,
      },
    ]);
  });

  test("it is never an issue and does not change the score", () => {
    expect(parsed.issues.map((i) => i.ruleId)).not.toContain("crawl/robots-meta-conflict");
    const without = JSON.parse(
      renderJson(
        baseReport({
          "crawl/robots-meta-conflict": rule("crawl/robots-meta-conflict", "Robots conflicts", [
            { name: "robots-conflict", status: "pass", message: "No robots meta/robots.txt conflicts detected" },
          ]),
        }),
      ),
    ) as { score: unknown; infoChecks?: unknown };
    expect(parsed.score).toEqual(without.score);
    expect(without.infoChecks).toBeUndefined();
  });

  test("a report with no info checks has no infoChecks key", () => {
    expect("infoChecks" in (JSON.parse(renderJson(baseReport({}))) as object)).toBe(false);
  });
});

describe("info checks in the LLM report (#669)", () => {
  test("off by default: the LLM report is read against a token budget", () => {
    expect(renderLlm(baseReport({ "crawl/robots-meta-conflict": INFO_RULE }))).not.toContain("<info-checks");
  });

  test("listed under <info-checks> with the page count when asked for", () => {
    const llm = renderLlm(baseReport({ "crawl/robots-meta-conflict": INFO_RULE }), { includeInfo: true });
    expect(llm).toContain('<info-checks count="1">');
    expect(llm).toContain('<check rule="crawl/robots-meta-conflict" name="redundant-noindex" pages="2">');
    expect(llm).toContain("Pages: https://example.com/a, https://example.com/b");
  });

  test("a long list is capped and says how many it leaves out", () => {
    const many: Record<string, ReportRuleResult> = {};
    for (let i = 0; i < 40; i++) {
      many[`x/r${String(i).padStart(2, "0")}`] = rule(`x/r${String(i).padStart(2, "0")}`, `R${i}`, [
        { name: "note", status: "info", message: "Nothing to check", pages: ["https://example.com/a"] },
      ]);
    }
    const llm = renderLlm(baseReport(many), { includeInfo: true });
    expect(llm).toContain('<info-checks count="40">');
    expect(llm).toContain('<more count="15">');
    const json = JSON.parse(renderJson(baseReport(many))) as { infoChecks: unknown[] };
    expect(json.infoChecks).toHaveLength(40);
  });

  test("pages are capped at ten per check with the true count", () => {
    const pages = Array.from({ length: 25 }, (_, i) => `https://example.com/p${String(i).padStart(2, "0")}`);
    const parsed = JSON.parse(
      renderJson(baseReport({ "x/r": rule("x/r", "R", [{ name: "note", status: "info", message: "m", pages }]) })),
    ) as { infoChecks: Array<{ pages: string[]; pagesCount: number; pagesHasMore: boolean }> };
    expect(parsed.infoChecks[0]!.pages).toHaveLength(10);
    expect(parsed.infoChecks[0]).toMatchObject({ pagesCount: 25, pagesHasMore: true });
  });

  test("absent when there are none", () => {
    expect(renderLlm(baseReport({}), { includeInfo: true })).not.toContain("<info-checks");
  });
});

describe("a rule that timed out is a skipped check (#518)", () => {
  test("listed with reason rule-timed-out and the number of pages that hit the budget", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          "content/hidden-text": rule("content/hidden-text", "Hidden text", [
            {
              name: "content/hidden-text",
              status: "skipped",
              message: "Rule not evaluated: exceeded its time budget",
              skipReason: "rule-timed-out",
              details: { pages: 3 },
            },
          ]),
        }),
      ),
    ) as { skippedChecks?: Array<Record<string, unknown>>; summary: { skipped: number }; issues: unknown[] };
    expect(parsed.skippedChecks).toHaveLength(1);
    expect(parsed.skippedChecks![0]).toMatchObject({
      ruleId: "content/hidden-text",
      reason: "rule-timed-out",
      pagesCount: 3,
    });
    expect(parsed.summary.skipped).toBe(3);
    expect(parsed.issues).toEqual([]);
  });
});
