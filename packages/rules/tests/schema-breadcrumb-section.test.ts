// schema/breadcrumb learns the classifier's "breadcrumbs" link section (#2307).
//
// A page that shows a breadcrumb trail (at least one anchor the classifier placed in
// the breadcrumbs section) and declares no BreadcrumbList is a finding. One is enough:
// the current page is plain text in a trail, so `Docs / Security` has a single link.
// With no breadcrumb-section link the rule behaves exactly as before.

import { describe, expect, test } from "bun:test";

import type { CheckResult, LinkSection } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { breadcrumbSchemaRule } from "../src/schema/breadcrumb";
import { MAX_ANNOTATED_ELEMENTS, UNREADABLE_MESSAGE } from "../src/schema/markup-types";
import type { ParsedPage, RuleContext } from "../src/types";

const BREADCRUMB_LD = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com/" },
    { "@type": "ListItem", position: 2, name: "Parts" },
  ],
};

function html(schema?: unknown): string {
  const script = schema ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>` : "";
  return `<html><head><title>Parts</title>${script}</head><body><p>content</p></body></html>`;
}

function link(url: string, section?: LinkSection) {
  return { url, text: url, isInternal: true, ...(section ? { section } : {}) };
}

function run(body: string, sections: (LinkSection | undefined)[], url = "https://example.com/parts/x"): CheckResult[] {
  const parsed = parsePage(body, url) as ParsedPage;
  const ctx: RuleContext = {
    page: { url, html: body, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { ...parsed, links: sections.map((s, i) => link(`https://example.com/l${i}`, s)) },
    options: {},
  };
  return breadcrumbSchemaRule.run(ctx).checks as CheckResult[];
}

describe("schema/breadcrumb with the breadcrumbs section", () => {
  test("one breadcrumb-section link and no BreadcrumbList is a fail", () => {
    const checks = run(html(), ["breadcrumbs", "navigation", "footer"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("breadcrumb-schema");
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.message).toBe("A breadcrumb trail on the page has no BreadcrumbList schema");
    expect(checks[0]!.details).toEqual({ trailLinks: 1 });
  });

  test("two breadcrumb-section links report the count", () => {
    const checks = run(html(), ["breadcrumbs", "breadcrumbs", "navigation"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.details).toEqual({ trailLinks: 2 });
  });

  test("links in other sections only: the old info check, unchanged", () => {
    const checks = run(html(), ["navigation", "header", "footer", "sidebar"]);
    expect(checks).toEqual([
      {
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      },
    ]);
  });

  test("no section on any link (classifier off) is the old info check, unchanged", () => {
    const checks = run(html(), [undefined, undefined, undefined]);
    expect(checks).toEqual([
      {
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      },
    ]);
  });

  test("a BreadcrumbList that is declared passes whatever the sections say", () => {
    const checks = run(html(BREADCRUMB_LD), ["breadcrumbs", "breadcrumbs", "breadcrumbs"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("breadcrumb-valid");
    expect(checks[0]!.status).toBe("pass");
  });

  test("a trail marked up as microdata is described: no finding", () => {
    const body =
      '<html><head><title>x</title></head><body><ol itemscope itemtype="http://schema.org/BreadcrumbList"><li>Docs</li></ol></body></html>';
    const checks = run(body, ["breadcrumbs"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe("No BreadcrumbList schema found");
  });

  test("a URL-prefixed @type is the same type: no fail, and it is validated", () => {
    const prefixed = { ...BREADCRUMB_LD, "@type": "https://schema.org/BreadcrumbList" };
    const checks = run(html(prefixed), ["breadcrumbs", "breadcrumbs"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("breadcrumb-valid");
    expect(checks[0]!.status).toBe("pass");
  });

  test("a URL-prefixed @type inside an array is the same type", () => {
    const prefixed = { ...BREADCRUMB_LD, "@type": ["Thing", "https://schema.org/BreadcrumbList"] };
    const checks = run(html(prefixed), ["breadcrumbs"]);
    expect(checks.map((c) => c.name)).toEqual(["breadcrumb-valid"]);
  });

  test("a BreadcrumbList nested in another node is described: no fail", () => {
    const nested = { "@context": "https://schema.org", "@type": "WebPage", breadcrumb: BREADCRUMB_LD };
    const checks = run(html(nested), ["breadcrumbs", "breadcrumbs"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe("No BreadcrumbList schema found");
  });

  test("markup too large to read is an info check, not a fail", () => {
    const filler = '<i itemtype="https://example.com/Thing"></i>'.repeat(MAX_ANNOTATED_ELEMENTS + 1);
    const checks = run(`<html><head><title>x</title></head><body>${filler}</body></html>`, ["breadcrumbs"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe(UNREADABLE_MESSAGE);
  });

  test("the homepage is still skipped", () => {
    const checks = run(html(), ["breadcrumbs", "breadcrumbs"], "https://example.com/");
    expect(checks).toEqual([
      { name: "breadcrumb-schema", status: "info", message: "Homepage - breadcrumbs not typically needed" },
    ]);
  });

  test("the rule now surfaces as a warning, so the new fail is a finding", () => {
    expect(breadcrumbSchemaRule.meta.severity).toBe("warning");
  });
});
