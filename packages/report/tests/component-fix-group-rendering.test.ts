// A fix group has to REPLACE output, not add to it. These pin the three states
// a rule can be in, and the hard one: a rule with no groups must render exactly
// as it did before the feature existed.

import { describe, expect, test } from "bun:test";
import type { AuditReport, CheckResult, ComponentOccurrence, ReportRuleResult } from "../src/types";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { groupIssuesByCategory } from "../src/grouping";
import { fixGroupLine, ruleFixCoverage, uncoveredItems } from "../src/component-presentation";

/** Markdown output with its backslash escapes undone, to compare wording with the other formats (3522). */
const plain = (markdown: string): string => markdown.replace(/\\([\\`*_[\]()<>|~&!#+=-])/g, "$1");

function occurrence(pageUrl: string, overrides: Partial<ComponentOccurrence> = {}): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "header", nestedIn: "none", structuralSignature: "s128:aaaa" },
    family: { key: "s128:bbbb", structuralSignature: "s128:bbbb" },
    variant: { key: "s128:cccc", structuralSignature: "s128:cccc", contentHash: "s128:dddd" },
    element: { locator: "header:1>header>nav:1>a:1", structuralSignature: "s128:eeee" },
    defect: {
      kind: "link-text-generic",
      values: { nameSource: "text", normalizedText: "website" },
      valueHashes: { normalizedText: "s128:ffff" },
    },
    ...overrides,
  };
}

function report(checks: CheckResult[]): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id: "a11y/link-text", name: "Link text", description: "desc", solution: "sol",
      category: "accessibility", scope: "page", severity: "warning", weight: 1,
    },
    checks,
  };
  return {
    baseUrl: "https://example.test", timestamp: "2026-09-19T00:00:00.000Z", totalPages: 4,
    passed: 0, warnings: checks.length, failed: 0, ruleResults: { "a11y/link-text": rule },
    healthScore: { overall: 80, categories: [], groups: [], errorCount: 0, warningCount: 1, passedCount: 0 },
  } as unknown as AuditReport;
}

function check(pageUrl: string, evidence?: ComponentOccurrence[]): CheckResult {
  return {
    name: "generic-link-text",
    status: "warn",
    message: "1 link(s) with generic text",
    pageUrl,
    pages: [pageUrl],
    items: [{ id: "website" }],
    ...(evidence ? { componentOccurrences: evidence } : {}),
  };
}

const PAGES = ["https://example.test/", "https://example.test/api", "https://example.test/guides"];

describe("full coverage: the group replaces the legacy lines", () => {
  const full = report(PAGES.map((page) => check(page, [occurrence(page)])));

  test("llm emits one fix-once line and drops Pages and Items", () => {
    const out = renderLlm(full);
    expect(out).toContain(
      '<fix-once pages="3">Fix once in the site header: link text &quot;website&quot; is generic, 3 pages: /, /api, /guides [nav:1 &gt; a:1]</fix-once>',
    );
    expect(out).not.toContain("Pages (");
    expect(out).not.toContain("Items (");
  });

  test("text and markdown say the same thing in the same words", () => {
    expect(renderText(full)).toContain(
      'Fix once in the site header (nav:1 > a:1): link text "website" is generic, 3 pages: /, /api, /guides',
    );
    expect(plain(renderMarkdown(full))).toContain(
      '**Fix once in the site header (nav:1 > a:1): link text "website" is generic, 3 pages: /, /api, /guides**',
    );
  });

  test("no hashes, signatures or internal keys reach a human surface", () => {
    for (const out of [renderLlm(full), renderText(full), renderMarkdown(full)]) {
      expect(out).not.toContain("s128:");
      expect(out).not.toContain("structuralSignature");
      expect(out).not.toContain("contentHash");
      expect(out).not.toContain("valueHashes");
      // No em-dashes in public copy.
      expect(out).not.toContain("—");
    }
  });
});

describe("partial coverage: groups first, remainder explicitly labelled", () => {
  const partial = report([
    ...PAGES.map((page) => check(page, [occurrence(page)])),
    check("https://example.test/legal"),
  ]);

  test("llm labels the uncovered pages rather than hiding them", () => {
    const out = renderLlm(partial);
    expect(out).toContain('<fix-once pages="3"');
    expect(out).toContain("Pages not attributed to a shared component (1): /legal");
    // The covered pages are NOT repeated in that remainder list.
    const remainder = out.split("Pages not attributed to a shared component (1): ")[1]!.split("\n")[0]!;
    expect(remainder).toBe("/legal");
    expect(out).not.toContain("Pages (4)");
  });

  test("the remainder block is minimal: only uncovered items, only uncovered pages", () => {
    // /legal is the only uncovered page. The item that appears on all four
    // pages must still be listed (it has an uncovered source page) but with
    // ONLY /legal under it: the other three are already stated by the group.
    const shared = report([
      ...PAGES.map((page) => ({
        ...check(page, [occurrence(page)]),
        items: [{ id: "website", sourcePages: [...PAGES, "https://example.test/legal"] }],
      })),
      { ...check("https://example.test/legal"), items: [{ id: "website", sourcePages: ["https://example.test/legal"] }] },
    ]);
    const out = renderLlm(shared);
    expect(out).toContain("Pages not attributed to a shared component (1): /legal");
    expect(out).toContain("(from: /legal)");
    // The covered pages are not repeated under the item.
    expect(out).not.toContain("from: /, /api, /guides");
  });

  test("an item fully accounted for by a group is dropped from the remainder", () => {
    const covered = report([
      ...PAGES.map((page) => ({
        ...check(page, [occurrence(page)]),
        items: [{ id: "website", sourcePages: [...PAGES] }],
      })),
      // No items of its own: grouping back-fills a check's pageUrl as a source
      // page, so an item here would legitimately survive as uncovered.
      { ...check("https://example.test/legal"), items: undefined },
    ]);
    const out = renderLlm(covered);
    expect(out).toContain("Pages not attributed to a shared component (1): /legal");
    // The "website" item's every source page is covered, so it is dropped
    // rather than re-reporting the same pages under a second heading.
    expect(out).not.toContain("- website");
    // What survives is grouping's page-URL placeholder for the itemless check.
    // It carries no sourcePages, so nothing establishes that a group accounted
    // for it and it is deliberately left alone.
    expect(out).toContain("- /legal");
  });

  test("text labels the remainder too", () => {
    const out = renderText(partial);
    expect(out).toContain("Fix once in the site header");
    expect(out).toContain("Not attributed to a shared component (1):");
    expect(out).toContain("-> /legal");
  });
});

describe("a one-page group is not a group", () => {
  // Real WordPress audits produced two separate single-page footer groups and a
  // single-page nav group. "Fix once, 1 page" says nothing the legacy per-check
  // line did not, so those fall back to legacy rendering entirely.
  const singlePage = report([check(PAGES[0]!, [occurrence(PAGES[0]!)])]);
  const legacy = report([check(PAGES[0]!)]);

  test("llm, text and markdown render it exactly as if it had no evidence", () => {
    expect(renderLlm(singlePage)).toBe(renderLlm(legacy));
    expect(renderText(singlePage)).toBe(renderText(legacy));
    expect(renderMarkdown(singlePage)).toBe(renderMarkdown(legacy));
  });

  test("no fix-once line is emitted at all", () => {
    const out = renderLlm(singlePage);
    expect(out).not.toContain("fix-once");
    expect(out).not.toContain("Fix once");
    // The defect is still reported the legacy way, not swallowed.
    expect(out).toContain("Pages (1): /");
  });

  test("a mixed rule renders only the multi-page group and keeps the rest legacy", () => {
    const mixed = report([
      ...PAGES.map((page) => check(page, [occurrence(page)])),
      // A second, unrelated one-page component on a fourth page.
      check("https://example.test/legal", [
        occurrence("https://example.test/legal", {
          variant: { key: "s128:zzzz", structuralSignature: "s128:zzzz", contentHash: "s128:yyyy" },
        }),
      ]),
    ]);
    const out = renderLlm(mixed);
    expect((out.match(/<fix-once /g) ?? [])).toHaveLength(1);
    expect(out).toContain('<fix-once pages="3">');
    // The single-page one is the uncovered remainder, labelled.
    expect(out).toContain("Pages not attributed to a shared component (1): /legal");
  });
});

describe("attribution changes what the line claims", () => {
  test("repeated-subtree is an observation, not an instruction", () => {
    const r = report(PAGES.map((page) => check(page, [occurrence(page)])));
    const grouped = groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!;
    grouped.componentFixGroups = grouped.componentFixGroups!.map((group) => ({
      ...group,
      attribution: "repeated-subtree" as const,
    }));
    expect(fixGroupLine(grouped.componentFixGroups[0]!, 5, (p) => new URL(p).pathname)).toBe(
      'Likely one shared block in the site header (nav:1 > a:1): link text "website" is generic, seen on 3 pages: /, /api, /guides',
    );
    // It must NOT read as an instruction to fix one place.
    expect(fixGroupLine(grouped.componentFixGroups[0]!, 5, (p) => new URL(p).pathname)).not.toContain(
      "Fix once",
    );
  });

  test("an unknown attribution renders nothing rather than guessing", () => {
    const r = report(PAGES.map((page) => check(page, [occurrence(page)])));
    const grouped = groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!;
    grouped.componentFixGroups = grouped.componentFixGroups!.map((group) => ({
      ...group,
      attribution: "some-future-signal" as unknown as typeof group.attribution,
    }));
    const coverage = ruleFixCoverage(grouped);
    expect(coverage.mode).toBe("none");
    expect(coverage.groups).toHaveLength(0);
  });
});

describe("no groups: byte-identical to the pre-feature rendering", () => {
  // The same report with the evidence stripped is what v0.0.96 produced. Any
  // difference here is the feature leaking into reports it has nothing to say
  // about, which is the regression this whole lane exists to prevent.
  const withEvidence = report(PAGES.map((page) => check(page, [occurrence(page, { groupable: false, confidence: "uncertain", uncertainReason: "region-main" })])));
  const withoutEvidence = report(PAGES.map((page) => check(page)));

  test("llm", () => {
    expect(renderLlm(withEvidence)).toBe(renderLlm(withoutEvidence));
    expect(renderLlm(withoutEvidence)).toContain("Pages (3): /, /api, /guides");
    expect(renderLlm(withoutEvidence)).toContain("Items (");
  });

  test("text", () => {
    expect(renderText(withEvidence)).toBe(renderText(withoutEvidence));
  });

  test("markdown", () => {
    expect(renderMarkdown(withEvidence)).toBe(renderMarkdown(withoutEvidence));
  });
});

describe("uncoveredItems keeps an item's page count in step with its narrowed pages", () => {
  const pages = ["https://example.test/a", "https://example.test/b", "https://example.test/c"];

  test("pages the groups took leave the item's pageCount too", () => {
    // 3 listed pages out of 5 the item is on; one listed page is covered by a group.
    const out = uncoveredItems(
      [{ id: "x", sourcePages: pages, pageCount: 5 }],
      { mode: "partial", groups: [], uncoveredPages: [pages[1]!, pages[2]!] },
    );
    expect(out).toEqual([{ id: "x", sourcePages: [pages[1], pages[2]], pageCount: 4 }]);
  });

  test("an item with no pageCount does not gain one", () => {
    const out = uncoveredItems(
      [{ id: "x", sourcePages: pages }],
      { mode: "partial", groups: [], uncoveredPages: [pages[2]!] },
    );
    expect(out).toEqual([{ id: "x", sourcePages: [pages[2]] }]);
  });
});
