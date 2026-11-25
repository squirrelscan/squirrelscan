// repo#1885: page-scope rules never collapse across pages; the page-share tag is a label.
// (helpers copied from site-resource-fix-groups.test.ts)
// Grouping is the whole claim this feature makes, so these pin the shape of
// the claim rather than the wording: which pages a unit says it covers, and
// which resources it says are one repair.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  ReportRuleResult,
  SiteResourceOccurrence,
} from "../src/types";

import { groupIssuesByCategory } from "../src/grouping";
import { pageShareTag } from "../src/page-share";
import { siteResourceFixGroups } from "../src/site-resource-fix-groups";

const ORIGIN = "https://example.test";

function occurrence(
  pageUrl: string,
  key: string,
  overrides: Partial<SiteResourceOccurrence> = {}
): SiteResourceOccurrence {
  return {
    kind: "source-map",
    key,
    pageUrl,
    source: "/assets/app.js",
    siteOrigin: ORIGIN,
    ...overrides,
  };
}

function check(
  pageUrl: string,
  occurrences: SiteResourceOccurrence[]
): CheckResult {
  return {
    name: "source-maps-exposed",
    status: "warn",
    message: `${occurrences.length} potential source map(s) detected`,
    pageUrl,
    pages: [pageUrl],
    items: occurrences.map((o) => ({ id: o.key, label: `from ${o.source}` })),
    siteResourceOccurrences: occurrences,
  } as unknown as CheckResult;
}

/** Through the real grouping stage, so the merge across pages is exercised. */
function rule(checks: CheckResult[], findingScope?: "page" | "resource") {
  const ruleResult: ReportRuleResult = {
    meta: {
      id: "perf/source-maps",
      name: "Source Maps",
      description: "desc",
      solution: "sol",
      category: "perf",
      scope: "page",
      severity: "info",
      weight: 3,
      ...(findingScope ? { findingScope } : {}),
    },
    checks,
  } as unknown as ReportRuleResult;
  const categories = groupIssuesByCategory({ "perf/source-maps": ruleResult });
  return categories[0]!.rules[0]!;
}

const KEY = [`${ORIGIN}/assets/app.js.map`];
const PAGES = [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/pricing`];
const checks = () =>
  PAGES.map((p) =>
    check(
      p,
      KEY.map((k) => occurrence(p, k))
    )
  );

describe("findingScope in grouping", () => {
  test("a resource rule collapses across pages", () => {
    expect(siteResourceFixGroups(rule(checks(), "resource"))).toHaveLength(1);
  });
  test("an undeclared rule still collapses (legacy reports)", () => {
    expect(siteResourceFixGroups(rule(checks()))).toHaveLength(1);
  });
  test("a page rule is never collapsed, even when message and locator match", () => {
    const grouped = rule(checks(), "page");
    expect(grouped.findingScope).toBe("page");
    expect(siteResourceFixGroups(grouped)).toHaveLength(0);
    expect(grouped.componentFixGroups).toBeUndefined();
  });
});

describe("pageShareTag", () => {
  test("labels, never a ratio", () => {
    expect(pageShareTag(95, 100)).toBe(" (site-wide)");
    expect(pageShareTag(60, 100)).toBe(" (template)");
    expect(pageShareTag(10, 100)).toBe(" (some pages)");
    expect(pageShareTag(1, 100)).toBe(" (single page)");
  });
  test("empty when the crawl size is unknown", () => {
    expect(pageShareTag(5, undefined)).toBe("");
    expect(pageShareTag(5, 0)).toBe("");
  });
});
