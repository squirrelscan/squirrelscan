// #1136 review round 3: markdown.ts's per-check page list read `check.pages`
// directly while the rule-level rollup above it already used the
// checkAffectedPages union — for a site-scope check (pages only via
// item.sourcePages) this meant the rollup said "N of M carried" while the
// list right below it showed zero pages. Both must agree.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";

function baseReport(ruleResults: Record<string, ReportRuleResult>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 10,
    passed: 5,
    warnings: 1,
    failed: 0,
    ruleResults,
  };
}

function rule(id: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "desc",
      category: "seo",
      scope: "site",
      severity: "warning",
      weight: 5,
    },
    checks,
  };
}

describe("renderMarkdown site-scope affected pages (#1136 round 3)", () => {
  test("a site-scope check (pages only via item.sourcePages) lists its pages, not zero", () => {
    const sourcePages = Array.from({ length: 5 }, (_, i) => `https://example.com/dup-${i}`);
    const md = renderMarkdown(
      baseReport({
        "seo/duplicate-title": rule("seo/duplicate-title", [
          {
            name: "duplicate-title",
            status: "warn",
            message: "Duplicate title across pages",
            items: [{ id: "Home | Example", sourcePages, label: "Home | Example" }],
          },
        ]),
      }),
    );
    expect(md).toContain("5 page(s) affected");
    for (const p of sourcePages) expect(md).toContain(p);
  });

  test("a fully carried site-scope check tags every sourcePages URL, not just page-scope ones", () => {
    const md = renderMarkdown(
      baseReport({
        "seo/duplicate-title": rule("seo/duplicate-title", [
          {
            name: "duplicate-title",
            status: "warn",
            message: "Duplicate title across pages",
            items: [{ id: "Home | Example", sourcePages: ["https://example.com/a"] }],
            provenance: "carried",
            lastSeenAt: 1,
          },
        ]),
      }),
    );
    expect(md).toContain("https://example.com/a) (carried)");
  });

  test("a long site-scope page list is capped with a truncation disclosure", () => {
    const sourcePages = Array.from({ length: 300 }, (_, i) => `https://example.com/p${i}`);
    const md = renderMarkdown(
      baseReport({
        "seo/duplicate-title": rule("seo/duplicate-title", [
          {
            name: "duplicate-title",
            status: "warn",
            message: "Duplicate title across pages",
            items: [{ id: "Home | Example", sourcePages }],
          },
        ]),
      }),
    );
    // #1023 R-F: listed pages are labeled examples; the count is authoritative.
    expect(md).toContain("Showing 200 examples of 300 affected pages.");
    expect(md).not.toContain("https://example.com/p250");
  });

  test("a URL-id item with sourcePages: [] keeps its own row (not dropped as redundant)", () => {
    const md = renderMarkdown(
      baseReport({
        "seo/blocked-links": rule("seo/blocked-links", [
          {
            name: "blocked-resource",
            status: "warn",
            message: "Resource blocked, no known referring page",
            items: [{ id: "https://cdn.example.com/blocked.js", sourcePages: [] }],
          },
        ]),
      }),
    );
    expect(md).not.toContain("page(s) affected");
    expect(md).toContain("1 item(s)");
    expect(md).toContain("https://cdn.example.com/blocked.js");
  });
});
