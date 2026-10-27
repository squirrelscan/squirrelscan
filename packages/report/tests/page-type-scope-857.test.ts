// pub#857: a finding on every page of one page type says so ("On all 9 documentation pages")
// instead of listing the pages. The share is counted against the audited pages of THAT type
// (`structure.pageTypes.counts`), at least two pages are needed, and anything else, mixed types,
// a report with no structure, a label from another rule, keeps today's page rows.

import { describe, expect, test } from "bun:test";

import type { ReportStructure } from "@squirrelscan/core-contracts";

import {
  PAGE_TYPE_SCOPE_MIN_PAGES,
  PAGE_TYPE_SCOPE_MIN_SHARE,
  PAGE_TYPE_SCOPE_SOURCE,
  checkPageTypeScope,
  pageTypeScopeLine,
} from "../src/page-type-scope";
import { checkPagesScopedAway, checkScopeLine } from "../src/region-scope";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport, ReportRuleResult } from "../src/types";

const SITE = "https://example.com";

function structure(
  counts: Array<[label: string, pages: number]>,
  extra: { notClassified?: number } = {},
): ReportStructure {
  const total = counts.reduce((sum, [, n]) => sum + n, 0) + (extra.notClassified ?? 0);
  return {
    pages: total,
    sections: [],
    unknownLinks: 0,
    totalLinks: 0,
    chrome: { links: 0, contentLinks: 0, share: null },
    pageTypes: {
      counts: counts.map(([label, pages]) => ({ label, pages })),
      notClassified: extra.notClassified ?? 0,
      byModel: total,
      degraded: 0,
    },
  } as unknown as ReportStructure;
}

const typed = (pageType: string, extra: Record<string, unknown> = {}) => ({
  details: { pageType, pageTypeSource: PAGE_TYPE_SCOPE_SOURCE, ...extra },
});

describe("checkPageTypeScope", () => {
  test("the documented thresholds", () => {
    expect(PAGE_TYPE_SCOPE_MIN_SHARE).toBe(0.8);
    expect(PAGE_TYPE_SCOPE_MIN_PAGES).toBe(2);
  });

  test("scoped at the share of the pages of the type, not below", () => {
    const s = structure([["docs", 10]]);
    expect(checkPageTypeScope(typed("docs"), 8, s)).toEqual({ pageType: "docs", pages: 8, typePages: 10 });
    expect(checkPageTypeScope(typed("docs"), 7, s)).toBeUndefined();
    expect(checkPageTypeScope(typed("docs"), 10, s)).toEqual({ pageType: "docs", pages: 10, typePages: 10 });
  });

  test("the denominator is the pages of the type, not every audited page", () => {
    // 9 of the 9 documentation pages, though only 9 of the 60 pages the audit saw.
    const s = structure([["docs", 9], ["article", 40]], { notClassified: 11 });
    expect(checkPageTypeScope(typed("docs"), 9, s)).toEqual({ pageType: "docs", pages: 9, typePages: 9 });
  });

  test("two pages are the least that is scoped", () => {
    const s = structure([["contact", 2], ["docs", 1]]);
    expect(checkPageTypeScope(typed("contact"), 2, s)).toMatchObject({ pages: 2, typePages: 2 });
    expect(checkPageTypeScope(typed("docs"), 1, s)).toBeUndefined();
    expect(checkPageTypeScope(typed("docs"), 0, s)).toBeUndefined();
  });

  test("a check on more pages than the report counts of the type is not scoped: never an all the numbers do not back", () => {
    expect(checkPageTypeScope(typed("docs"), 9, structure([["docs", 8]]))).toBeUndefined();
  });

  test("no structure, no count for the type, or a type only counted as not classified", () => {
    expect(checkPageTypeScope(typed("docs"), 9, undefined)).toBeUndefined();
    expect(checkPageTypeScope(typed("docs"), 9, structure([["article", 9]]))).toBeUndefined();
    expect(checkPageTypeScope(typed("docs"), 9, structure([], { notClassified: 9 }))).toBeUndefined();
    expect(checkPageTypeScope(typed("docs"), 9, { pageTypes: undefined } as unknown as ReportStructure)).toBeUndefined();
  });

  test("a check that does not name a classifier page type is never scoped", () => {
    const s = structure([["docs", 9]]);
    expect(checkPageTypeScope({}, 9, s)).toBeUndefined();
    expect(checkPageTypeScope({ details: { pageType: "docs" } }, 9, s)).toBeUndefined();
    // Another rule's `pageType` is a schema and URL based guess in a different label space.
    expect(checkPageTypeScope({ details: { pageType: "docs", pageTypeSource: "schema" } }, 9, s)).toBeUndefined();
    expect(checkPageTypeScope({ details: { pageType: 7, pageTypeSource: "model" } }, 9, s)).toBeUndefined();
  });

  test("a label that is not plain lowercase words never reaches an output", () => {
    for (const label of ["Docs", "<b>x</b>", "docs pages", "", "a".repeat(41)]) {
      expect(checkPageTypeScope(typed(label), 9, structure([[label, 9]]))).toBeUndefined();
    }
  });
});

