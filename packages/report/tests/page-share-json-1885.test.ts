// repo#1885: a fix-once unit CARRIES its page share, and the JSON report serializes it. The human
// reports print the label from the same field, so a consumer of the JSON and a reader of the text see
// one value, never two computations that can drift.

import { describe, expect, test } from "bun:test";

import type {
  AuditReport,
  CheckResult,
  ComponentOccurrence,
  ReportRuleResult,
  SiteResourceOccurrence,
} from "../src/types";

import { groupIssuesByCategory } from "../src/grouping";
import { renderJson } from "../src/output/json";
import { renderText } from "../src/output/text";
import { siteResourceFixGroups } from "../src/site-resource-fix-groups";

const ORIGIN = "https://example.com";
// 3 affected pages of 5 crawled: 0.6, the "template" band.
const AFFECTED = [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/pricing`];
const CRAWLED = 5;

function componentOccurrence(
  pageUrl: string,
  locator: string,
  text: string
): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: ORIGIN,
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: "region" },
    family: { key: "family", structuralSignature: "family" },
    variant: {
      key: "variant",
      structuralSignature: "variant",
      contentHash: "content",
    },
    element: { locator, structuralSignature: `element-${locator}` },
    defect: {
      kind: "link-text-generic",
      values: { text },
      valueHashes: { text: `h-${text}` },
    },
  };
}

function resourceOccurrence(pageUrl: string): SiteResourceOccurrence {
  return {
    kind: "source-map",
    key: `${ORIGIN}/assets/app.js.map`,
    pageUrl,
    source: "/assets/app.js",
    siteOrigin: ORIGIN,
  };
}

function report(totalPages: number | undefined): AuditReport {
  // Two generic links in one footer on every affected page: two groups, one rollup.
  const linkText: ReportRuleResult = {
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
    checks: AFFECTED.map(
      (pageUrl): CheckResult => ({
        name: "generic-link-text",
        status: "warn",
        message: "Generic link text found",
        pageUrl,
        componentOccurrences: [
          componentOccurrence(pageUrl, "footer>a:1", "Read more"),
          componentOccurrence(pageUrl, "footer>a:2", "Click here"),
        ],
      })
    ),
  };
  const sourceMaps = {
    meta: {
      id: "perf/source-maps",
      name: "Source Maps",
      description: "desc",
      solution: "sol",
      category: "perf",
      scope: "page",
      severity: "info",
      weight: 3,
    },
    checks: AFFECTED.map((pageUrl) => ({
      name: "source-maps-exposed",
      status: "warn",
      message: "1 potential source map(s) detected",
      pageUrl,
      pages: [pageUrl],
      items: [{ id: `${ORIGIN}/assets/app.js.map`, label: "from app.js" }],
      siteResourceOccurrences: [resourceOccurrence(pageUrl)],
    })),
  } as unknown as ReportRuleResult;
  return {
    baseUrl: ORIGIN,
    timestamp: "2026-11-25T00:00:00.000Z",
    ...(totalPages === undefined ? {} : { totalPages }),
    passed: 0,
    warnings: 6,
    failed: 0,
    ruleResults: {
      "a11y/link-text": linkText,
      "perf/source-maps": sourceMaps,
    },
    healthScore: {
      overall: 80,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: 2,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

const TEMPLATE_SHARE = {
  share: AFFECTED.length / CRAWLED,
  label: "template" as const,
  crawledPages: CRAWLED,
};

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON report
type Json = any;
const issue = (json: Json, ruleId: string): Json =>
  json.issues.find((i: Json) => i.ruleId === ruleId);

describe("fix-once units carry pageShare (repo#1885)", () => {
  test("the grouping stage puts it on every unit kind", () => {
    const r = report(CRAWLED);
    const rules = groupIssuesByCategory(
      r.ruleResults,
      undefined,
      undefined,
      r.totalPages
    ).flatMap((category) => category.rules);
    const linkText = rules.find((rule) => rule.id === "a11y/link-text")!;
    const sourceMaps = rules.find((rule) => rule.id === "perf/source-maps")!;
    expect(linkText.componentFixGroups).toHaveLength(2);
    for (const group of linkText.componentFixGroups!)
      expect(group.pageShare).toEqual(TEMPLATE_SHARE);
    expect(siteResourceFixGroups(sourceMaps)[0]!.pageShare).toEqual(
      TEMPLATE_SHARE
    );
  });

  test("the JSON report has pageShare on component groups, rollups and site-resource units", () => {
    const json = JSON.parse(renderJson(report(CRAWLED)));
    const linkText = issue(json, "a11y/link-text");
    expect(linkText.componentFixGroups).toHaveLength(2);
    for (const group of linkText.componentFixGroups)
      expect(group.pageShare).toEqual(TEMPLATE_SHARE);
    expect(linkText.componentFixRollups).toHaveLength(1);
    expect(linkText.componentFixRollups[0].pageShare).toEqual(TEMPLATE_SHARE);
    const sourceMaps = issue(json, "perf/source-maps");
    expect(sourceMaps.siteResourceFixGroups).toHaveLength(1);
    expect(sourceMaps.siteResourceFixGroups[0].pageShare).toEqual(
      TEMPLATE_SHARE
    );
  });

  test("the text report prints the label the unit carries", () => {
    const text = renderText(report(CRAWLED));
    expect(text).toContain("/pricing (template)");
  });

  test("no crawl size, no pageShare and no label", () => {
    const r = report(undefined);
    const json = JSON.parse(renderJson(r));
    const linkText = issue(json, "a11y/link-text");
    for (const group of linkText.componentFixGroups)
      expect(group).not.toHaveProperty("pageShare");
    expect(linkText.componentFixRollups[0]).not.toHaveProperty("pageShare");
    expect(
      issue(json, "perf/source-maps").siteResourceFixGroups[0]
    ).not.toHaveProperty("pageShare");
    expect(renderText(r)).not.toContain("(template)");
  });
});
