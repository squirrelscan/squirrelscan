// pub#846: a finding that sits in a shared page region names the region ("In the site footer, on
// 49 of 53 pages") instead of listing every page. The share is counted against the pages that HAVE
// the region; content findings, findings in a region on few pages, and reports without section
// data keep their page lists.

import { describe, expect, test } from "bun:test";

import type { CheckItem, ReportStructure } from "@squirrelscan/core-contracts";

import {
  REGION_SCOPE_MIN_SHARE,
  checkRegionScope,
  itemRegionScope,
  regionScopeLine,
} from "../src/region-scope";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport, ReportRuleResult } from "../src/types";

const SITE = "https://example.com";
const page = (k: number) => `${SITE}/p${String(k).padStart(2, "0")}`;
const pages = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => page(from + k));

function structure(sections: Record<string, number>, total = 53): ReportStructure {
  return {
    pages: total,
    sections: Object.entries(sections).map(([section, n]) => ({
      section: section as ReportStructure["sections"][number]["section"],
      pages: n,
      links: n * 3,
    })),
    unknownLinks: 0,
    totalLinks: 0,
    chrome: { links: 0, contentLinks: 0, share: null },
    pageTypes: { counts: [], notClassified: 0, byModel: 0, degraded: 0 },
  } as unknown as ReportStructure;
}

const SITE_STRUCTURE = structure({ header: 53, navigation: 53, footer: 52, content: 50, sidebar: 6 });

describe("itemRegionScope", () => {
  const item = (regions: CheckItem["regions"], extra: Partial<CheckItem> = {}): CheckItem => ({
    id: "x",
    sourcePages: pages(0, 10),
    regions,
    ...extra,
  });

  test("scoped at the documented share of the pages with the region, not below", () => {
    expect(REGION_SCOPE_MIN_SHARE).toBe(0.8);
    const s = structure({ footer: 10 });
    expect(itemRegionScope(item({ footer: 8 }), s)).toMatchObject({ region: "footer", pages: 8, regionPages: 10 });
    expect(itemRegionScope(item({ footer: 7 }), s)).toBeUndefined();
  });

  test("the denominator is the pages that have the region, not every page", () => {
    // 33 of the 40 pages with a footer (82%), though only 62% of all 53 pages.
    const s = structure({ footer: 40 }, 53);
    expect(itemRegionScope(item({ footer: 33 }), s)).toMatchObject({ pages: 33, regionPages: 40 });
  });

  test("of two regions that qualify, the one it is on most", () => {
    expect(itemRegionScope(item({ header: 45, footer: 50 }), SITE_STRUCTURE)?.region).toBe("footer");
  });

  test("the page content, a region on one page, and missing data are never scoped", () => {
    expect(itemRegionScope(item({ content: 50 }), SITE_STRUCTURE)).toBeUndefined();
    expect(itemRegionScope(item({ footer: 1 }), structure({ footer: 1 }))).toBeUndefined();
    expect(itemRegionScope(item(undefined), SITE_STRUCTURE)).toBeUndefined();
    expect(itemRegionScope(item({ footer: 50 }), undefined)).toBeUndefined();
  });

  test("a sidebar on a few pages is scoped against those pages", () => {
    expect(itemRegionScope(item({ sidebar: 5 }), SITE_STRUCTURE)).toMatchObject({ region: "sidebar", pages: 5, regionPages: 6 });
  });

  // Template regions beyond the page frame: blocks that recur the same on every page that has them.
  const WIDGETS: [string, string][] = [
    ["breadcrumbs", "In the breadcrumbs"],
    ["pagination", "In the pagination"],
    ["newsletter_signup", "In the newsletter signup"],
    ["social_share", "In the social share links"],
    ["business_info", "In the business details"],
    ["account_login", "In the account links"],
  ];
  for (const [region, lead] of WIDGETS) {
    test(`${region} is a template region, judged against the pages that have it`, () => {
      const s = structure({ [region]: 14, content: 50 });
      const scope = itemRegionScope(item({ [region]: 14 }), s);
      expect(scope).toMatchObject({ region, pages: 14, regionPages: 14 });
      expect(regionScopeLine(scope!)).toBe(`${lead}, on 14 of 14 pages`);
      expect(itemRegionScope(item({ [region]: 11 }), s)).toBeUndefined();
    });
  }

  test("the page content, comments, related content and the author byline are never regions", () => {
    const s = structure({ content: 50, comments: 50, related_content: 50, author_byline: 50 });
    for (const section of ["content", "comments", "related_content", "author_byline"]) {
      expect(itemRegionScope(item({ [section]: 50 }), s)).toBeUndefined();
    }
  });

  test("pages outside the region come from the item's total", () => {
    const scope = itemRegionScope(item({ header: 49, content: 3 }, { pageCount: 52 }), SITE_STRUCTURE);
    expect(scope).toEqual({ region: "header", pages: 49, regionPages: 53, otherPages: 3 });
  });

  test("the line", () => {
    expect(regionScopeLine({ region: "footer", pages: 49, regionPages: 53, otherPages: 0 })).toBe(
      "In the site footer, on 49 of 53 pages",
    );
    expect(regionScopeLine({ region: "header", pages: 49, regionPages: 53, otherPages: 1 })).toBe(
      "In the site header, on 49 of 53 pages, and on 1 other page",
    );
    expect(regionScopeLine({ region: "sidebar", pages: 5, regionPages: 6, otherPages: 3 })).toBe(
      "In the sidebar, on 5 of 6 pages, and on 3 other pages",
    );
  });

  test("a check that only reads one region is scoped to it", () => {
    expect(checkRegionScope({ details: { region: "footer" } }, 50, SITE_STRUCTURE)).toMatchObject({
      region: "footer",
      pages: 50,
      regionPages: 52,
    });
    expect(checkRegionScope({ details: { region: "content" } }, 50, SITE_STRUCTURE)).toBeUndefined();
    expect(checkRegionScope({}, 50, SITE_STRUCTURE)).toBeUndefined();
  });
});