describe("pageTypeScopeLine", () => {
  test("all, and some", () => {
    expect(pageTypeScopeLine({ pageType: "docs", pages: 9, typePages: 9 })).toBe("On all 9 documentation pages");
    expect(pageTypeScopeLine({ pageType: "docs", pages: 9, typePages: 11 })).toBe("On 9 of 11 documentation pages");
  });

  test.each([
    ["docs", "documentation pages"],
    ["product_detail", "product pages"],
    ["product_listing", "product listings"],
    ["article", "articles"],
    ["blog_post", "blog posts"],
    ["contact", "contact pages"],
    ["about", "about pages"],
    ["listing_index", "listing pages"],
  ])("%s reads as %s", (label, plural) => {
    expect(pageTypeScopeLine({ pageType: label, pages: 4, typePages: 4 })).toBe(`On all 4 ${plural}`);
    expect(pageTypeScopeLine({ pageType: label, pages: 4, typePages: 5 })).toBe(`On 4 of 5 ${plural}`);
  });

  test("a label this version has no wording for reads as its own words", () => {
    expect(pageTypeScopeLine({ pageType: "event_page", pages: 3, typePages: 3 })).toBe("On all 3 event page pages");
  });

  test("large counts are grouped", () => {
    expect(pageTypeScopeLine({ pageType: "product_detail", pages: 1204, typePages: 1500 })).toBe(
      "On 1,204 of 1,500 product pages",
    );
  });
});

const MESSAGE_DOCS =
  "Reads as a documentation page but declares no Article, TechArticle, HowTo or FAQPage structured data";
const MESSAGE_CONTACT = "Reads as a contact page but declares no ContactPage or Organization structured data";

const META: ReportRuleResult["meta"] = {
  id: "schema/expected-type",
  name: "Expected schema for page type",
  description: "Flags a page that declares none of the structured data its type should carry",
  category: "schema",
  scope: "page",
  severity: "warning",
  weight: 5,
};

const docsPage = (k: number) => `${SITE}/docs/page-${String(k).padStart(2, "0")}`;
const contactPage = (k: number) => `${SITE}/contact-${k}`;

/** Per-page checks as the rule emits them: nine documentation pages and two contact pages. */
function expectedTypeReport(
  structureOverride: ReportStructure | undefined,
  docsPages = 9,
): AuditReport {
  const checks: ReportRuleResult["checks"] = [];
  for (let k = 0; k < docsPages; k++) {
    checks.push({
      name: "expected-type",
      status: "fail",
      message: MESSAGE_DOCS,
      pageUrl: docsPage(k),
      details: { pageType: "docs", pageTypeSource: "model", confidence: 0.93 + (k % 5) / 100, expected: "Article" },
    });
  }
  for (let k = 0; k < 2; k++) {
    checks.push({
      name: "expected-type",
      status: "fail",
      message: MESSAGE_CONTACT,
      pageUrl: contactPage(k),
      details: { pageType: "contact", pageTypeSource: "model", confidence: 0.99, expected: "ContactPage or Organization" },
    });
  }
  return {
    baseUrl: SITE,
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 54,
    passed: 0,
    warnings: 0,
    failed: checks.length,
    ruleResults: { "schema/expected-type": { meta: META, checks } },
    ...(structureOverride ? { structure: structureOverride } : {}),
  };
}

