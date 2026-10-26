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

/** An uncapped report whose one check lists `listed` items and left `leftOut` out. */
function reportWithItems(listed: number, leftOut: number): AuditReport {
  const r = report();
  const check = r.ruleResults["images/alt"]!.checks[0]!;
  check.pages = [SAMPLE[0]!];
  check.items = Array.from({ length: listed }, (_, i) => ({ id: `https://example.com/i${i}.png` }));
  check.details = { additional: leftOut };
  return r;
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

  test("says how many issues did not fit", () => {
    expect(publishedReportNote({ detail: { ...STAMP, fullDetail: "local", classesDropped: 3 } })).toContain(
      "beside its true counts. 3 more issues did not fit and are counted in the score only. The complete list",
    );
  });

  test("caps that are not finite numbers fall back to the full sample, never reach the copy", () => {
    for (const bad of ["10<script>", Number.NaN, Number.POSITIVE_INFINITY, -3, { n: 1 }, null]) {
      const note = publishedReportNote({
        detail: {
          ...STAMP,
          fullDetail: "local",
          caps: { ...STAMP.caps, pagesPerClass: bad, itemsPerClass: bad },
          classesDropped: bad,
        },
      } as unknown as Pick<AuditReport, "detail">);
      expect(note).toStartWith(NOTE);
      expect(note).not.toContain("did not fit");
      expect(note).not.toContain("<script>");
      expect(note).not.toContain("NaN");
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

  test("llm escapes the note like every other value", () => {
    const out = renderLlm(capped);
    const line = out.split("\n").find((l) => l.startsWith("<published-summary>"))!;
    expect(line).toEndWith("</published-summary>");
    expect(line.slice("<published-summary>".length, -"</published-summary>".length)).not.toMatch(/[<>&]/);
  });

  // repo#2661: the hosted HTML, markdown and text said only how many items they
  // LISTED, so a capped class with 1,147 items read "1 item". Each now says how
  // many more the report left out, and says nothing when it left none.
  for (const [name, render, expected] of [
    ["html", renderHtml, "1 item, 37 more not listed"],
    ["markdown", renderMarkdown, "1 item(s), 37 more not listed"],
    ["text", renderText, "... and 37 more items not listed"],
  ] as const) {
    test(`${name} counts the items a capped check left out`, () => {
      expect(render(capped)).toContain(expected);
    });

    test(`${name} says nothing more when no item was left out`, () => {
      expect(render(reportWithItems(3, 0))).not.toContain("not listed");
    });
  }

  // A counts-only class in a capped report keeps no item rows at all.
  for (const [name, render, expected] of [
    ["html", renderHtml, "1,500 items not listed"],
    ["markdown", renderMarkdown, "**missing-alt:** 1,500 items not listed"],
    ["text", renderText, "        1,500 items not listed"],
  ] as const) {
    test(`${name} counts the items of a check that lists none`, () => {
      expect(render(reportWithItems(0, 1_500))).toContain(expected);
    });
  }

  test("one item left out is one item", () => {
    expect(renderText(reportWithItems(0, 1))).toContain("        1 item not listed");
  });

  test("thousands are grouped in the not-listed count", () => {
    expect(renderText(reportWithItems(2, 1_142))).toContain("... and 1,142 more items not listed");
  });

  // `details.additional` counts items a check LEFT OUT of `items` (the fold's
  // and the publish clamp's dropped count, plus a rule's own remainder), never
  // items it lists, so adding it to the listed count is the true total.
  test("an uncapped report with clamped items: listed plus left out, no note", () => {
    const report = reportWithItems(3, 4);
    const out = renderLlm(report);
    expect(out).toContain("Items (3/7):");
    expect(out).not.toContain("<published-summary>");
  });
});