const LINK_TEXT_META: ReportRuleResult["meta"] = {
  id: "a11y/link-text",
  name: "Link Text",
  description: "Links need descriptive text",
  category: "a11y",
  scope: "page",
  severity: "warning",
  weight: 4,
};

/**
 * "read more" in the content of 3 pages and in the header of 49; "click here" in the content of
 * 2 pages. One per-page check per page, as the rule emits them.
 */
function linkTextReport(withStructure = true): AuditReport {
  const checks: ReportRuleResult["checks"] = [];
  for (let k = 0; k < 52; k++) {
    const items: CheckItem[] = [];
    if (k < 3) items.push({ id: "read more", regions: { content: 1 } });
    else items.push({ id: "read more", regions: { header: 1 } });
    if (k < 2) items.push({ id: "click here", regions: { content: 1 } });
    checks.push({
      name: "link-text-generic",
      status: "warn",
      message: "1 link(s) with generic text",
      pageUrl: page(k),
      items,
    });
  }
  return {
    baseUrl: SITE,
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 53,
    passed: 0,
    warnings: 52,
    failed: 0,
    ruleResults: { "a11y/link-text": { meta: LINK_TEXT_META, checks } },
    ...(withStructure ? { structure: SITE_STRUCTURE } : {}),
  };
}

/** One broken link in the footer of 50 pages, linked once from each. */
function footerLinkReport(): AuditReport {
  const sourcePages = pages(0, 50);
  return {
    baseUrl: SITE,
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 53,
    passed: 0,
    warnings: 0,
    failed: 1,
    structure: SITE_STRUCTURE,
    ruleResults: {
      "links/broken-links": {
        meta: { ...LINK_TEXT_META, id: "links/broken-links", name: "Broken Links", category: "links", scope: "site", severity: "error" },
        checks: [
          {
            name: "broken-links",
            status: "fail",
            message: "1 broken internal link(s) (4xx/5xx)",
            items: [
              {
                id: `${SITE}/gone`,
                label: `${SITE}/gone (404), linked in the footer`,
                sourcePages,
                sources: sourcePages.map((p) => ({ page: p, links: 1, sections: { footer: 1 } })),
                regions: { footer: 50 },
              },
            ],
          },
        ],
      },
    },
  };
}

