// Report detail (#2307): the last section of every human-facing report. It holds, in order, what
// this audit did not check, the page structure, and the scope and coverage notes that used to sit
// under the title. The top of the report is the title, URL, date, page count and version, then
// the score, the summary and the issues. JSON and XML keep their data fields where they were.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import { createStructureBuilder } from "../src/structure";

function rule(
  id: string,
  name: string,
  severity: ReportRuleResult["meta"]["severity"],
  checks: ReportRuleResult["checks"],
): ReportRuleResult {
  return {
    meta: { id, name, description: `${name} description`, category: "seo", scope: "page", severity, weight: 5 },
    checks,
  };
}

const NOT_CHECKED = "External link checking was off for this audit, so 3 external link(s) on the audited pages were not checked";

function structure() {
  const builder = createStructureBuilder();
  builder.add({
    sections: { header: 2, footer: 6, content: 3 },
    chromeInternal: 8,
    contentInternal: 3,
    pageType: { label: "homepage", confidence: 0.97, source: "model" },
    degraded: false,
  });
  return builder.build()!;
}

/** A report with an issue, a not-checked notice, a page structure and scope notes. */
function fullReport(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-16T10:00:00.000Z",
    totalPages: 100,
    passed: 4,
    warnings: 0,
    failed: 1,
    healthScore: { overall: 80, categories: [], errorCount: 1, warningCount: 0, passedCount: 4 },
    scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true },
    coverage: { auditedPages: 100, knownPages: 505, carriedFindings: 12 },
    rateLimited: { pages: 7, hosts: ["example.com"] },
    fetchFallbacks: { recovered: 3 },
    structure: structure(),
    ruleResults: {
      "seo/title": rule("seo/title", "Page title", "error", [
        { name: "title", status: "fail", message: "Missing title" },
      ]),
      "links/broken-external-links": {
        ...rule("links/broken-external-links", "Broken External Links", "warning", [
          {
            name: "broken-external-links",
            status: "skipped",
            message: NOT_CHECKED,
            skipReason: "external-links-not-checked",
          },
        ]),
        meta: {
          id: "links/broken-external-links",
          name: "Broken External Links",
          description: "d",
          category: "links",
          scope: "site",
          severity: "warning",
          weight: 5,
        },
      },
    },
  } as AuditReport;
}

const ABOVE = ["Not checked", "Page structure", "Rate limited", "Scan:", "Partial scan", "audited 100 of 505"];

describe("markdown", () => {
  const md = renderMarkdown(fullReport(), { version: "1.2.3" });
  const head = md.split("\n").slice(0, 12).join("\n");

  test("the top is the title, URL, date, pages and version, then the score and summary", () => {
    expect(head).toContain("# squirrelscan Audit Report");
    expect(head).toContain("**URL:** https://example.com");
    expect(head).toContain("**Date:**");
    expect(head).toContain("**Pages:** 100");
    expect(head).toContain("**Version:** 1.2.3");
    for (const text of ABOVE) expect(head).not.toContain(text);
    expect(md.slice(0, md.indexOf("## Summary"))).not.toContain("Not checked");
  });

  test("Report detail is the last section, after the issues", () => {
    expect(md.indexOf("## Issues")).toBeLessThan(md.indexOf("## Report detail"));
    const headings = md.split("\n").filter((line) => line.startsWith("## "));
    expect(headings[headings.length - 1]).toBe("## Report detail");
  });

  test("it holds not-checked notices, then the page structure, then the scan details", () => {
    const detail = md.slice(md.indexOf("## Report detail"));
    const order = ["### Not checked", "### Page structure", "### Scan details"].map((h) => detail.indexOf(h));

    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Plain list items, no "Not checked:" lead-in, no bold paragraphs.
    expect(detail).toContain(`- Broken External Links. ${NOT_CHECKED.replaceAll("(", "\\(").replaceAll(")", "\\)")}`);
    expect(detail).not.toContain("Not checked:");
    expect(detail).not.toContain("**");
    expect(detail).toContain("- Rate limited: 7 page(s) not verified (example.com)");
    expect(detail).toContain("- Scan: 100 pages crawled");
  });

  test("a rule name that opens a block in markdown cannot nest or become a heading", () => {
    const named = (name: string): AuditReport => {
      const report = fullReport();
      const original = report.ruleResults["links/broken-external-links"]!;
      report.ruleResults["links/broken-external-links"] = {
        ...original,
        meta: { ...original.meta, name },
      };
      return report;
    };

    expect(renderMarkdown(named("1"))).toContain("- 1\\. External link checking");
    expect(renderMarkdown(named("1"))).not.toContain("- 1. ");
    expect(renderMarkdown(named("# Loud"))).toContain("- \\# Loud. External link checking");
    expect(renderMarkdown(named("- x"))).toContain("- \\- x. External link checking");
  });

  test("a report with none of it has no Report detail", () => {
    const plain = renderMarkdown({
      baseUrl: "https://example.com",
      timestamp: "2026-10-16T10:00:00.000Z",
      totalPages: 1,
      passed: 0,
      warnings: 0,
      failed: 0,
      ruleResults: {},
    });
    expect(plain).not.toContain("Report detail");
  });
});

