// #1023 R-F anti-drift gate (blueprint risk 5): ONE shared fixture rendered
// through every affected-page-count consumer, asserting the count surfaces are
// AUTHORITATIVE (the true pre-sample total, not the clipped sample length) and
// that clipped lists are labeled as examples. This file covers the 6
// packages/report renderers. Hosted renderers and summary builders consume the
// same shared `affectedPages` accessor through this public package.

import { describe, expect, test } from "bun:test";

import type { AuditReport, CheckResult, ReportRuleResult } from "../src/types";
import { REPORT_PAGES_HARD_CAP } from "../src/constants";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderLlm } from "../src/output/llm";
import { renderJson } from "../src/output/json";
import { renderXml } from "../src/output/xml";
import { renderHtml } from "../src/output/html";

function reportWithCheck(id: string, severity: "error" | "warning", check: CheckResult): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id,
      name: id,
      description: "desc",
      solution: "sol",
      category: "core",
      scope: "page",
      severity,
      weight: 10,
    },
    checks: [check],
  };
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-20T00:00:00.000Z",
    totalPages: 999,
    passed: 0,
    warnings: severity === "warning" ? 1 : 0,
    failed: severity === "error" ? 1 : 0,
    ruleResults: { [id]: rule },
    healthScore: {
      overall: 60,
      categories: [],
      groups: [],
      errorCount: severity === "error" ? 1 : 0,
      warningCount: severity === "warning" ? 1 : 0,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

// A folded/sampled check: 3 example page URLs retained, but the true pre-clip
// total (600) stamped on details.pagesTruncated. Every renderer must show 600.
const SAMPLE = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
const foldedReport = reportWithCheck("core/missing-title", "error", {
  name: "missing-title",
  status: "fail",
  message: "Page is missing a title tag",
  pages: SAMPLE,
  details: { aggregated: true, pagesTruncated: 600 },
} as unknown as CheckResult);

describe("#1023 R-F: authoritative affected-page count across all 6 renderers", () => {
  test("text: '(600 pages)' with '... and 597 more', not the 3-page sample", () => {
    const out = renderText(foldedReport);
    expect(out).toContain("(600 pages)");
    expect(out).toContain("... and 597 more");
    expect(out).not.toContain("(3 pages)");
  });

  test("markdown: '600 page(s) affected' + labeled examples note", () => {
    const out = renderMarkdown(foldedReport);
    expect(out).toContain("600 page(s) affected");
    expect(out).toContain("_Showing 3 examples of 600 affected pages._");
  });

  test("llm: rule 'Pages (3/600)' — sample over authoritative total", () => {
    const out = renderLlm(foldedReport);
    expect(out).toContain("Pages (3/600)");
  });

  test("html: rule header + per-check message + PagesList all read 600", () => {
    const out = renderHtml(foldedReport);
    expect(out).toContain("600 pages affected");
    expect(out).toContain("(600 pages)");
    expect(out).toContain("Showing 3 of 600 affected pages.");
  });

  test("json: affectedPagesCount=600, hasMore=true, sample kept at 3", () => {
    const parsed = JSON.parse(renderJson(foldedReport)) as {
      issues: Array<{
        checks: Array<{
          affectedPages: string[];
          affectedPagesCount: number;
          affectedPagesHasMore: boolean;
        }>;
      }>;
    };
    const check = parsed.issues[0]!.checks[0]!;
    expect(check.affectedPagesCount).toBe(600);
    expect(check.affectedPagesHasMore).toBe(true);
    expect(check.affectedPages).toHaveLength(3);
  });

  test("xml: <affected-pages count=600 examples=3 has-more=true>", () => {
    const out = renderXml(foldedReport);
    expect(out).toContain('<affected-pages count="600" examples="3" has-more="true">');
  });
});

// Cap+1 overshoot (memory: deliberate-cap-plus-one-overshoot-proves-truncation):
// materialize exactly REPORT_PAGES_HARD_CAP + 1 real page URLs, no pagesTruncated
// — the true total IS the sample length, so the ONLY way the display can show a
// clip is if the renderer honours the hard cap. Proves html/markdown truncate at
// the cap AND disclose it, rather than silently embedding all N+1 URLs.
const OVERSHOOT = REPORT_PAGES_HARD_CAP + 1; // 201
// Zero-padded so lexicographic == numeric order (renderers sort the page list):
// the hard-cap slice then deterministically drops the last URL, /p200.
const overshootPages = Array.from(
  { length: OVERSHOOT },
  (_, i) => `https://example.com/p${String(i).padStart(3, "0")}`,
);
const cappedReport = reportWithCheck("core/img-alt", "warning", {
  name: "img-alt",
  status: "warn",
  message: "Image missing alt text",
  pages: overshootPages,
} as unknown as CheckResult);

describe("#1023 R-F: cap+1 overshoot proves display truncation is disclosed", () => {
  test("html: materializes exactly the cap, discloses 'Showing 200 of 201'", () => {
    const out = renderHtml(cappedReport);
    expect(out).toContain(`Showing ${REPORT_PAGES_HARD_CAP} of ${OVERSHOOT} affected pages.`);
    // The (cap+1)-th URL must NOT be embedded — it sits beyond the hard cap.
    expect(out).toContain("/p199");
    expect(out).not.toContain("/p200");
  });

  test("markdown: 'Showing 200 examples of 201', last URL clipped", () => {
    const out = renderMarkdown(cappedReport);
    expect(out).toContain(`_Showing ${REPORT_PAGES_HARD_CAP} examples of ${OVERSHOOT} affected pages._`);
    expect(out).toContain("/p199");
    expect(out).not.toContain("/p200");
  });

  test("html rule header shows the full 201, not the materialized 200", () => {
    const out = renderHtml(cappedReport);
    expect(out).toContain(`${OVERSHOOT} pages affected`);
  });
});

// #1306: rule-level rollup across a MULTI-check rule. `reportWithCheck` above
// only builds single-check rules, so the rule-header rollup path (max across
// per-check counts) went unexercised. Build a rule with TWO independently-
// truncated checks whose sampled page sets are DISJOINT (check A: 400 truncated,
// check B: 300 truncated, no shared URLs). The honest rule total is a FLOOR:
// max(400, 300) = 400 (never the sum 700 — that would double-count pages shared
// across checks, which is the common case), surfaced with a "+" because the two
// truncated checks could hide up to 300 more disjoint pages. This gate fails
// against a plain per-check-max rollup (which drops the "+" floor marker).
function reportWithChecks(
  id: string,
  severity: "error" | "warning",
  checks: CheckResult[],
): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id,
      name: id,
      description: "desc",
      solution: "sol",
      category: "core",
      scope: "page",
      severity,
      weight: 10,
    },
    checks,
  };
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-20T00:00:00.000Z",
    totalPages: 999,
    passed: 0,
    warnings: severity === "warning" ? 1 : 0,
    failed: severity === "error" ? 1 : 0,
    ruleResults: { [id]: rule },
    healthScore: {
      overall: 60,
      categories: [],
      groups: [],
      errorCount: severity === "error" ? 1 : 0,
      warningCount: severity === "warning" ? 1 : 0,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

const multiCheckReport = reportWithChecks("core/multi", "error", [
  {
    name: "check-a",
    status: "fail",
    message: "Check A failed",
    pages: ["https://example.com/a1", "https://example.com/a2", "https://example.com/a3"],
    details: { aggregated: true, pagesTruncated: 400 },
  } as unknown as CheckResult,
  {
    name: "check-b",
    status: "fail",
    message: "Check B failed",
    pages: ["https://example.com/b1", "https://example.com/b2", "https://example.com/b3"],
    details: { aggregated: true, pagesTruncated: 300 },
  } as unknown as CheckResult,
]);

describe("#1306: multi-check rule rollup floors at max and marks the floor", () => {
  test("html: rule header reads '400+ pages affected' (floor + marker, never summed)", () => {
    const out = renderHtml(multiCheckReport);
    // Floor = max(400, 300) with a "+" — NOT the sum (700) and NOT bare "400".
    expect(out).toContain("400+ pages affected");
    expect(out).not.toContain("700 pages affected");
    // Per-check counts still surface each check's own authoritative total.
    expect(out).toContain("(400 pages)");
    expect(out).toContain("(300 pages)");
  });

  test("llm: rule 'Pages (N/400+)' — floor over the sampled union, marked", () => {
    const out = renderLlm(multiCheckReport);
    expect(out).toMatch(/Pages \(\d+\/400\+\)/);
    expect(out).not.toContain("/700");
  });
});