const SCOPED = structure([["docs", 9], ["contact", 2], ["article", 22]], { notClassified: 21 });
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("a scoped check in each format", () => {
  test("text: one line per page type, the message kept, no page rows", () => {
    const text = renderText(expectedTypeReport(SCOPED));
    expect(text).toContain(MESSAGE_DOCS);
    expect(text).toContain("        On all 9 documentation pages");
    expect(text).toContain("        On all 2 contact pages");
    expect(count(text, "-> /docs/")).toBe(0);
    expect(count(text, "-> /contact-")).toBe(0);
  });

  test("markdown", () => {
    const md = renderMarkdown(expectedTypeReport(SCOPED));
    expect(md).toContain("**expected-type:** On all 9 documentation pages");
    expect(md).toContain("**expected-type:** On all 2 contact pages");
    expect(md).not.toContain("/docs/page-");
    expect(md).not.toContain("/contact-0");
    expect(md).toContain(MESSAGE_DOCS);
  });

  test("llm lists no pages for it", () => {
    const llm = renderLlm(expectedTypeReport(SCOPED));
    expect(llm).toContain("On all 9 documentation pages");
    expect(llm).toContain("On all 2 contact pages");
    expect(llm).not.toContain("/docs/page-");
    expect(llm).toMatch(/Pages \(11\)/);
  });

  test("llm: a scoped check keeps its line when another check of the rule is not scoped, and only the open pages are listed", () => {
    // Documentation at 9 of 9 is scoped; contact at 2 of 5 is below the share and keeps its pages.
    const llm = renderLlm(expectedTypeReport(structure([["docs", 9], ["contact", 5]])));
    expect(llm).toContain("On all 9 documentation pages");
    expect(llm).not.toContain("/docs/page-");
    expect(llm).not.toContain("On all 2 contact pages");
    expect(llm).toMatch(/Pages \(2\): .*\/contact-0/);
  });

  test("html names the type and keeps every page, collapsed", () => {
    const html = renderHtml(expectedTypeReport(SCOPED));
    expect(html).toContain("On all 9 documentation pages");
    expect(html).toMatch(/<details class="mt-1"><summary class="more">9 pages affected<\/summary>/);
    expect(html).toContain("/docs/page-00");
  });

  test("json and xml keep the bounded page list and add the scope", () => {
    const json = JSON.parse(renderJson(expectedTypeReport(SCOPED)));
    const checks = json.issues[0].checks as Array<{ message: string; scope?: unknown; affectedPages: string[] }>;
    const docs = checks.find((c) => c.message === MESSAGE_DOCS)!;
    expect(docs.scope).toEqual({ pageType: "docs", pages: 9, typePages: 9 });
    expect(docs.affectedPages).toHaveLength(9);
    const contact = checks.find((c) => c.message === MESSAGE_CONTACT)!;
    expect(contact.scope).toEqual({ pageType: "contact", pages: 2, typePages: 2 });

    const xml = renderXml(expectedTypeReport(SCOPED));
    expect(xml).toContain('<scope page-type="docs" pages="9" type-pages="9"/>');
    expect(xml).toContain('<scope page-type="contact" pages="2" type-pages="2"/>');
    expect(xml).toContain("/docs/page-00");
  });

  test("nine of eleven documentation pages", () => {
    const s = structure([["docs", 11], ["contact", 2]]);
    const text = renderText(expectedTypeReport(s));
    expect(text).toContain("On 9 of 11 documentation pages");
    expect(text).toContain("On all 2 contact pages");
    const checks = JSON.parse(renderJson(expectedTypeReport(s))).issues[0].checks as Array<{ message: string; scope?: unknown }>;
    expect(checks.find((c) => c.message === MESSAGE_DOCS)?.scope).toEqual({ pageType: "docs", pages: 9, typePages: 11 });
  });
});

