// pub#836, pub#842, pub#843: the broken-link rules are reliability findings.
//
// `links/broken-links`, `links/broken-external-links` and `links/broken-anchors`
// moved from the Links category (SEO group) to Reliability. Reliability rolls
// up into the Performance group, so the HTML badge, which names the rule's
// group, read "Performance" on a dead link. A Reliability rule's badge now
// names its category; its score still counts toward Performance. A report
// stored before the move keeps the category it was stored with.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";

import { getBadgeName, getBadgeTitle, getCategoryGroup } from "../src/categories";
import { renderHtml } from "../src/output/html";

function rule(id: string, category: string): ReportRuleResult {
  return {
    meta: { id, name: id, description: "", category, scope: "site", severity: "error", weight: 7 },
    checks: [{ name: "c", status: "fail", message: "1 broken internal link(s) (4xx/5xx)" }],
  };
}

function report(rules: ReportRuleResult[]): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 0,
    failed: rules.length,
    ruleResults: Object.fromEntries(rules.map((r) => [r.meta.id, r])),
    healthScore: {
      overall: 80,
      categories: [],
      groups: [
        { group: "seo", name: "SEO", score: 80, passed: 1, warnings: 0, failed: 1, total: 2 },
        { group: "performance", name: "Performance", score: 80, passed: 1, warnings: 0, failed: 1, total: 2 },
      ],
      errorCount: rules.length,
      warningCount: 0,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

/** Every `gtag` pill as `title|text`. */
function badges(html: string): string[] {
  return [...html.matchAll(/class="gtag" data-g="[^"]*" title="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map(
    (m) => `${m[1]}|${m[2]}`,
  );
}

describe("reliability badges (pub#842)", () => {
  test("a Reliability rule's badge names its category; its score still rolls into Performance", () => {
    expect(getCategoryGroup("reliability")).toBe("performance");
    expect(getBadgeName("reliability")).toBe("Reliability");
    expect(getBadgeTitle("reliability")).toBe("Reliability, scored under Performance");
    // Every other category keeps its group's badge.
    expect(getBadgeName("perf")).toBe("Performance");
    expect(getBadgeName("links")).toBe("SEO");
    expect(getBadgeTitle("links")).toBe("SEO");
  });

  test("html: the broken-link rules read Reliability, a perf rule still reads Performance", () => {
    const html = renderHtml(
      report([
        rule("links/broken-links", "reliability"),
        rule("links/broken-external-links", "reliability"),
        rule("perf/lcp", "perf"),
      ]),
    );
    expect(badges(html).sort()).toEqual(
      [
        "Performance|Performance",
        "Reliability, scored under Performance|Reliability",
        "Reliability, scored under Performance|Reliability",
      ].sort(),
    );
    expect(html).not.toMatch(/>Performance<\/span>\s*<span class="rule-name">links\/broken-links/);
  });

  test("html: a report stored before the move keeps its stored Links category and SEO badge", () => {
    const html = renderHtml(report([rule("links/broken-links", "links")]));
    expect(badges(html)).toEqual(["SEO|SEO"]);
  });
});
