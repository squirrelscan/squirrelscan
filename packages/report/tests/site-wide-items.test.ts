// Site-wide item collapse. The survey behind it found the dominant collapsible
// pattern is not a DOM component but one shared resource repeated on nearly
// every page, so the collapse keys on the item's own sourcePages.

import { describe, expect, test } from "bun:test";
import type { AuditReport, CheckItem, CheckResult, ReportRuleResult } from "../src/types";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { SITE_WIDE_MIN_PAGES, siteWideItem } from "../src/site-wide-items";

/** Markdown output with its backslash escapes undone, to compare wording with the other formats (3522). */
const plain = (markdown: string): string => markdown.replace(/\\([\\`*_[\]()<>|~&!#+=-])/g, "$1");

const SITE = "https://example.test";
const pageUrl = (i: number) => `${SITE}/p${i}`;

function report(items: CheckItem[], totalPages: number, withPageList = true): AuditReport {
  const check: CheckResult = {
    name: "contrast", status: "warn", message: `${items.length} item(s)`, items,
  };
  const rule: ReportRuleResult = {
    meta: {
      id: "a11y/color-contrast", name: "Colour contrast", description: "desc", solution: "sol",
      category: "accessibility", scope: "page", severity: "warning", weight: 1,
    },
    checks: [check],
  };
  return {
    baseUrl: SITE, timestamp: "2026-09-19T00:00:00.000Z", totalPages,
    ...(withPageList
      ? { pages: Array.from({ length: totalPages }, (_, i) => ({ url: pageUrl(i) })) }
      : {}),
    passed: 0, warnings: 1, failed: 0, ruleResults: { "a11y/color-contrast": rule },
    healthScore: { overall: 80, categories: [], groups: [], errorCount: 0, warningCount: 1, passedCount: 0 },
  } as unknown as AuditReport;
}

/** An item present on the first `n` of `total` pages. */
function item(id: string, n: number): CheckItem {
  return { id, sourcePages: Array.from({ length: n }, (_, i) => pageUrl(i)) };
}

describe("threshold edges", () => {
  test("80% of pages collapses, 79% does not", () => {
    // 100 pages: 80 is exactly the ratio, 79 is one short.
    expect(siteWideItem(item("x", 80), 100)).toMatchObject({ pages: 80, of: 100 });
    expect(siteWideItem(item("x", 79), 100)).toBeUndefined();
  });

  test("3 pages collapses, 2 does not, however high the ratio", () => {
    // Both are 100% of the site; only the page floor separates them.
    expect(siteWideItem(item("x", SITE_WIDE_MIN_PAGES), SITE_WIDE_MIN_PAGES)).toMatchObject({
      pages: 3,
      of: 3,
    });
    expect(siteWideItem(item("x", 2), 2)).toBeUndefined();
  });

  test("an item with no sourcePages is never site-wide", () => {
    expect(siteWideItem({ id: "x" }, 100)).toBeUndefined();
  });

  test("a link that carries its own per-page sources is never site-wide", () => {
    // pub#837/#846: its rows, or one region line, already say where it sits.
    const link: CheckItem = {
      ...item("x", 100),
      sources: [{ page: pageUrl(0), links: 1, sections: { footer: 1 } }],
    };
    expect(siteWideItem(link, 100)).toBeUndefined();
  });

  test("duplicate sourcePages do not inflate the count", () => {
    const duplicated: CheckItem = { id: "x", sourcePages: [pageUrl(0), pageUrl(0), pageUrl(1)] };
    expect(siteWideItem(duplicated, 3)).toBeUndefined();
  });
});

describe("rendering", () => {
  const collapsible = report([item("#aaa on #bbb", 41)], 45);

  test("llm, text and markdown each state the ratio and drop the page list", () => {
    for (const out of [renderLlm(collapsible), renderText(collapsible), plain(renderMarkdown(collapsible))]) {
      expect(out).toContain("Site-wide (41 of 45 pages): #aaa on #bbb");
      // The collapsed list is the whole point: no per-page "from:" lines.
      expect(out).not.toContain("from: /p7");
    }
  });

  test("llm says how many items it leaves out when site-wide lines used the whole budget", () => {
    // 5 site-wide lines fill the 5-item budget; the ordinary item has no slot left.
    const items = [
      ...Array.from({ length: 5 }, (_, i) => item(`shared-${i}`, 41)),
      item("only-here", 2),
    ];
    const out = renderLlm(report(items, 45));
    expect(out).toContain("Items (0/1): none listed");
    expect(out).not.toContain("only-here");
  });

  test("a near-miss names the pages it misses", () => {
    const out = renderText(report([item("#aaa on #bbb", 43)], 45));
    expect(out).toContain("Site-wide (43 of 45 pages): #aaa on #bbb (except: /p43, /p44)");
  });

  test("too many missing pages to name leaves the exception list off", () => {
    const out = renderText(report([item("#aaa on #bbb", 40)], 45));
    expect(out).toContain("Site-wide (40 of 45 pages): #aaa on #bbb");
    expect(out).not.toContain("except:");
  });

  test("an incomplete page list yields no exception list rather than wrong pages", () => {
    // A reimported slim report carries `pages: []`; naming exceptions from it
    // would name pages that were never checked against the item.
    const out = renderText(report([item("#aaa on #bbb", 43)], 45, false));
    expect(out).toContain("Site-wide (43 of 45 pages): #aaa on #bbb");
    expect(out).not.toContain("except:");
  });
});

describe("below threshold and empty reports are untouched", () => {
  test("a 2-page item renders exactly as before", () => {
    const below = report([item("#aaa on #bbb", 2)], 45);
    expect(renderText(below)).toContain("from: /p0");
    expect(renderText(below)).not.toContain("Site-wide");
  });

  test("a report with no items is byte-identical with and without the feature", () => {
    // Nothing to collapse must mean nothing changes, in every format.
    const noItems = report([], 45);
    for (const render of [renderLlm, renderText, renderMarkdown]) {
      const out = render(noItems);
      expect(out).not.toContain("Site-wide");
      expect(out).toBe(render(noItems));
    }
  });
});

describe("no double reporting alongside component fix groups", () => {
  // A check whose pages are fully attributed to a printed fix group already
  // says everything; its items are suppressed, so a site-wide line there would
  // be the same defect stated twice.
  function withGroup(itemPages: number, totalPages: number): AuditReport {
    const pages = Array.from({ length: 3 }, (_, i) => pageUrl(i));
    const occurrence = (page: string) => ({
      version: 1 as const,
      pageUrl: page,
      siteOrigin: SITE,
      provenance: { source: "page-dom" as const, rendered: true },
      groupable: true,
      confidence: "observed" as const,
      region: { role: "footer" as const, nestedIn: "none" as const, structuralSignature: "s128:r" },
      family: { key: "s128:f", structuralSignature: "s128:f" },
      variant: { key: "s128:v", structuralSignature: "s128:v", contentHash: "s128:c" },
      element: { locator: "footer:1>footer>a:1", structuralSignature: "s128:e" },
      defect: {
        kind: "link-text-generic" as const,
        values: { normalizedText: "read more" },
        valueHashes: {},
      },
    });
    const checks: CheckResult[] = pages.map((page) => ({
      name: "generic-link-text",
      status: "warn",
      message: "1 link(s) with generic text",
      pageUrl: page,
      pages: [page],
      items: [item("read more", itemPages)],
      componentOccurrences: [occurrence(page)],
    }));
    const rule: ReportRuleResult = {
      meta: {
        id: "a11y/link-text", name: "Link text", description: "d", solution: "s",
        category: "accessibility", scope: "page", severity: "warning", weight: 1,
      },
      checks,
    };
    return {
      baseUrl: SITE, timestamp: "2026-09-19T00:00:00.000Z", totalPages,
      pages: Array.from({ length: totalPages }, (_, i) => ({ url: pageUrl(i) })),
      passed: 0, warnings: checks.length, failed: 0, ruleResults: { "a11y/link-text": rule },
      healthScore: { overall: 80, categories: [], groups: [], errorCount: 0, warningCount: 1, passedCount: 0 },
    } as unknown as AuditReport;
  }

  test("a fully covered check prints the group and no site-wide line", () => {
    const out = renderText(withGroup(3, 3));
    expect(out).toContain("Fix once in the site footer");
    expect(out).not.toContain("Site-wide");
  });
});

describe("JSON keeps everything and adds a machine-readable flag", () => {
  test("items and sourcePages survive, flagged with the ratio", () => {
    const json = JSON.parse(renderJson(report([item("#aaa on #bbb", 41), item("#ccc", 2)], 45)));
    const items = json.issues[0].checks[0].items;
    expect(items).toHaveLength(2);
    // Nothing is dropped: the collapse is presentation only.
    expect(items[0].sourcePages).toHaveLength(41);
    expect(items[0].siteWide).toEqual({ pages: 41, of: 45 });
    expect(items[1].sourcePages).toHaveLength(2);
    expect(items[1].siteWide).toBeUndefined();
  });
});
