// pub#857: the console says "On all 9 documentation pages" for a finding on every page of one
// page type, and lists no page rows for it. A finding that is not scoped keeps its rows.

import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const SITE = "https://example.com";
const MESSAGE =
  "Reads as a documentation page but declares no Article, TechArticle, HowTo or FAQPage structured data";

function capture(report: AuditReport): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n").replace(ANSI, "");
}

function expectedType(docsAudited: number): AuditReport {
  const report = createMinimalReport();
  report.ruleResults = {
    "schema/expected-type": {
      meta: {
        id: "schema/expected-type",
        name: "Expected schema for page type",
        description:
          "Flags a page that declares none of the structured data its type should carry",
        category: "schema",
        scope: "page",
        severity: "warning",
        weight: 5,
      },
      checks: Array.from({ length: 9 }, (_, k) => ({
        name: "expected-type",
        status: "fail" as const,
        message: MESSAGE,
        pageUrl: `${SITE}/docs/page-${k}`,
        details: {
          pageType: "docs",
          pageTypeSource: "model",
          confidence: 0.95,
        },
      })),
    },
  };
  report.structure = {
    pages: docsAudited + 20,
    sections: [],
    unknownLinks: 0,
    totalLinks: 0,
    chrome: { links: 0, contentLinks: 0, share: null },
    pageTypes: {
      counts: [{ label: "docs", pages: docsAudited }],
      notClassified: 20,
      byModel: docsAudited,
      degraded: 0,
    },
  } as unknown as NonNullable<AuditReport["structure"]>;
  return report;
}

describe("console: a finding on every page of one page type", () => {
  test("all nine documentation pages are one line, with no page rows", () => {
    const out = capture(expectedType(9));
    expect(out).toContain(MESSAGE);
    expect(out).toContain("On all 9 documentation pages");
    expect(out).not.toContain("/docs/page-0");
  });

  test("nine of eleven", () => {
    const out = capture(expectedType(11));
    expect(out).toContain("On 9 of 11 documentation pages");
    expect(out).not.toContain("/docs/page-0");
  });

  test("below the share the page rows stay", () => {
    const out = capture(expectedType(20));
    expect(out).not.toMatch(/On (all )?\d+( of \d+)? documentation pages/);
    expect(out).toContain("/docs/page-0");
  });

  test("a report with no structure keeps the page rows", () => {
    const report = expectedType(9);
    delete report.structure;
    const out = capture(report);
    expect(out).not.toMatch(/On (all )?\d+( of \d+)? documentation pages/);
    expect(out).toContain("/docs/page-0");
  });
});
