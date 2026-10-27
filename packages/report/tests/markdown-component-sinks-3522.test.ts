// squirrelscan/repo#3522 for the component-aware lines (#2307): the fix-once and shared-resource
// sentences, the per-source rows and the item links embed page paths and defect values the audited
// site chose. Each test renders the report and parses it with a real CommonMark renderer
// (Bun.markdown), then asserts that no link or image points at the attacker's host.

import { describe, expect, test } from "bun:test";

import type { AuditReport, CheckResult, ComponentOccurrence, ReportRuleResult } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";

const EVIL_PATH = "/a](https://evil.example/x)![i](https://evil.example/p.png)";
const PAYLOAD =
  "x](https://evil.example/y) [t](https://evil.example/z) ![i](https://evil.example/p.png) <img src=https://evil.example/q>";
const PAGES = ["https://example.test/one", "https://example.test/two", "https://example.test/three"].map(
  (page, i) => `${page}${EVIL_PATH}${i}`,
);

function occurrence(pageUrl: string): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: "s128:aaaa" },
    family: { key: "s128:bbbb", structuralSignature: "s128:bbbb" },
    variant: { key: "s128:cccc", structuralSignature: "s128:cccc", contentHash: "s128:dddd" },
    element: { locator: "footer:1>footer>ul:1>a:2", structuralSignature: "s128:eeee" },
    defect: {
      kind: "link-text-generic",
      values: { nameSource: "text", normalizedText: PAYLOAD },
      valueHashes: { normalizedText: "s128:ffff" },
    },
  };
}

function reportOf(check: CheckResult): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id: "a11y/link-text",
      name: "Link text",
      description: "desc",
      solution: "sol",
      category: "accessibility",
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    checks: [check],
  };
  return {
    baseUrl: "https://example.test",
    timestamp: "2026-10-27T00:00:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 1,
    failed: 0,
    ruleResults: { "a11y/link-text": rule },
  } as unknown as AuditReport;
}

function hostileTargets(markdown: string): string[] {
  const html = Bun.markdown.html(markdown);
  return Array.from(html.matchAll(/(?:href|src)="(https?:\/\/evil\.example[^"]*)"/g), (m) => m[1]!);
}

describe("component-aware markdown lines escape what the site chose", () => {
  test("the fix-once sentence", () => {
    const markdown = renderMarkdown(
      reportOf({
        name: "generic-link-text",
        status: "warn",
        message: "3 link(s) with generic text",
        pages: PAGES,
        items: [{ id: "click here" }],
        componentOccurrences: PAGES.map(occurrence),
      }),
    );
    expect(markdown).toContain("Fix once");
    expect(hostileTargets(markdown)).toEqual([]);
  });

  test("per-source rows and item links", () => {
    const markdown = renderMarkdown(
      reportOf({
        name: "broken-links",
        status: "warn",
        message: "1 broken link",
        pages: PAGES,
        items: [
          {
            id: `https://example.test${EVIL_PATH}`,
            label: `https://example.test${EVIL_PATH} (404), linked in the footer`,
            sourcePages: PAGES,
            sources: PAGES.map((page) => ({ page, links: 2, sections: { footer: 2 } })),
          },
        ],
      }),
    );
    expect(markdown).toContain("from:");
    expect(hostileTargets(markdown)).toEqual([]);
  });
});
