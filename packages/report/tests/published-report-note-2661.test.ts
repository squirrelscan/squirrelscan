// squirrelscan/repo#2661: a capped published report (repo#2656) lists a sample
// of each issue's pages and items beside its true counts. Every renderer says
// so once, with where the full list is, and a report that is not capped (what
// the CLI renders from its own project, and every report published before
// capping) renders exactly as before.

import { describe, expect, test } from "bun:test";

import { publishedReportNote } from "../src/coverage";
import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import type { AuditReport, CheckResult } from "../src/types";

const SAMPLE = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);

function report(detail?: AuditReport["detail"]): AuditReport {
  const check: CheckResult = {
    name: "missing-alt",
    status: "fail",
    message: "Image is missing alt text",
    pages: SAMPLE,
    items: [{ id: "https://example.com/a.png", sourcePages: [SAMPLE[0]!] }],
    details: { aggregated: true, pagesTruncated: 4_000, occurrences: 4_000, additional: 37 },
  };
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-12T00:00:00.000Z",
    totalPages: 4_000,
    passed: 0,
    warnings: 0,
    failed: 1,
    ruleResults: {
      "images/alt": {
        meta: {
          id: "images/alt",
          name: "Image alt text",
          description: "desc",
          solution: "sol",
          category: "images",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [check],
      },
    },
    healthScore: {
      overall: 60,
      categories: [],
      groups: [],
      errorCount: 1,
      warningCount: 0,
      passedCount: 0,
    },
    ...(detail ? { detail } : {}),
  } as unknown as AuditReport;
}

const STAMP = {
  capped: true,
  tier: 0,
  caps: { pagesPerClass: 10, itemsPerClass: 5, sourcePagesPerItem: 1, messageChars: 500, classesPerRule: 25 },
} as const;

const NOTE = "This published report is a summary: each issue lists up to 10 example pages and 5 items beside its true counts.";

describe("publishedReportNote", () => {
  test("points a CLI audit at squirrel report on that machine", () => {
    expect(publishedReportNote({ detail: { ...STAMP, fullDetail: "local" } })).toBe(
      `${NOTE} The complete list is in the project on the machine that ran the audit: \`squirrel report --format json\` there prints every page.`,
    );
  });

  test("points a cloud audit at the CLI, not an unserved findings view", () => {
    for (const fullDetail of ["findings", undefined] as const) {
      const note = publishedReportNote({ detail: { ...STAMP, ...(fullDetail ? { fullDetail } : {}) } });
      expect(note).toContain("audit the site with the squirrel CLI");
    }
  });

  test("is null for a report that is not capped", () => {
    expect(publishedReportNote({})).toBeNull();
    expect(publishedReportNote({ detail: undefined })).toBeNull();
  });

  test("carries no em-dash", () => {
    expect(publishedReportNote({ detail: { ...STAMP, fullDetail: "local" } })).not.toContain("—");
  });
});

describe("every renderer says it once on a capped report, never on an uncapped one", () => {
  const capped = report({ ...STAMP, fullDetail: "local" });
  const uncapped = report();

  for (const [name, render] of [
    ["html", renderHtml],
    ["markdown", renderMarkdown],
    ["text", renderText],
    ["llm", renderLlm],
  ] as const) {
    test(name, () => {
      const out = render(capped);
      expect(out.split(NOTE).length - 1).toBe(1);
      expect(render(uncapped)).not.toContain(NOTE);
      // The true page count is there, not the sample's 10.
      expect(out).toMatch(/4,?000/);
    });
  }

  test("llm counts the items a capped check left out", () => {
    expect(renderLlm(capped)).toContain("Items (1/38):");
  });
});
