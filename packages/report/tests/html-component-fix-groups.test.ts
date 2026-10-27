// The HTML report is the one humans open, and it showed none of the
// component-aware findings (#2307). These pin the policy it shares with
// markdown/llm/text/console: a group REPLACES the legacy page list rather than
// adding to it, a one-page group is not a group, a report with nothing to say
// renders as it did before the feature existed, and — the one HTML nearly got
// wrong — the sentence is the SHARED sentence, not one this renderer assembled.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import type { AuditReport, CheckResult, ComponentOccurrence, ReportRuleResult } from "../src/types";
import type { ComponentFixGroup } from "../src/component-fix-groups";
import { FixGroupCards, renderHtml } from "../src/output/html";
import { renderMarkdown } from "../src/output/markdown";

function occurrence(
  pageUrl: string,
  overrides: Partial<ComponentOccurrence> = {},
): ComponentOccurrence {
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
      values: { nameSource: "text", normalizedText: "click here" },
      valueHashes: { normalizedText: "s128:ffff" },
    },
    ...overrides,
  };
}

/** An occurrence the rules could not judge, carrying the ladder that promotes it. */
function promotable(
  pageUrl: string,
  slot: string,
  text: string,
  heading?: string,
): ComponentOccurrence {
  return occurrence(pageUrl, {
    groupable: false,
    confidence: "uncertain",
    uncertainReason: "region-main",
    region: { role: "main", nestedIn: "none", structuralSignature: "s128:main" },
    defect: {
      kind: "link-text-generic",
      values: { normalizedText: text },
      valueHashes: { normalizedText: "s128:ffff" },
    },
    subtreeCandidates: [
      {
        level: 2,
        skeletonSignature: "s128:block",
        locatorFromRoot: slot,
        textShareOfRegion: 0.2,
        ...(heading ? { rootHint: { tag: "section", heading } } : {}),
      },
    ],
  });
}

function check(pageUrl: string, evidence?: ComponentOccurrence[]): CheckResult {
  return {
    name: "generic-link-text",
    status: "warn",
    message: "1 link(s) with generic text",
    pageUrl,
    pages: [pageUrl],
    items: [{ id: "click here" }],
    ...(evidence ? { componentOccurrences: evidence } : {}),
  };
}

function report(checks: CheckResult[]): AuditReport {
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
    checks,
  };
  return {
    baseUrl: "https://example.test",
    timestamp: "2026-09-19T00:00:00.000Z",
    totalPages: 4,
    passed: 0,
    warnings: checks.length,
    failed: 0,
    ruleResults: { "a11y/link-text": rule },
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

const PAGES = ["https://example.test/", "https://example.test/api", "https://example.test/guides"];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The rendered document only. The stylesheet in <head> names every class. */
function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body>"));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Drops everything between a `<` and the next `>`, by scanning rather than a regex. */
function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const char of html) {
    if (char === "<") inTag = true;
    else if (char === ">" && inTag) inTag = false;
    else if (!inTag) out += char;
  }
  return out;
}

/** What each card's sentence says, as text: markup stripped, entities decoded. */
function cardSentences(html: string): string[] {
  return [...html.matchAll(/<p class="fix-group-line">(.*?)<\/p>/g)].map((match) =>
    decodeEntities(stripTags(match[1]!)),
  );
}