describe("a check that is not scoped keeps its page rows", () => {
  const unscoped: Array<[string, ReportStructure | undefined]> = [
    ["no structure data", undefined],
    ["below the share (9 of 20)", structure([["docs", 20], ["contact", 2]])],
    ["more pages than the report counts", structure([["docs", 8], ["contact", 2]])],
    ["the type not counted", structure([["article", 40]], { notClassified: 14 })],
  ];
  for (const [name, s] of unscoped) {
    test(name, () => {
      const report = expectedTypeReport(s);
      const text = renderText(report);
      expect(text).not.toMatch(/On (all )?\d+( of \d+)? documentation pages/);
      expect(text).toContain("-> /docs/page-00");
      expect(renderMarkdown(report)).toContain("/docs/page-00");
      expect(renderLlm(report)).toContain("/docs/page-00");
      const checks = JSON.parse(renderJson(report)).issues[0].checks as Array<{ message: string; scope?: unknown }>;
      expect(checks.find((c) => c.message === MESSAGE_DOCS)?.scope).toBeUndefined();
      expect(renderXml(report)).not.toContain('page-type="docs"');
    });
  }

  test("one scoped type does not scope the other: below the share, the contact rows stay", () => {
    const s = structure([["docs", 9], ["contact", 5]]);
    const text = renderText(expectedTypeReport(s));
    expect(text).toContain("On all 9 documentation pages");
    expect(text).toContain("-> /contact-0");
    expect(text).not.toMatch(/On (all )?\d+( of \d+)? contact pages/);
  });

  test("a single page of a type is a row, not a scope", () => {
    const report = expectedTypeReport(structure([["docs", 1], ["contact", 2]]), 1);
    const text = renderText(report);
    expect(text).toContain("-> /docs/page-00");
    expect(text).toContain("On all 2 contact pages");
  });

  test("a check with carried pages is not scoped: its pages are not all in this audit's counts", () => {
    const s = structure([["docs", 9]]);
    // Nine pages, so the numbers would read "all 9": four failed now, five are carried.
    expect(checkPageTypeScope({ ...typed("docs"), carriedPages: [docsPage(0)] }, 9, s)).toBeUndefined();
    expect(checkPageTypeScope({ ...typed("docs"), carriedCount: 5 }, 9, s)).toBeUndefined();
    expect(checkPageTypeScope({ ...typed("docs"), provenance: "carried" }, 9, s)).toBeUndefined();
    expect(checkPageTypeScope({ ...typed("docs"), carriedPages: [] }, 9, s)).toMatchObject({ pages: 9, typePages: 9 });
    expect(checkPageTypeScope({ ...typed("docs"), carriedPages: [docsPage(0)] }, 9, structure([["docs", 40]]))).toBeUndefined();
  });

  test("a carried finding keeps its page rows in a rendered report", () => {
    const report = expectedTypeReport(SCOPED);
    const rule = report.ruleResults["schema/expected-type"]!;
    rule.checks = rule.checks.map((c, k) => (k < 5 ? { ...c, provenance: "carried" as const, lastSeenAt: 1 } : c));
    const text = renderText(report);
    expect(text).not.toMatch(/On (all )?\d+( of \d+)? documentation pages/);
    expect(text).toContain("-> /docs/page-00");
  });

  test("a check from another rule that names a page type is not scoped", () => {
    const report = expectedTypeReport(SCOPED);
    const rule = report.ruleResults["schema/expected-type"]!;
    rule.checks = rule.checks.map((c) => ({
      ...c,
      details: { pageType: (c.details as { pageType: string }).pageType },
    }));
    const text = renderText(report);
    expect(text).not.toContain("On all");
    expect(text).toContain("-> /docs/page-00");
  });
});

describe("the helpers other renderers share", () => {
  test("checkScopeLine and checkPagesScopedAway agree", () => {
    const check = typed("docs");
    expect(checkScopeLine(check, 9, SCOPED)).toBe("On all 9 documentation pages");
    expect(checkPagesScopedAway(check, 9, SCOPED)).toBe(true);
    expect(checkScopeLine(check, 9, undefined)).toBeUndefined();
    expect(checkPagesScopedAway(check, 9, undefined)).toBe(false);
  });

  test("a region scope wins over a page type scope on the same check", () => {
    const both = { details: { region: "footer", pageType: "docs", pageTypeSource: "model" } };
    const s = {
      ...structure([["docs", 9]]),
      sections: [{ section: "footer", pages: 9, links: 9 }],
    } as unknown as ReportStructure;
    expect(checkScopeLine(both, 9, s)).toBe("In the site footer, on 9 of 9 pages");
  });
});
