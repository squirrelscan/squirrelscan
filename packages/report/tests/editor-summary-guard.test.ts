/**
 * Render-time text rules for the editor's summary: at most one numeric score,
 * no "/100", no page count the report does not state, never blank.
 */
import { describe, expect, test } from "bun:test";

import { editorSummaryView, summaryPageCounts } from "../src/editor-summary";
import { renderHtml } from "../src/output/html";
import { renderMarkdown } from "../src/output/markdown";
import { guardSummaryText, pageCounts, scoreMentions } from "../src/summary-text";
import type { AuditReport, EditorSummary } from "../src/types";

function report(extra: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://acme.example",
    timestamp: "2026-10-23T00:00:00.000Z",
    totalPages: 13,
    passed: 40,
    warnings: 5,
    failed: 3,
    scanScope: { origin: "cloud", maxPages: 10, pagesCrawled: 10, capped: true },
    coverage: { auditedPages: 10, knownPages: 90, carriedFindings: 0 },
    ruleResults: {
      "a11y/label": {
        meta: { name: "Form labels", category: "a11y", weight: 8 },
        checks: [
          {
            status: "fail",
            message: "Missing label",
            pageUrl: "https://acme.example/",
            details: { occurrences: 7 },
          },
        ],
      },
    } as unknown as AuditReport["ruleResults"],
    generatorVersion: "1.2.3",
    ...extra,
  } as AuditReport;
}

function summary(over: Partial<EditorSummary> = {}): EditorSummary {
  return {
    prose: "",
    bigTicket: [],
    verdict: "",
    model: "m",
    generatedAt: "2026-10-23T00:00:00.000Z",
    ...over,
  };
}

describe("score rules", () => {
  test("counts every numeric score in a sentence", () => {
    expect(scoreMentions("The site is in poor shape at 48/100.")).toBe(1);
    expect(scoreMentions("Scores of 72/100 and 88/100 are mixed.")).toBe(2);
    expect(
      scoreMentions(
        "Crawlability, analytics and reliability all score 99–100, and links score 79.",
      ),
    ).toBe(3);
    expect(scoreMentions("Health is 88 OUT OF 100.")).toBe(1);
    expect(scoreMentions("A solid score with some improvements to make.")).toBe(0);
  });

  test("keeps the first score without /100 and drops later score sentences and verdict", () => {
    const view = editorSummaryView(
      summary({
        prose:
          "The site is in poor shape at 48/100. Accessibility scored 31 and drags it down.\n\nFix the form labels first.",
        verdict: "A 48 score with a clear path to fix.",
      }),
      report(),
    )!;
    expect(view.paragraphs).toEqual([
      "The site is in poor shape at 48.",
      "Fix the form labels first.",
    ]);
    expect(view.verdict).toBe("");
  });

  test("strips /100 from big-ticket lines and priority text", () => {
    const view = editorSummaryView(
      summary({
        prose: "Fix the labels.",
        bigTicket: ["Accessibility at 31/100"],
        priorities: [
          {
            title: "Label the fields",
            why: "Accessibility sits at 31/100.",
            action: "Add labels; aim for 90 out of 100.",
            effort: "quick-win",
            ruleIds: ["a11y/label"],
            technologies: [],
          },
        ],
      }),
      report(),
    )!;
    expect(view.bigTicket).toEqual(["Accessibility at 31"]);
    expect(view.priorities[0]!.why).toBe("Accessibility sits at 31.");
    expect(view.priorities[0]!.action).toBe("Add labels; aim for 90.");
  });
});

describe("page counts", () => {
  test("allows the report's own counts and failing-rule occurrences", () => {
    expect(summaryPageCounts(report()).sort((a, b) => a - b)).toEqual([7, 10, 10, 10, 13, 90]);
  });

  test("drops sentences with counts the report does not state, keeps the rest", () => {
    const view = editorSummaryView(
      summary({
        prose:
          "This audit scanned 10 of 90 known pages. Form labels fail on 7 pages. About 400 pages share the problem. There are 80 more pages to check. Fix HTTP 404 on pages with broken links.",
      }),
      report(),
    )!;
    expect(view.prose).toBe(
      "This audit scanned 10 of 90 known pages. Form labels fail on 7 pages. Fix HTTP 404 on pages with broken links.",
    );
  });

  test("reads ranges, hyphenated and zero counts", () => {
    expect(pageCounts("It affects 999 to 10 pages.")).toContain(999);
    expect(pageCounts("It is a 999-page site.")).toEqual([999]);
    const out = guardSummaryText(
      { prose: "Problems on 0+ pages. Fix the labels.", verdict: "" },
      { allowedPageCounts: [0, 10], fallbackProse: "x" },
    );
    expect(out.prose).toBe("Fix the labels.");
  });

  test("does not split on abbreviations", () => {
    const prose = "Some forms, e.g. the signup form, lack labels on 7 pages.";
    expect(editorSummaryView(summary({ prose }), report())!.prose).toBe(prose);
  });
});

describe("never blank", () => {
  test("falls back to the report totals when every sentence is dropped", () => {
    const view = editorSummaryView(
      summary({
        prose: "About 400 pages share the problem. Scores of 72/100 and 88/100 are mixed.",
      }),
      report(),
    )!;
    expect(view.paragraphs).toEqual([
      "This audit found 3 failing checks and 5 warnings across 13 pages.",
    ]);
  });
});

describe("without the report", () => {
  test("shows the summary as stored", () => {
    const prose = "Poor shape at 48/100. Accessibility scored 31.";
    expect(editorSummaryView(summary({ prose }))!.prose).toBe(prose);
  });
});

describe("renderers", () => {
  const r = report({
    ruleResults: {},
    editorSummary: summary({
      prose: "Poor shape at 48/100. Accessibility scored 31. About 400 pages share it.",
      verdict: "Fix the forms.",
    }),
  });

  test("HTML and Markdown show the guarded summary", () => {
    for (const out of [renderHtml(r), renderMarkdown(r)]) {
      expect(out).toContain("Poor shape at 48.");
      expect(out).not.toContain("48/100");
      expect(out).not.toContain("scored 31");
      expect(out).not.toContain("400 pages");
      expect(out).toContain("Fix the forms.");
    }
  });
});
