// pub#837: a broken link lists each page that carries it once, says how many links that page has
// to it and where on the page they sit, and the summary separates links from pages. Truncated
// lists say how many pages are left out and never point at a list somewhere else.

import { describe, expect, test } from "bun:test";

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

/** Markdown output with its backslash escapes undone, to compare wording with the other formats (3522). */
const plain = (markdown: string): string => markdown.replace(/\\([\\`*_[\]()<>|~&!#+=-])/g, "$1");

const SITE = "https://example.com";
const GONE = `${SITE}/gone`;
const MIXED = `${SITE}/mixed`;

/** Linked twice from /a, once from the footer of /b, once from /c where the section is unknown. */
const TWICE: CheckItem = {
  id: GONE,
  label: `${GONE} (404), linked in the page content and the footer`,
  sourcePages: [`${SITE}/a`, `${SITE}/b`, `${SITE}/c`],
  sources: [
    { page: `${SITE}/a`, links: 2, sections: { content: 2 } },
    { page: `${SITE}/b`, links: 1, sections: { footer: 1 } },
    { page: `${SITE}/c`, links: 1 },
  ],
  meta: { statusCode: 404, sections: { content: 2, footer: 1 }, linkedFrom: 3 },
};

/** Linked from two sections of one page. */
const TWO_SECTIONS: CheckItem = {
  id: MIXED,
  label: `${MIXED} (404), linked in the page content and the footer`,
  sourcePages: [`${SITE}/d`],
  sources: [{ page: `${SITE}/d`, links: 2, sections: { footer: 1, content: 1 } }],
  meta: { statusCode: 404, sections: { content: 1, footer: 1 }, linkedFrom: 1 },
};

function report(items: CheckItem[], message = `${items.length} broken internal link(s) (4xx/5xx)`): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id: "links/broken-links",
      name: "Broken Links",
      description: "Detects links returning 404 or 5xx errors",
      category: "links",
      scope: "site",
      severity: "error",
      weight: 7,
    },
    checks: [{ name: "broken-links", status: "fail", message, items }],
  };
  return {
    baseUrl: SITE,
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 6,
    passed: 0,
    warnings: 0,
    failed: 1,
    ruleResults: { "links/broken-links": rule },
  };
}

const BOTH = report([TWICE, TWO_SECTIONS]);

/** Six source pages, one link each, all in the footer. */
const MANY: CheckItem = {
  id: GONE,
  label: `${GONE} (404), linked in the footer`,
  sourcePages: Array.from({ length: 6 }, (_, k) => `${SITE}/p${k}`),
  sources: Array.from({ length: 6 }, (_, k) => ({
    page: `${SITE}/p${k}`,
    links: 1,
    sections: { footer: 1 },
  })),
};

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("broken link sources: text", () => {
  const text = renderText(BOTH);

  test("each source page once, with its link count and section", () => {
    expect(text).toContain("from: /a (2 links, in the page content)");
    expect(text).toContain("from: /b (in the footer)");
    expect(count(text, "from: /a")).toBe(1);
    expect(text).toMatch(/from: \/c\n/);
  });

  test("a page linking from two sections names both", () => {
    expect(text).toContain("from: /d (2 links, in the page content and the footer)");
  });

  test("the summary separates links from pages", () => {
    expect(text).toContain("broken-links: 2 broken internal link(s) (4xx/5xx), found on 4 pages");
  });

  test("a long list says how many pages it leaves out", () => {
    const long = renderText(report([MANY]));
    expect(long).toContain("from: /p2 (in the footer)");
    expect(long).not.toContain("from: /p3");
    expect(long).toContain("+3 more pages");
    expect(long).not.toContain("see full list");
  });
});

describe("broken link sources: markdown", () => {
  const md = renderMarkdown(BOTH);

  test("each source page once, with its link count and section", () => {
    expect(md).toContain(`  - from: [/a](${SITE}/a) (2 links, in the page content)`);
    expect(md).toContain(`  - from: [/b](${SITE}/b) (in the footer)`);
    expect(md).toContain(`  - from: [/d](${SITE}/d) (2 links, in the page content and the footer)`);
    expect(count(md, "from: [/a]")).toBe(1);
  });

  test("the summary separates links from pages", () => {
    expect(plain(md)).toContain("| 2 broken internal link(s) (4xx/5xx), found on 4 pages |");
  });

  test("a long list says how many pages it leaves out, with no pointer elsewhere", () => {
    const long = renderMarkdown(report([MANY]));
    expect(long).toContain("  - +3 more pages");
    expect(long).not.toContain("see full list");
  });
});

describe("broken link sources: html", () => {
  const html = renderHtml(BOTH);

  test("each source page once, with its link count and section", () => {
    expect(html).toContain(`href="${SITE}/a"`);
    expect(html).toContain(" (2 links, in the page content)");
    expect(html).toContain(" (in the footer)");
    expect(html).toContain(" (2 links, in the page content and the footer)");
  });

  test("the summary separates links from pages", () => {
    expect(html).toContain("2 broken internal link(s) (4xx/5xx), found on 4 pages");
  });

  test("a long list expands in place to the rest of the pages", () => {
    const long = renderHtml(report([MANY]));
    expect(long).not.toContain("see full list");
    expect(long).toMatch(/<details[^>]*><summary[^>]*>\+3 more pages<\/summary>/);
    // Every page is in the item, not only in the page list above it.
    const item = long.slice(long.indexOf("+3 more pages"));
    for (const k of [3, 4, 5]) expect(item).toContain(`href="${SITE}/p${k}"`);
  });
});

describe("broken link sources: llm", () => {
  const llm = renderLlm(BOTH);

  test("each source page once, with its link count and section", () => {
    expect(llm).toContain("(from: /a (2 links, in the page content), /b (in the footer), /c)");
    expect(llm).toContain("(from: /d (2 links, in the page content and the footer))");
  });

  test("the summary separates links from pages", () => {
    expect(llm).toContain("2 broken internal link(s) (4xx/5xx), found on 4 pages");
  });

  test("a long list says how many pages it leaves out", () => {
    const long = renderLlm(report([{ ...MANY, sourcePages: [...MANY.sourcePages!, `${SITE}/p6`] }]));
    expect(long).toContain("; +2 more pages)");
  });
});

describe("broken link sources: json and xml carry the per-source data", () => {
  test("json", () => {
    const json = JSON.parse(renderJson(BOTH));
    const items = json.issues
      ? json.issues.flatMap((r: { checks: { items?: CheckItem[] }[] }) => r.checks.flatMap((c) => c.items ?? []))
      : [];
    const gone = items.find((i: CheckItem) => i.id === GONE) as CheckItem | undefined;
    expect(gone?.sources).toEqual(TWICE.sources);
  });

  test("xml", () => {
    const xml = renderXml(BOTH);
    expect(xml).toContain(`<page url="${SITE}/a" links="2">`);
    expect(xml).toContain(`<section name="content" links="2"/>`);
    expect(xml).toContain(`<page url="${SITE}/c" links="1"/>`);
    expect(xml).not.toContain("[object Object]");
  });
});

describe("an item from an older report, with repeated source pages and no per-source detail", () => {
  const OLD = report([{ id: GONE, label: `${GONE} (404)`, sourcePages: [`${SITE}/a`, `${SITE}/a`, `${SITE}/b`] }]);

  test("lists each page once, keeps the old summary", () => {
    const text = renderText(OLD);
    expect(count(text, "from: /a")).toBe(1);
    expect(text).toMatch(/from: \/a\n/);
    expect(text).toContain("broken-links: 1 broken internal link(s) (4xx/5xx) (2 pages)");
    expect(count(renderMarkdown(OLD), "from: [/a]")).toBe(1);
  });
});
