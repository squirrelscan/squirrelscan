// #1307: the console renderer read `check.pages.length` for "(N pages)" while
// every other format read the shared affectedPages() accessor. A sampled check
// keeps a few example pages and records the true total in
// `details.pagesTruncated`, so the console under-reported it. Today the CLI
// prints before publish samples anything, so this guards the invariant instead
// of a live bug: the CLI reports the true count whatever the pipeline order.

import {
  renderHtml,
  renderJson,
  renderMarkdown,
  renderText,
} from "@squirrelscan/report";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { generateConsoleReport } from "../../src/reports/output/console";

const EXAMPLES = [
  "https://example.com/a",
  "https://example.com/b",
  "https://example.com/c",
];

/** One failing page-scope check listing `pages`, whose true total is `truncated` when set. */
function report(pages: string[], truncated?: number): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-05T00:00:00.000Z",
    totalPages: pages.length,
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
        checks: [
          {
            name: "missing-alt",
            status: "fail",
            message: "Image is missing alt text",
            pages,
            items: [],
            details:
              truncated === undefined ? {} : { pagesTruncated: truncated },
          },
        ],
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
  } as unknown as AuditReport;
}

function consoleText(r: AuditReport): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    generateConsoleReport(r);
  } finally {
    console.log = original;
  }
  // eslint-disable-next-line no-control-regex
  return chunks.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("the CLI reports the true affected-page count of a sampled check (#1307)", () => {
  test("console says 600 pages and how many the sample leaves out", () => {
    const out = consoleText(report(EXAMPLES, 600));
    expect(out).toContain("Image is missing alt text (600 pages)");
    expect(out).not.toContain("(3 pages)");
    expect(out).toContain("... +597 more");
  });

  test("console, text, markdown, html and json agree on the same 600", () => {
    const r = report(EXAMPLES, 600);
    expect(consoleText(r)).toContain("(600 pages)");
    expect(renderText(r)).toContain("(600 pages)");
    expect(renderMarkdown(r)).toContain("600");
    expect(renderHtml(r)).toContain("600");
    expect(
      JSON.parse(renderJson(r)).issues[0].checks[0].affectedPagesCount
    ).toBe(600);
  });

  test("an untruncated check is unchanged: count is the list length, no clipped tail", () => {
    const out = consoleText(report(EXAMPLES));
    expect(out).toContain("Image is missing alt text (3 pages)");
    expect(out).not.toContain("more");
  });

  test("an untruncated list past the preview still counts only what it holds", () => {
    const many = Array.from(
      { length: 8 },
      (_, i) => `https://example.com/p${i}`
    );
    const out = consoleText(report(many));
    expect(out).toContain("(8 pages)");
    expect(out).toContain("... +3 more");
  });

  test("a stale pagesTruncated below the list length is ignored", () => {
    const out = consoleText(report(EXAMPLES, 2));
    expect(out).toContain("(3 pages)");
    expect(out).not.toContain("more");
  });
});
