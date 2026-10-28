// pub#837: the source rows of any item with sourcePages, not only link findings. An a11y/link-text
// item found on several pages gets its pages from the grouping (per-page checks) or from the publish
// fold, has no per-page sections, and must list each page once without pointing at a list that does
// not hold it ("+N more (see full list above)").

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

const SITE = "https://example.com";
const page = (k: number) => `${SITE}/p${k}`;

const META: ReportRuleResult["meta"] = {
  id: "a11y/link-text",
  name: "Link Text",
  description: "Links need descriptive text",
  category: "a11y",
  scope: "page",
  severity: "warning",
  weight: 4,
};

function report(checks: ReportRuleResult["checks"]): AuditReport {
  return {
    baseUrl: SITE,
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 50,
    passed: 0,
    warnings: 1,
    failed: 0,
    ruleResults: { "a11y/link-text": { meta: META, checks } },
  };
}

/** "read more" on six pages, one per-page check each: the grouping attributes the item to them. */
const PER_PAGE = report(
  Array.from({ length: 6 }, (_, k) => ({
    name: "link-text-generic",
    status: "warn" as const,
    message: "1 link(s) with generic text",
    pageUrl: page(k),
    items: [{ id: "read more" }],
  })),
);

/** A published fold: ten pages listed (one twice), forty in all. */
const PUBLISHED = report([
  {
    name: "link-text-generic",
    status: "warn",
    message: "1 link(s) with generic text",
    pages: Array.from({ length: 10 }, (_, k) => page(k)),
    items: [
      {
        id: "click here",
        sourcePages: [page(0), page(0), ...Array.from({ length: 9 }, (_, k) => page(k + 1))],
        pageCount: 40,
      },
    ],
    details: { pagesTruncated: 40 },
  },
]);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("a11y item source rows (pub#837)", () => {
  test("no format points at a list elsewhere", () => {
    for (const r of [PER_PAGE, PUBLISHED]) {
      for (const out of [renderHtml(r), renderMarkdown(r), renderText(r), renderLlm(r), renderXml(r)]) {
        expect(out).not.toContain("see full list");
      }
    }
  });

  test("text: each page once, no section phrase, then how many are left out", () => {
    const text = renderText(PER_PAGE);
    expect(text).toMatch(/from: \/p0\n/);
    expect(text).toContain("from: /p2");
    expect(text).not.toContain("from: /p3");
    expect(text).toContain("+3 more pages");
    expect(text).not.toContain("found on");
  });

  test("markdown: three rows, then how many are left out", () => {
    const md = renderMarkdown(PER_PAGE);
    expect(md).toContain(`  - from: [/p0](${page(0)})\n`);
    expect(md).toContain("  - +3 more pages");
  });

  test("html: the rest of the pages expand inside the item", () => {
    const html = renderHtml(PER_PAGE);
    expect(html).toMatch(/<summary class="more">\+3 more pages<\/summary>/);
    const item = html.slice(html.indexOf("+3 more pages</summary>"));
    for (const k of [3, 4, 5]) expect(item).toContain(`href="${page(k)}"`);
  });

  test("llm: five rows, then how many are left out", () => {
    const llm = renderLlm(PER_PAGE);
    expect(llm).toContain("(from: /p0, /p1, /p2, /p3, /p4; +1 more page)");
  });

  test("a published item lists each page once and counts the pages the report does not list", () => {
    const text = renderText(PUBLISHED);
    expect(count(text, "from: /p0")).toBe(1);
    // 10 listed, 3 shown: 7 more listed and 30 never listed.
    expect(text).toContain("+37 more pages");
    expect(renderMarkdown(PUBLISHED)).toContain("  - +37 more pages");
    expect(renderLlm(PUBLISHED)).toContain("; +35 more pages)");
    const html = renderHtml(PUBLISHED);
    expect(html).toMatch(/<summary class="more">\+7 more pages<\/summary>/);
    expect(html).toContain("+30 more pages not listed here");
    expect(count(html, `href="${page(0)}"`)).toBeLessThanOrEqual(2); // check page list + item row
  });
});