/** A stale copyright year in the footer of 50 pages. */
function copyrightReport(): AuditReport {
  return {
    baseUrl: SITE,
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 53,
    passed: 0,
    warnings: 50,
    failed: 0,
    structure: SITE_STRUCTURE,
    ruleResults: {
      "content/stale-copyright": {
        meta: { ...LINK_TEXT_META, id: "content/stale-copyright", name: "Stale Copyright Year", category: "content", weight: 2 },
        checks: pages(0, 50).map((pageUrl) => ({
          name: "footer-copyright-year",
          status: "warn" as const,
          message: "Footer copyright year is 2023, behind the current year 2026",
          pageUrl,
          value: 2023,
          expected: 2026,
          details: { region: "footer" },
        })),
      },
    },
  };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("grouping counts every page an item is on, once", () => {
  test("past the listed pages, and with the item twice on one page", () => {
    const checks: ReportRuleResult["checks"] = Array.from({ length: 12 }, (_, k) => ({
      name: "link-text-generic",
      status: "warn" as const,
      message: "1 link(s) with generic text",
      pageUrl: page(k),
      items: [
        { id: "read more", regions: { footer: 1 } },
        ...(k === 11 ? [{ id: "read more", regions: { footer: 1 } }] : []),
      ],
    }));
    const report: AuditReport = {
      baseUrl: SITE,
      timestamp: "2026-10-16T00:00:00.000Z",
      totalPages: 12,
      passed: 0,
      warnings: 12,
      failed: 0,
      structure: structure({ footer: 12 }, 12),
      ruleResults: { "a11y/link-text": { meta: LINK_TEXT_META, checks } },
    };
    const json = JSON.parse(renderJson(report));
    const item = json.issues[0].checks[0].items[0];
    expect(item.regions).toEqual({ footer: 12 });
    expect(item.pageCount).toBe(12);
    expect(item.scope).toEqual({ region: "footer", pages: 12, regionPages: 12, otherPages: 0 });
  });
});

describe("scoped findings in each format", () => {
  test("text: the region line, no page list for it, and the other pages still listed", () => {
    const text = renderText(linkTextReport());
    expect(text).toContain("In the site header, on 49 of 53 pages, and on 3 other pages");
    expect(text).toContain("from: /p00 (in the page content)");
    expect(count(text, "-> /p")).toBe(0); // no check-level page list
    expect(count(text, "from: /p")).toBeLessThanOrEqual(5); // 3 "read more" + 2 "click here"
    // A different item keeps its own rows, separately.
    expect(text).toContain("-> click here");
  });

  test("markdown", () => {
    const md = renderMarkdown(linkTextReport());
    expect(md).toContain("  - In the site header, on 49 of 53 pages, and on 3 other pages");
    expect(md).not.toContain("page(s) affected</summary>");
    expect(md).toContain(`  - from: [/p00](${page(0)}) (in the page content)`);
  });

  test("llm", () => {
    const llm = renderLlm(linkTextReport());
    expect(llm).toContain("(in the site header, on 49 of 53 pages, and on 3 other pages; also from: /p00 (in the page content)");
    expect(llm).not.toMatch(/Pages \(52\): \//);
  });

  test("html keeps the pages, collapsed", () => {
    const html = renderHtml(linkTextReport());
    expect(html).toContain("In the site header, on 49 of 53 pages, and on 3 other pages");
    // The check's page list is still there but starts closed.
    expect(html).toMatch(/<details class="mt-1"><summary class="more">52 pages affected<\/summary>/);
  });

  test("json and xml carry the scope beside the bounded page list", () => {
    const json = JSON.parse(renderJson(linkTextReport()));
    const items = json.issues.flatMap((r: { checks: { items?: unknown[] }[] }) => r.checks.flatMap((c) => c.items ?? []));
    const readMore = items.find((i: { id: string }) => i.id === "read more");
    expect(readMore.scope).toEqual({ region: "header", pages: 49, regionPages: 53, otherPages: 3 });
    expect(readMore.sourcePages.length).toBeGreaterThan(0);
    expect(items.find((i: { id: string }) => i.id === "click here").scope).toBeUndefined();
    expect(renderXml(linkTextReport())).toContain('<scope region="header" pages="49" region-pages="53" other-pages="3"/>');
  });

  test("a link in the footer of every page: one line, no rows", () => {
    const report = footerLinkReport();
    const text = renderText(report);
    expect(text).toContain("In the site footer, on 50 of 52 pages");
    expect(count(text, "from: /p")).toBe(0);
    expect(count(text, "-> /p")).toBe(0);
    const html = renderHtml(report);
    // HTML: every page is still in the item, behind a closed details element.
    expect(html).toMatch(/<details class="ind"><summary class="more">All 50 pages<\/summary>/);
  });

  test("a link in the breadcrumbs of every page that has them names the breadcrumbs", () => {
    const sourcePages = pages(0, 14);
    const report: AuditReport = {
      baseUrl: SITE,
      timestamp: "2026-10-16T00:00:00.000Z",
      totalPages: 53,
      passed: 0,
      warnings: 1,
      failed: 0,
      structure: structure({ header: 53, breadcrumbs: 14, content: 50 }),
      ruleResults: {
        "links/redirect-chains": {
          meta: { ...LINK_TEXT_META, id: "links/redirect-chains", name: "Redirect Chains", category: "links", scope: "site" },
          checks: [
            {
              name: "links-to-redirect",
              status: "warn",
              message: "1 link target(s) point to redirecting URLs",
              items: [
                {
                  id: `${SITE}/docs`,
                  label: `${SITE}/docs (301) → ${SITE}/docs/ (200), linked in the breadcrumbs`,
                  sourcePages,
                  sources: sourcePages.map((p) => ({ page: p, links: 1, sections: { breadcrumbs: 1 } })),
                  regions: { breadcrumbs: 14 },
                  meta: { sections: { breadcrumbs: 14 } },
                },
              ],
            },
          ],
        },
      },
    };
    const text = renderText(report);
    expect(text).toContain("In the breadcrumbs, on 14 of 14 pages");
    expect(count(text, "from: /p")).toBe(0);
  });

  test("a scoped item drops its section phrase in every format; an unscoped one keeps it", () => {
    const report = footerLinkReport();
    const items = report.ruleResults["links/broken-links"]!.checks[0]!.items!;
    items[0]!.meta = { statusCode: 404, sections: { footer: 50 } };
    items.push({
      id: `${SITE}/lost`,
      label: `${SITE}/lost (404), linked in the page content`,
      sourcePages: [page(0)],
      sources: [{ page: page(0), links: 1, sections: { content: 1 } }],
      regions: { content: 1 },
      meta: { statusCode: 404, sections: { content: 1 } },
    });
    const text = renderText(report);
    expect(text).toContain(`-> ${SITE}/gone (404)\n`);
    expect(text).not.toContain(`${SITE}/gone (404), linked in the footer`);
    expect(text).toContain(`-> ${SITE}/lost (404), linked in the page content`);
    const md = renderMarkdown(report);
    expect(md).toContain(`- [${SITE}/gone (404)](${SITE}/gone)`);
    expect(md).toContain("linked in the page content");
    expect(renderHtml(report)).not.toContain("gone (404), linked in the footer");
    expect(renderLlm(report)).not.toContain("gone (404), linked in the footer");
    expect(renderXml(report)).toContain(`<label>${SITE}/gone (404)</label>`);
    const json = JSON.parse(renderJson(report));
    expect(json.issues[0].checks[0].items[0].label).toBe(`${SITE}/gone (404)`);
    expect(json.issues[0].checks[0].items[1].label).toBe(`${SITE}/lost (404), linked in the page content`);
  });

  test("a check that only reads the footer names it once", () => {
    const text = renderText(copyrightReport());
    expect(text).toContain("In the site footer, on 50 of 52 pages");
    expect(count(text, "-> /p")).toBe(0);
    expect(renderMarkdown(copyrightReport())).toContain("In the site footer, on 50 of 52 pages");
    const json = JSON.parse(renderJson(copyrightReport()));
    expect(json.issues[0].checks[0].scope).toEqual({ region: "footer", pages: 50, regionPages: 52, otherPages: 0 });
  });

  test("without section data the report keeps today's page lists", () => {
    const text = renderText(linkTextReport(false));
    expect(text).not.toContain("In the site");
    expect(text).toContain("-> /p00");
  });
});

describe("a finding that carries pages from an earlier audit is never scoped to a region (pub#860)", () => {
  /** The `linkTextReport`, with the last seven pages' checks carried from an earlier audit. */
  function carriedReport(): AuditReport {
    const report = linkTextReport();
    const rule = report.ruleResults["a11y/link-text"]!;
    rule.checks = rule.checks.map((c, k) => (k >= 45 ? { ...c, provenance: "carried" as const, lastSeenAt: 1 } : c));
    return report;
  }
  const REGION_LINE = /In the site header, on \d+ of \d+ pages/i;

  test("the helpers refuse an item or a check of a carried finding", () => {
    const item: CheckItem = { id: "x", sourcePages: pages(0, 10), regions: { footer: 10 } };
    const s = structure({ footer: 10 });
    expect(itemRegionScope(item, s)).toMatchObject({ region: "footer" });
    expect(itemRegionScope(item, s, { carriedCount: 3 })).toBeUndefined();
    expect(itemRegionScope(item, s, { carriedPages: [page(1)] })).toBeUndefined();
    expect(itemRegionScope(item, s, { provenance: "carried" })).toBeUndefined();
    expect(itemRegionScope(item, s, { carriedPages: [] })).toMatchObject({ region: "footer" });
    expect(checkRegionScope({ details: { region: "footer" }, carriedCount: 2 }, 50, SITE_STRUCTURE)).toBeUndefined();
  });

  test("fresh pages only still read as before (control)", () => {
    expect(renderText(linkTextReport())).toMatch(REGION_LINE);
  });

  test("text, markdown, llm, html, json and xml keep the page rows instead of a region share", () => {
    const report = carriedReport();
    expect(renderText(report)).not.toMatch(REGION_LINE);
    expect(renderMarkdown(report)).not.toMatch(REGION_LINE);
    expect(renderLlm(report)).not.toMatch(/in the site header, on \d+ of \d+ pages/);
    expect(renderHtml(report)).not.toMatch(REGION_LINE);
    expect(renderXml(report)).not.toContain("<scope region=");
    const json = JSON.parse(renderJson(report));
    const items = json.issues.flatMap((r: { checks: { items?: unknown[] }[] }) => r.checks.flatMap((c) => c.items ?? []));
    expect(items.some((i: { scope?: unknown }) => i.scope !== undefined)).toBe(false);
    // and the pages are listed, as for any unscoped finding
    expect(renderText(report)).toContain("-> /p");
  });
});
