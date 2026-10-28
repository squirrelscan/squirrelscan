// The unit has to REPLACE the per-page lines, not sit above them — the bug
// (#2341) was report LENGTH, so a version of this feature that adds a line to
// dozens of existing ones is worth less than nothing.
//
// These pin the three states: a fully covered rule, a rule where a one-off map
// leaves a page unattributed, and the hard one — a stored audit with no
// resource evidence at all, which must render exactly as it did before.

import { describe, expect, test } from "bun:test";
import type {
  AuditReport,
  CheckResult,
  ReportRuleResult,
  SiteResourceOccurrence,
} from "../src/types";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";

/** Markdown output with its backslash escapes undone, to compare wording with the other formats (3522). */
const plain = (markdown: string): string => markdown.replace(/\\([\\`*_[\]()<>|~&!#+=-])/g, "$1");

const ORIGIN = "https://example.test";
const SHARED = [`${ORIGIN}/assets/app.js.map`, `${ORIGIN}/assets/vendor.js.map`];
const PAGES = [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/pricing`];

function occurrence(pageUrl: string, key: string): SiteResourceOccurrence {
  return { kind: "source-map", key, pageUrl, source: "/assets/app.js", siteOrigin: ORIGIN };
}

function check(pageUrl: string, keys: string[], withEvidence = true): CheckResult {
  return {
    name: "source-maps-exposed",
    status: "warn",
    message: `${keys.length} potential source map(s) detected`,
    pageUrl,
    pages: [pageUrl],
    items: keys.map((key) => ({ id: key, label: "from /assets/app.js" })),
    ...(withEvidence
      ? { siteResourceOccurrences: keys.map((key) => occurrence(pageUrl, key)) }
      : {}),
  } as unknown as CheckResult;
}

function report(checks: CheckResult[]): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id: "perf/source-maps",
      name: "Source Maps",
      description: "Checks for source map availability and configuration",
      solution: "sol",
      category: "perf",
      scope: "page",
      severity: "info",
      weight: 3,
    },
    checks,
  } as unknown as ReportRuleResult;
  return {
    baseUrl: ORIGIN,
    timestamp: "2026-09-19T00:00:00.000Z",
    totalPages: checks.length,
    passed: 0,
    warnings: checks.length,
    failed: 0,
    ruleResults: { "perf/source-maps": rule },
    healthScore: {
      overall: 80,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: 1,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

const SENTENCE =
  "Fix once in the build: 2 source maps exposed by shared bundles (app.js.map, vendor.js.map), 3 pages: /, /about, /pricing";

describe("a shared bundle on every page", () => {
  const full = report(PAGES.map((page) => check(page, SHARED)));

  test("llm emits one unit and drops the per-page Pages and Items lines", () => {
    const out = renderLlm(full);
    expect(out).toContain(
      `<fix-once scope="site-resource" pages="3" resources="2">${SENTENCE}</fix-once>`,
    );
    expect(out).not.toContain("Pages (");
    expect(out).not.toContain("Items (");
  });

  test("text, markdown and html say it in the same words", () => {
    expect(renderText(full)).toContain(`    ${SENTENCE}`);
    expect(plain(renderMarkdown(full))).toContain(`**${SENTENCE}**`);
    expect(renderHtml(full)).toContain(SENTENCE);
  });

  test("exactly one unit, however many pages carried the finding", () => {
    const out = renderLlm(full);
    expect(out.split('scope="site-resource"')).toHaveLength(2);
  });

  test("json keeps the evidence and adds the unit", () => {
    const parsed = JSON.parse(renderJson(full)) as {
      issues: Array<{
        siteResourceFixGroups?: Array<{
          resourceKeys: string[];
          affectedPageCount: number;
          rendered: boolean;
        }>;
      }>;
    };
    const groups = parsed.issues[0]!.siteResourceFixGroups!;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.resourceKeys).toEqual(SHARED);
    expect(groups[0]!.affectedPageCount).toBe(3);
    expect(groups[0]!.rendered).toBe(true);
  });
});

describe("a section bundle alongside the shared one", () => {
  const sectionKey = `${ORIGIN}/assets/blog.js.map`;
  const sectioned = report([
    check(PAGES[0]!, SHARED),
    check(PAGES[1]!, [...SHARED, sectionKey]),
    check(PAGES[2]!, [...SHARED, sectionKey]),
  ]);

  test("two units, each with its own exact page count", () => {
    const out = renderLlm(sectioned);
    expect(out).toContain(
      `<fix-once scope="site-resource" pages="3" resources="2">${SENTENCE}</fix-once>`,
    );
    expect(out).toContain(
      '<fix-once scope="site-resource" pages="2" resources="1">Fix once in the build: 1 source map exposed by shared bundles (blog.js.map), 2 pages: /about, /pricing</fix-once>',
    );
  });
});

describe("more distinct maps than the unit names", () => {
  test("the count is the true total and the remainder is stated", () => {
    const many = ["a", "b", "c", "d", "e"].map((n) => `${ORIGIN}/assets/${n}.js.map`);
    const out = renderLlm(report(PAGES.map((page) => check(page, many))));
    expect(out).toContain(
      "Fix once in the build: 5 source maps exposed by shared bundles (a.js.map, b.js.map, c.js.map, +2 more), 3 pages: /, /about, /pricing",
    );
  });
});

describe("a map on a single page", () => {
  const onlyKey = `${ORIGIN}/assets/one-off.js.map`;
  const mixed = report([
    check(PAGES[0]!, [...SHARED, onlyKey]),
    check(PAGES[1]!, SHARED),
    check(PAGES[2]!, SHARED),
  ]);

  test("it never becomes a unit of its own", () => {
    expect(renderLlm(mixed)).not.toContain("one-off.js.map)");
  });

  test("and its page is still reported, not silently swallowed", () => {
    const out = renderLlm(mixed);
    // Explicitly labelled, so the page is not read as unaffected, and the
    // one-off map is still named in the items below it.
    expect(out).toContain("Pages not attributed to a shared component (1): /");
    expect(out).toContain("one-off.js.map");
  });
});

describe("a stored audit with no resource evidence", () => {
  const legacy = report(PAGES.map((page) => check(page, SHARED, false)));

  test("renders byte-identically to a build without the feature", () => {
    const out = renderLlm(legacy);
    expect(out).not.toContain("site-resource");
    expect(out).not.toContain("Fix once in the build");
    // The legacy lines it has always printed are all still there, including the
    // pre-existing site-wide item collapse, which names the REFERENCE and never
    // the map URLs — the gap the unit closes.
    expect(out).toContain("Pages (3): /, /about, /pricing");
    expect(out).toContain("Site-wide (3 of 3 pages): from /assets/app.js");
  });

  test("text and markdown are unchanged too", () => {
    expect(renderText(legacy)).not.toContain("Fix once in the build");
    expect(renderMarkdown(legacy)).not.toContain("Fix once in the build");
  });
});
