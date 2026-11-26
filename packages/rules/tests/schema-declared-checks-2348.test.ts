// #2348: schema/website-search and schema/product emit checks that were missing, so a clean or inapplicable
// run says so and every emitted name is declared in meta.checks.
import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { Rule, RuleContext, RuleResult } from "../src/types";

import { productSchemaRule } from "../src/schema/product";
import { websiteSearchSchemaRule } from "../src/schema/website-search";
import { expectDeclaredChecks } from "./helpers/declared-checks";

function run(rule: Rule, url: string, ld: unknown): RuleResult {
  const script = ld
    ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>`
    : "";
  const html = `<!doctype html><html lang="en"><head><title>t</title>${script}</head><body><h1>Page</h1></body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const out = rule.run(ctx);
  if (out instanceof Promise) throw new Error("rule is async");
  return out;
}

describe("schema declared checks (#2348)", () => {
  test("website-search skips an inner page with no WebSite schema", () => {
    const { checks } = run(
      websiteSearchSchemaRule,
      "https://example.com/blog/post",
      null
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "website-schema",
      status: "skipped",
    });
    expectDeclaredChecks(websiteSearchSchemaRule, checks);
  });

  test("website-search still reports a homepage with no WebSite schema as info", () => {
    const { checks } = run(
      websiteSearchSchemaRule,
      "https://example.com/",
      null
    );
    expect(checks.map((c) => c.status)).toEqual(["info"]);
    expectDeclaredChecks(websiteSearchSchemaRule, checks);
  });

  test("product without review data raises product-reviews, with it passes", () => {
    const base = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Mug",
    };
    const bare = run(
      productSchemaRule,
      "https://example.com/p/mug",
      base
    ).checks;
    expect(bare.find((c) => c.name === "product-reviews")?.status).toBe("info");
    expectDeclaredChecks(productSchemaRule, bare);
    const rated = run(productSchemaRule, "https://example.com/p/mug", {
      ...base,
      aggregateRating: { "@type": "AggregateRating", ratingValue: 5 },
    }).checks;
    expect(rated.find((c) => c.name === "product-reviews")?.status).toBe(
      "pass"
    );
    expectDeclaredChecks(productSchemaRule, rated);
  });
});