/** The same sentences as markdown prints them, bold markers removed and its escapes undone (3522). */
function markdownSentences(markdown: string): string[] {
  return [...markdown.matchAll(/^\*\*((?:Fix once|Likely one shared block).*?)\*\*$/gm)].map(
    (match) => match[1]!.replace(/\\([\\`*_[\]()<>|~&!#+=-])/g, "$1"),
  );
}

describe("the sentence is the shared sentence, not one HTML assembled", () => {
  // The regression this file exists to catch: html.tsx used to compose its own
  // line from the region and the defect, which silently dropped the block name
  // the grouping stage had worked out. Comparing TEXT (not markup) against the
  // markdown surface is what makes a private sentence builder impossible.
  const cases: Array<[string, AuditReport]> = [
    ["observed, no block name", report(PAGES.map((page) => check(page, [occurrence(page)])))],
    [
      "repeated subtree with a block name",
      report(PAGES.map((page) => check(page, [promotable(page, "div:1>a:1", "download", "Downloads")]))),
    ],
    [
      "repeated subtree with no legible name",
      report(PAGES.map((page) => check(page, [promotable(page, "div:1>a:1", "download")]))),
    ],
    [
      "a rollup: two slots in one block",
      report(
        PAGES.map((page) =>
          check(page, [
            promotable(page, "div:1>a:1", "download", "Downloads"),
            promotable(page, "div:1>a:2", "get it", "Downloads"),
          ]),
        ),
      ),
    ],
    [
      "a rollup of observed slots in one footer",
      report(
        PAGES.map((page) =>
          check(page, [
            occurrence(page),
            occurrence(page, {
              element: { locator: "footer:1>footer>ul:1>a:3", structuralSignature: "s128:e3" },
              defect: {
                kind: "link-text-generic",
                values: { normalizedText: "more" },
                valueHashes: {},
              },
            }),
          ]),
        ),
      ),
    ],
  ];

  for (const [name, input] of cases) {
    test(`${name}: html text === markdown text`, () => {
      const sentences = cardSentences(renderHtml(input));
      expect(sentences.length).toBeGreaterThan(0);
      expect(sentences).toEqual(markdownSentences(renderMarkdown(input)));
    });
  }

  test("the block name is rendered as a name, and only inside the sentence", () => {
    const html = renderHtml(
      report(PAGES.map((page) => check(page, [promotable(page, "div:1>a:1", "download", "Downloads")]))),
    );
    expect(html).toContain('<span class="fix-group-name">&quot;Downloads&quot;</span>');
    expect(cardSentences(html)[0]).toContain('Likely one shared block ("Downloads") in the main content');
  });

  test("a group with no name renders the sentence with no name markup", () => {
    const html = renderHtml(report(PAGES.map((page) => check(page, [occurrence(page)]))));
    expect(bodyOf(html)).not.toContain("fix-group-name");
    expect(cardSentences(html)[0]).toStartWith("Fix once in the site footer");
  });
});

describe("full coverage: the card replaces the legacy page list", () => {
  const full = report(PAGES.map((page) => check(page, [occurrence(page)])));
  const html = renderHtml(full);

  test("one card, badged for what the evidence supports", () => {
    expect(html).toContain('<span class="fix-badge">Fix once</span>');
    expect(countOccurrences(html, '<li class="fix-group"')).toBe(1);
  });

  test("the legacy per-check page list is gone, the card's own list is not", () => {
    // The rule header keeps its own "3 pages" reach; what goes is the per-check list that
    // repeated those same pages under the card.
    expect(html).not.toContain('<summary class="more">3 pages affected</summary>');
    expect(countOccurrences(html, "pages affected")).toBe(0);
    expect(html).toContain('<summary class="more">Affected pages (3)</summary>');
    // Every affected page is still reachable, as a real link.
    for (const page of PAGES) expect(html).toContain(`href="${page}"`);
  });

  test("no hashes, signatures or internal keys reach the page", () => {
    expect(html).not.toContain("s128:");
    expect(html).not.toContain("structuralSignature");
    expect(html).not.toContain("contentHash");
    expect(html).not.toContain("valueHashes");
    expect(html).not.toContain("component-fix:");
  });

  test("no em-dashes in the rendered copy", () => {
    expect(bodyOf(html)).not.toContain("—");
  });
});

describe("partial coverage: the remainder is labelled, never hidden", () => {
  const html = renderHtml(
    report([
      ...PAGES.map((page) => check(page, [occurrence(page)])),
      check("https://example.test/legal"),
    ]),
  );

  test("the uncovered page keeps a list of its own, explicitly named", () => {
    expect(html).toContain('<summary class="more">Pages not attributed to a shared component (1)</summary>');
    expect(html).toContain('href="https://example.test/legal"');
  });

  test("the covered pages are not repeated in that remainder", () => {
    const start = html.indexOf("Pages not attributed to a shared component (1)");
    const remainder = html.slice(start, html.indexOf("</details>", start));
    expect(remainder).toContain('href="https://example.test/legal"');
    expect(remainder).not.toContain('href="https://example.test/api"');
    expect(remainder).not.toContain('href="https://example.test/guides"');
  });

  test("the fix card is still there", () => {
    expect(cardSentences(html)[0]).toStartWith("Fix once in the site footer");
  });
});

describe("a one-page group is not a group", () => {
  test("HTML is byte-identical to the same report with no evidence at all", () => {
    const singlePage = report([check(PAGES[0]!, [occurrence(PAGES[0]!)])]);
    const legacy = report([check(PAGES[0]!)]);
    expect(renderHtml(singlePage)).toBe(renderHtml(legacy));
    expect(bodyOf(renderHtml(singlePage))).not.toContain("fix-group");
    // The defect is still reported the legacy way, not swallowed.
    expect(renderHtml(singlePage)).toContain('<summary class="more">1 page affected</summary>');
  });
});

describe("attribution changes what the card claims", () => {
  const html = renderHtml(
    report(PAGES.map((page) => check(page, [promotable(page, "div:1>a:1", "download")]))),
  );

  test("it reads as an observation, not an instruction", () => {
    expect(cardSentences(html)[0]).toStartWith("Likely one shared block in the main content");
    expect(html).not.toContain("Fix once");
  });

  test("the badge is the weaker one, and says so in words", () => {
    expect(html).toContain('<span class="fix-badge fix-badge-weak">Likely shared block</span>');
    expect(html).toContain('class="fix-group fix-group-weak"');
  });

  test("an unknown attribution renders no card at all", () => {
    // Attribution is assigned by the grouping stage, so this drives the card
    // renderer directly: a future signal this build cannot phrase must never be
    // narrated with borrowed confidence.
    const markup = renderToStaticMarkup(
      React.createElement(FixGroupCards, {
        coverage: {
          mode: "full" as const,
          groups: [
            {
              id: "component-fix:0",
              ruleId: "a11y/link-text",
              check: { name: "generic-link-text", status: "warn" },
              attribution: "some-future-signal",
              affectedPages: PAGES,
              affectedPageCount: 3,
              region: { role: "footer", nestedIn: "none", structuralSignature: "s128:aaaa" },
              semanticSlot: "footer:1>footer>ul:1>a:2",
              defect: {
                kind: "link-text-generic",
                values: { normalizedText: "x" },
                valueHashes: {},
              },
              occurrences: [],
            } as unknown as ComponentFixGroup,
          ],
          uncoveredPages: [],
        },
      }),
    );
    expect(markup).toBe("");
  });
});

describe("a rollup is one card, however many slots the block holds", () => {
  // squirrelscan.com's install block: seven platform links, one component, 14
  // pages, which read as seven findings before the rollup existed.
  const ROLLUP_PAGES = Array.from({ length: 14 }, (_, i) => `https://example.test/r/${i}`);
  const SLOTS = ["download", "get it", "install", "grab", "fetch", "copy", "run"];
  const rolled = report(
    ROLLUP_PAGES.map((page) =>
      check(
        page,
        SLOTS.map((text, index) => promotable(page, `div:1>a:${index + 1}`, text, "Install squirrel")),
      ),
    ),
  );
  const html = renderHtml(rolled);

  test("seven slots collapse into one card naming the block, not the buttons", () => {
    expect(countOccurrences(html, '<li class="fix-group')).toBe(1);
    expect(cardSentences(html)[0]).toBe(
      'Likely one shared block ("Install squirrel") in the main content: ' +
        '7 links with generic text "run", "grab", "copy" (+4 more), ' +
        "seen on 14 pages: /r/0, /r/1, /r/10 (+11 more)",
    );
    // Word for word what markdown prints for the same audit.
    expect(cardSentences(html)).toEqual(markdownSentences(renderMarkdown(rolled)));
  });

  test("the card lists all 14 pages, collapsed, and the legacy list is gone", () => {
    expect(html).toContain('<summary class="more">Affected pages (14)</summary>');
    const start = html.indexOf('<li class="fix-group');
    const card = html.slice(start, html.indexOf("</li>", start));
    expect(countOccurrences(card, 'href="https://example.test/r/')).toBe(14);
    expect(html).not.toContain("14 pages affected");
  });

  test("without a component root the groups stay separate cards", () => {
    // What a build before Terra's root key produced, and what a group the
    // rollup declines to merge still gets: its own card, never a merge this
    // renderer inferred.
    const groups = SLOTS.map(
      (text, index) =>
        ({
          id: `component-fix:${index}`,
          ruleId: "a11y/link-text",
          check: { name: "generic-link-text", status: "warn" },
          attribution: "repeated-subtree",
          affectedPages: ROLLUP_PAGES,
          affectedPageCount: ROLLUP_PAGES.length,
          region: { role: "main", nestedIn: "none", structuralSignature: "s128:main" },
          element: { locator: "main:1>div:1>a:1", structuralSignature: "s128:eeee" },
          semanticSlot: `div:1>a:${index + 1}`,
          defect: {
            kind: "link-text-generic",
            values: { normalizedText: text },
            valueHashes: {},
          },
          occurrences: ROLLUP_PAGES.map(() => ({}) as ComponentOccurrence),
        }) as unknown as ComponentFixGroup,
    );
    const markup = renderToStaticMarkup(
      React.createElement(FixGroupCards, {
        coverage: { mode: "full" as const, groups, uncoveredPages: [] },
      }),
    );
    expect(countOccurrences(markup, "<li class=")).toBe(7);
  });
});

describe("site-controlled strings are neutralised", () => {
  const hostile = "\"><script>alert(1)</script>";

  test("a defect value cannot open a tag or break out of an attribute", () => {
    const html = renderHtml(
      report(
        PAGES.map((page) =>
          check(page, [
            occurrence(page, {
              defect: {
                kind: "link-text-generic",
                values: { normalizedText: hostile },
                valueHashes: { normalizedText: "s128:ffff" },
              },
            }),
          ]),
        ),
      ),
    );
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("a block name from the page cannot inject markup either", () => {
    const html = renderHtml(
      report(PAGES.map((page) => check(page, [promotable(page, "div:1>a:1", "download", hostile)]))),
    );
    expect(html).toContain('<span class="fix-group-name">');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(cardSentences(html)[0]).toContain(`"${hostile}"`);
  });

  test("a javascript: page URL never reaches an href", () => {
    const evil = "javascript:alert(1)";
    const html = renderHtml(
      report([
        ...PAGES.map((page) => check(page, [occurrence(page)])),
        { ...check(evil), pages: [evil], pageUrl: evil },
      ]),
    );
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="#"');
  });
});

describe("no component evidence: nothing changes", () => {
  // Uncertain evidence with no ladder produces no groups at all. Any difference
  // here is the feature leaking into reports it has nothing to say about.
  test("HTML is byte-identical with and without the evidence", () => {
    const withEvidence = report(
      PAGES.map((page) =>
        check(page, [
          occurrence(page, {
            groupable: false,
            confidence: "uncertain",
            uncertainReason: "no-region",
          }),
        ]),
      ),
    );
    const withoutEvidence = report(PAGES.map((page) => check(page)));
    expect(renderHtml(withEvidence)).toBe(renderHtml(withoutEvidence));
    expect(renderHtml(withoutEvidence)).toContain('<summary class="more">3 pages affected</summary>');
    expect(bodyOf(renderHtml(withoutEvidence))).not.toContain("fix-group");
  });
});
