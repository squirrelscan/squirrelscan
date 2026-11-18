// schema/breadcrumb learns the classifier's "breadcrumbs" link section (#2307).
//
// A page that shows a breadcrumb trail (at least one anchor the classifier placed in
// the breadcrumbs section) and declares no BreadcrumbList is a finding. Two markup-derived
// links are needed (repo#3365): one link, or links only the model placed, is not a trail.
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

function link(url: string, section?: LinkSection, model = false) {
  return {
    url,
    text: url,
    isInternal: true,
    ...(section ? { section } : {}),
    ...(model ? { sectionSource: "model" as const, sectionConfidence: 0.9 } : {}),
  };
}

async function run(body: string, sections: (LinkSection | undefined)[], url = "https://example.com/parts/x", modelIdx: number[] = []): Promise<CheckResult[]> {
  const parsed = parsePage(body, url) as ParsedPage;
  const ctx: RuleContext = {
    page: { url, html: body, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { ...parsed, links: sections.map((s, i) => link(`https://example.com/l${i}`, s, modelIdx.includes(i))) },
    options: {},
  };
  return (await breadcrumbSchemaRule.run(ctx)).checks as CheckResult[];
}

/** Run the rule on the links parsePage itself extracts, as a real audit does. */
async function runParsed(body: string, url = "https://example.com/parts/x"): Promise<CheckResult[]> {
  const parsed = parsePage(body, url) as ParsedPage;
  const ctx: RuleContext = {
    page: { url, html: body, statusCode: 200, loadTime: 0, headers: {} },
    parsed,
    options: {},
  };
  return (await breadcrumbSchemaRule.run(ctx)).checks as CheckResult[];
}

function trailPage(crumbs: number, schema?: unknown): string {
  const script = schema ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>` : "";
  const items = ["/", "/parts", "/parts/brakes"]
    .slice(0, crumbs)
    .map((href, i) => `<li><a href="${href}">crumb ${i}</a></li>`)
    .join("");
  return (
    `<html><head><title>Parts</title>${script}</head><body>` +
    `<nav aria-label="Main"><a href="/about">About</a><a href="/blog">Blog</a></nav>` +
    `<nav aria-label="breadcrumb"><ol>${items}<li>Brake pads</li></ol></nav>` +
    `<main><p>content</p></main></body></html>`
  );
}

describe("schema/breadcrumb on a markup breadcrumb trail (parsePage links)", () => {
  test("a two-link nav aria-label=breadcrumb trail with no BreadcrumbList is a fail", async () => {
    const checks = await runParsed(trailPage(2));
    expect(checks.map((c) => c.status)).toEqual(["fail"]);
    expect(checks[0]!.details).toEqual({ trailLinks: 2 });
  });

  test("the same trail with a BreadcrumbList passes", async () => {
    const checks = await runParsed(trailPage(2, BREADCRUMB_LD));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["breadcrumb-valid", "pass"]]);
  });

  test("a one-link trail is below the minimum: info", async () => {
    const checks = await runParsed(trailPage(1));
    expect(checks.map((c) => c.status)).toEqual(["info"]);
  });
});

describe("schema/breadcrumb with the breadcrumbs section", () => {
  test("two markup breadcrumb-section links and no BreadcrumbList is a fail", async () => {
    const checks = (await run(html(), ["breadcrumbs", "breadcrumbs", "navigation", "footer"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("breadcrumb-schema");
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.message).toBe("A breadcrumb trail on the page has no BreadcrumbList schema");
    expect(checks[0]!.details).toEqual({ trailLinks: 2 });
  });

  test("one markup breadcrumb-section link is below the minimum: info, no fail", async () => {
    const checks = (await run(html(), ["breadcrumbs", "navigation", "footer"]));
    expect(checks.map((c) => c.status)).toEqual(["info"]);
  });

  test("one model-only breadcrumb link does not fail", async () => {
    const checks = (await run(html(), ["breadcrumbs", "navigation"], undefined, [0]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe("No BreadcrumbList schema found");
  });

  test("several model-only breadcrumb links do not fail either", async () => {
    const checks = (await run(html(), ["breadcrumbs", "breadcrumbs", "breadcrumbs"], undefined, [0, 1, 2]));
    expect(checks.map((c) => c.status)).toEqual(["info"]);
  });

  test("model links do not count toward the markup minimum", async () => {
    const checks = (await run(html(), ["breadcrumbs", "breadcrumbs"], undefined, [1]));
    expect(checks.map((c) => c.status)).toEqual(["info"]);
  });

  test("two breadcrumb-section links report the count", async () => {
    const checks = (await run(html(), ["breadcrumbs", "breadcrumbs", "navigation"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.details).toEqual({ trailLinks: 2 });
  });

  test("links in other sections only: the old info check, unchanged", async () => {
    const checks = (await run(html(), ["navigation", "header", "footer", "sidebar"]));
    expect(checks).toEqual([
      {
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      },
    ]);
  });

  test("no section on any link (classifier off) is the old info check, unchanged", async () => {
    const checks = (await run(html(), [undefined, undefined, undefined]));
    expect(checks).toEqual([
      {
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      },
    ]);
  });

  test("a BreadcrumbList that is declared passes whatever the sections say", async () => {
    const checks = (await run(html(BREADCRUMB_LD), ["breadcrumbs", "breadcrumbs", "breadcrumbs"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("breadcrumb-valid");
    expect(checks[0]!.status).toBe("pass");
  });

  test("a trail marked up as microdata is described: no finding", async () => {
    const body =
      '<html><head><title>x</title></head><body><ol itemscope itemtype="http://schema.org/BreadcrumbList"><li>Docs</li></ol></body></html>';
    const checks = (await run(body, ["breadcrumbs", "breadcrumbs"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe("No BreadcrumbList schema found");
  });

  test("a URL-prefixed @type is the same type: no fail, and it is validated", async () => {
    const prefixed = { ...BREADCRUMB_LD, "@type": "https://schema.org/BreadcrumbList" };
    const checks = (await run(html(prefixed), ["breadcrumbs", "breadcrumbs"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("breadcrumb-valid");
    expect(checks[0]!.status).toBe("pass");
  });

  test("a URL-prefixed @type inside an array is the same type", async () => {
    const prefixed = { ...BREADCRUMB_LD, "@type": ["Thing", "https://schema.org/BreadcrumbList"] };
    const checks = (await run(html(prefixed), ["breadcrumbs", "breadcrumbs"]));
    expect(checks.map((c) => c.name)).toEqual(["breadcrumb-valid"]);
  });

  test("a BreadcrumbList nested in another node is described: no fail", async () => {
    const nested = { "@context": "https://schema.org", "@type": "WebPage", breadcrumb: BREADCRUMB_LD };
    const checks = (await run(html(nested), ["breadcrumbs", "breadcrumbs"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe("No BreadcrumbList schema found");
  });

  test("markup too large to read is an info check, not a fail", async () => {
    const filler = '<i itemtype="https://example.com/Thing"></i>'.repeat(MAX_ANNOTATED_ELEMENTS + 1);
    const checks = (await run(`<html><head><title>x</title></head><body>${filler}</body></html>`, ["breadcrumbs", "breadcrumbs"]));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.message).toBe(UNREADABLE_MESSAGE);
  });

  test("the homepage is still skipped", async () => {
    const checks = (await run(html(), ["breadcrumbs", "breadcrumbs"], "https://example.com/"));
    expect(checks).toEqual([
      { name: "breadcrumb-schema", status: "info", message: "Homepage - breadcrumbs not typically needed" },
    ]);
  });

  test("the rule now surfaces as a warning, so the new fail is a finding", () => {
    expect(breadcrumbSchemaRule.meta.severity).toBe("warning");
  });
});