describe("text", () => {
  const text = renderText(fullReport(), { version: "1.2.3" });
  const head = text.split("\n").slice(0, 8).join("\n");

  test("the header keeps the title, the URL and the page count only", () => {
    expect(head).toContain("Auditing: https://example.com");
    expect(head).toContain("Crawled 100 pages");
    for (const t of ABOVE) expect(head).not.toContain(t);
  });

  test("REPORT DETAIL comes after the issues, in order", () => {
    const at = (needle: string) => text.indexOf(needle);
    expect(at("ISSUES")).toBeLessThan(at("REPORT DETAIL"));
    expect(at("REPORT DETAIL")).toBeLessThan(at("Not checked\n"));
    expect(at("Not checked\n")).toBeLessThan(at("Page structure\n"));
    expect(at("Page structure\n")).toBeLessThan(at("Scan details\n"));
    expect(text).toContain(`  - Broken External Links. ${NOT_CHECKED}`);
    expect(text).not.toContain("Not checked:");
  });
});

describe("llm", () => {
  const llm = renderLlm(fullReport());

  test("one report-detail element at the end, not-checked before page-structure", () => {
    const at = (needle: string) => llm.indexOf(needle);
    expect(at("<issues>")).toBeLessThan(at("<report-detail>"));
    expect(at("<report-detail>")).toBeLessThan(at("<not-checked"));
    expect(at("<not-checked")).toBeLessThan(at("<page-structure"));
    expect(at("</page-structure>")).toBeLessThan(at("</report-detail>"));
    expect(at("</report-detail>")).toBeLessThan(at("</audit>"));
    expect(llm.slice(0, at("<issues>"))).not.toContain("<page-structure");
    expect(llm.slice(0, at("<issues>"))).not.toContain("<not-checked");
  });
});

describe("html", () => {
  const html = renderHtml(fullReport());

  test("the page structure has its own section after the findings", () => {
    const structureAt = html.indexOf('<section id="structure">');
    expect(structureAt).toBeGreaterThan(html.indexOf('<section id="findings">'));
    expect(html.slice(structureAt)).toContain("Page structure");
    // The notices keep the page's own dismissible lines at the top: no Report detail wrapper.
    expect(html).not.toContain("<h2>Report detail</h2>");
  });

  test("the not-checked notice is one of the page's own notices, with its lead-in", () => {
    expect(html).toContain(`Not checked: Broken External Links. ${NOT_CHECKED}`);
  });
});

describe("json and xml keep their data fields", () => {
  test("json still carries notChecked, structure and the scope fields at the top level", () => {
    const parsed = JSON.parse(renderJson(fullReport())) as Record<string, unknown>;
    expect(Array.isArray(parsed.notChecked)).toBe(true);
    expect(parsed.structure).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain("reportDetail");
  });

  test("xml still carries <not-checked> and <page-structure>, with no report-detail wrapper", () => {
    const xml = renderXml(fullReport());
    expect(xml).toContain("<not-checked");
    expect(xml).toContain("<page-structure");
    expect(xml).not.toContain("report-detail");
  });
});
