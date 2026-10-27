// Grouping is the whole claim this feature makes, so these pin the shape of
// the claim rather than the wording: which pages a unit says it covers, and
// which resources it says are one repair.

import { describe, expect, test } from "bun:test";
import type { CheckResult, ReportRuleResult, SiteResourceOccurrence } from "../src/types";
import { groupIssuesByCategory } from "../src/grouping";
import { siteResourceFixGroups } from "../src/site-resource-fix-groups";
import { ruleSiteResourceCoverage } from "../src/site-resource-presentation";

const ORIGIN = "https://example.test";

function occurrence(
  pageUrl: string,
  key: string,
  overrides: Partial<SiteResourceOccurrence> = {},
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

function check(pageUrl: string, occurrences: SiteResourceOccurrence[]): CheckResult {
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
function rule(checks: CheckResult[]) {
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
    },
    checks,
  } as unknown as ReportRuleResult;
  const categories = groupIssuesByCategory({ "perf/source-maps": ruleResult });
  return categories[0]!.rules[0]!;
}

const SHARED = [`${ORIGIN}/assets/app.js.map`, `${ORIGIN}/assets/vendor.js.map`];
const PAGES = [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/pricing`];

describe("a shared bundle is one unit", () => {
  test("every page carrying the same maps collapses to a single group", () => {
    const groups = siteResourceFixGroups(
      rule(PAGES.map((page) => check(page, SHARED.map((key) => occurrence(page, key))))),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.resourceKeys).toEqual(SHARED);
    expect(groups[0]!.affectedPageCount).toBe(3);
    expect(groups[0]!.affectedPages).toEqual(PAGES);
  });

  test("the page count is exact, not the bounded item sample", () => {
    // 24 pages is past every page/item sample this report stage applies, so a
    // count taken from a sample would come back smaller than 24.
    const pages = Array.from({ length: 24 }, (_, i) => `${ORIGIN}/p${i}`);
    const groups = siteResourceFixGroups(
      rule(pages.map((page) => check(page, SHARED.map((key) => occurrence(page, key))))),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.affectedPageCount).toBe(24);
    expect(groups[0]!.affectedPages).toHaveLength(24);
  });
});

describe("a section bundle is its own unit", () => {
  const sectionKey = `${ORIGIN}/assets/blog.js.map`;
  const checks = [
    check(PAGES[0]!, SHARED.map((key) => occurrence(PAGES[0]!, key))),
    check(PAGES[1]!, [
      ...SHARED.map((key) => occurrence(PAGES[1]!, key)),
      occurrence(PAGES[1]!, sectionKey),
    ]),
    check(PAGES[2]!, [
      ...SHARED.map((key) => occurrence(PAGES[2]!, key)),
      occurrence(PAGES[2]!, sectionKey),
    ]),
  ];

  test("the subset gets its own group and its own exact count", () => {
    const groups = siteResourceFixGroups(rule(checks));
    expect(groups).toHaveLength(2);
    // Widest reach first.
    expect(groups[0]!.resourceKeys).toEqual(SHARED);
    expect(groups[0]!.affectedPageCount).toBe(3);
    expect(groups[1]!.resourceKeys).toEqual([sectionKey]);
    expect(groups[1]!.affectedPageCount).toBe(2);
    expect(groups[1]!.affectedPages).toEqual([PAGES[1]!, PAGES[2]!]);
  });

  test("the section unit does not absorb the site-wide pages", () => {
    const groups = siteResourceFixGroups(rule(checks));
    expect(groups[1]!.affectedPages).not.toContain(PAGES[0]!);
  });
});

describe("a map on one page stays page-level", () => {
  const onlyKey = `${ORIGIN}/assets/one-off.js.map`;
  const groups = siteResourceFixGroups(
    rule([
      check(PAGES[0]!, [occurrence(PAGES[0]!, SHARED[0]!), occurrence(PAGES[0]!, onlyKey)]),
      check(PAGES[1]!, [occurrence(PAGES[1]!, SHARED[0]!)]),
    ]),
  );

  test("it forms a one-page group", () => {
    const solo = groups.find((group) => group.resourceKeys.includes(onlyKey));
    expect(solo!.affectedPageCount).toBe(1);
  });

  test("and that group is never rendered", () => {
    const coverage = ruleSiteResourceCoverage(
      rule([
        check(PAGES[0]!, [occurrence(PAGES[0]!, SHARED[0]!), occurrence(PAGES[0]!, onlyKey)]),
        check(PAGES[1]!, [occurrence(PAGES[1]!, SHARED[0]!)]),
      ]),
    );
    expect(coverage.groups.map((g) => g.resourceKeys)).toEqual([[SHARED[0]!]]);
    expect(coverage.allGroups).toHaveLength(2);
    // The one-page map's page is NOT claimed as covered, so its legacy lines
    // survive and the defect is still stated somewhere.
    expect(coverage.coveredPages.has(PAGES[0]!)).toBe(false);
  });
});

describe("the grouping does not depend on arrival order", () => {
  test("reversing the pages and the keys yields identical groups", () => {
    const forward = siteResourceFixGroups(
      rule(PAGES.map((page) => check(page, SHARED.map((key) => occurrence(page, key))))),
    );
    const reversed = siteResourceFixGroups(
      rule(
        [...PAGES]
          .reverse()
          .map((page) => check(page, [...SHARED].reverse().map((key) => occurrence(page, key)))),
      ),
    );
    expect(reversed).toEqual(forward);
  });
});

describe("two origins are two builds", () => {
  test("identical map paths on another origin do not merge", () => {
    const other = "https://cdn.example.test";
    const groups = siteResourceFixGroups(
      rule([
        check(PAGES[0]!, [occurrence(PAGES[0]!, `${ORIGIN}/a.js.map`)]),
        check(PAGES[1]!, [occurrence(PAGES[1]!, `${ORIGIN}/a.js.map`)]),
        check(`${other}/x`, [
          occurrence(`${other}/x`, `${other}/a.js.map`, { siteOrigin: other }),
        ]),
        check(`${other}/y`, [
          occurrence(`${other}/y`, `${other}/a.js.map`, { siteOrigin: other }),
        ]),
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.siteOrigin))).toEqual(new Set([ORIGIN, other]));
  });
});

describe("a rule with no resource evidence", () => {
  test("produces no groups and claims no coverage", () => {
    const legacy = rule([
      {
        name: "source-maps-exposed",
        status: "warn",
        message: "2 potential source map(s) detected",
        pageUrl: PAGES[0]!,
        pages: [PAGES[0]!],
        items: SHARED.map((key) => ({ id: key })),
      } as unknown as CheckResult,
    ]);
    expect(siteResourceFixGroups(legacy)).toEqual([]);
    const coverage = ruleSiteResourceCoverage(legacy);
    expect(coverage.groups).toEqual([]);
    expect(coverage.coveredPages.size).toBe(0);
  });
});

describe("a second check on the same pages is not swallowed", () => {
  test("a page carrying an uncovered inline finding stays uncovered", () => {
    const withInline = rule([
      ...PAGES.map((page) => check(page, SHARED.map((key) => occurrence(page, key)))),
      {
        name: "source-maps-inline",
        status: "warn",
        message: "1 inline source map(s) found",
        pageUrl: PAGES[0]!,
        pages: [PAGES[0]!],
      } as unknown as CheckResult,
    ]);
    const coverage = ruleSiteResourceCoverage(withInline);
    expect(coverage.groups).toHaveLength(1);
    // The exposed unit names all three pages, but page 0 also carries an inline
    // finding no unit accounts for, so it must not be reported as covered.
    expect(coverage.coveredPages.has(PAGES[0]!)).toBe(false);
    expect(coverage.coveredPages.has(PAGES[1]!)).toBe(true);
  });
});
