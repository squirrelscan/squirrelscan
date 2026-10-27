// A page-URL item with its own label is not redundant with the affected-pages list (#2307).
//
// `links/no-contextual-inbound` gives each flagged page an item whose id is the page URL and
// whose label says where the links to it sit. The markdown and HTML renderers used to drop every
// page-URL item without sourcePages as a duplicate of the page list, which dropped the label with
// it. Every renderer must now print the label; an item whose label only repeats its id stays
// folded into the page list.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { isRedundantPageItem } from "../src/affected-pages";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

const BLOG = "https://example.com/blog";
const LABEL = `${BLOG}, linked only from the footer and the navigation`;

function rule(items: NonNullable<ReportRuleResult["checks"][number]["items"]>): ReportRuleResult {
  return {
    meta: {
      id: "links/no-contextual-inbound",
      name: "No Contextual Inbound Links",
      description: "desc",
      category: "links",
      scope: "site",
      severity: "warning",
      weight: 4,
    },
    checks: [
      {
        name: "no-contextual-inbound",
        status: "warn",
        message: "1 page(s) are linked only from sitewide chrome",
        items,
      },
    ],
  };
}

function report(items: Parameters<typeof rule>[0]): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 4,
    passed: 0,
    warnings: 1,
    failed: 0,
    ruleResults: { "links/no-contextual-inbound": rule(items) },
  };
}

const LABELLED = report([
  { id: BLOG, label: LABEL, meta: { sections: { footer: 3, navigation: 1 } } },
]);

describe("isRedundantPageItem", () => {
  test("a bare page-URL item is redundant; one with a label of its own is not", () => {
    expect(isRedundantPageItem({ id: BLOG })).toBe(true);
    expect(isRedundantPageItem({ id: BLOG, label: BLOG })).toBe(true);
    expect(isRedundantPageItem({ id: BLOG, label: "" })).toBe(true);
    expect(isRedundantPageItem({ id: BLOG, label: LABEL })).toBe(false);
  });

  test("an item with sourcePages, or a non-URL id, was never redundant", () => {
    expect(isRedundantPageItem({ id: BLOG, sourcePages: [] })).toBe(false);
    expect(isRedundantPageItem({ id: "Home | Example" })).toBe(false);
  });
});

describe("a labelled page-URL item prints its label in every format", () => {
  test("markdown", () => {
    const md = renderMarkdown(LABELLED);
    expect(md).toContain(LABEL);
    expect(md).toContain("1 item(s)");
  });

  test("html", () => {
    const html = renderHtml(LABELLED);
    expect(html).toContain("linked only from the footer and the navigation");
  });

  test("text", () => {
    expect(renderText(LABELLED)).toContain(`-> ${LABEL}`);
  });

  test("llm", () => {
    expect(renderLlm(LABELLED)).toContain(`(${LABEL})`);
  });

  test("xml", () => {
    expect(renderXml(LABELLED)).toContain(`<label>${LABEL}</label>`);
  });

  test("json", () => {
    const parsed = JSON.parse(renderJson(LABELLED)) as {
      issues: Array<{ checks: Array<{ items?: Array<{ id: string; label?: string; meta?: unknown }> }> }>;
    };
    const item = parsed.issues[0]!.checks[0]!.items![0]!;
    expect(item).toMatchObject({ id: BLOG, label: LABEL, meta: { sections: { footer: 3, navigation: 1 } } });
  });
});

describe("a page-URL item with no label of its own is still folded into the page list", () => {
  const bare = report([{ id: BLOG }]);

  test("markdown and html do not list it twice", () => {
    expect(renderMarkdown(bare)).not.toContain("1 item(s)");
    expect(renderMarkdown(report([{ id: BLOG, label: BLOG }]))).not.toContain("1 item(s)");
    // The page list still carries it.
    expect(renderMarkdown(bare)).toContain("1 page(s) affected");
    expect(renderHtml(bare)).not.toContain("1 item");
  });
});

describe("a label that embeds a site-controlled URL cannot inject markdown", () => {
  test("brackets in a label are escaped, so a nested image is not rendered", () => {
    const evil = "https://example.com/blog?q=![t](https://evil.example/p.png)";
    const md = renderMarkdown(
      report([{ id: evil, label: `${evil}, linked only from the footer` }]),
    );
    const itemLine = md.split("\n").find((line) => line.includes("linked only from the footer"))!;

    // The label's brackets are literal text; the destination is one percent-encoded URL.
    expect(itemLine).toBe(
      "- [https://example.com/blog?q=!\\[t\\](https://evil.example/p.png), linked only from the footer](https://example.com/blog?q=!%5Bt%5D%28https://evil.example/p.png%29)",
    );
  });

  test("parentheses in the link destination are percent-encoded", () => {
    const id = "https://example.com/a(b)";
    const md = renderMarkdown(report([{ id, label: `${id}, linked in the footer` }]));

    expect(md).toContain("(https://example.com/a%28b%29)");
  });
});
