// schema/review — array-wrapped aggregateRating, issue #721.
//
// Same footgun as the local-business address bug (#711): some JSON-LD
// generators emit `"aggregateRating": [{...AggregateRating...}]` (a single
// object wrapped in a one-element array). The rule used to index ratingValue/
// ratingCount directly on the array, so a fully-populated wrapped rating was
// reported as missing ratingValue. These lock in: a wrapped complete rating
// passes, and plain object handling is unchanged.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { reviewSchemaRule } from "../src/schema/review";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function pageCtx(html: string, url = "https://example.com/"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
}

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function withSchema(schema: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(
    schema,
  )}</script></head><body><p>content</p></body></html>`;
}

const COMPLETE = {
  "@type": "AggregateRating",
  ratingValue: "4.7",
  ratingCount: "89",
};

describe("schema/review — array-wrapped aggregateRating (#721)", () => {
  test("array-wrapped fully-populated rating → passes, not reported missing", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Wrapped Widget",
      aggregateRating: [COMPLETE],
    });
    const checks = run(reviewSchemaRule, pageCtx(html));
    const rating = check(checks, "aggregate-rating");

    expect(rating?.status).toBe("pass");
    expect(rating?.message).toBe("AggregateRating: 4.7/5 (89 reviews)");
  });

  test("array-wrapped rating with reviewCount instead of ratingCount → passes", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Review Count Widget",
      aggregateRating: [{ "@type": "AggregateRating", ratingValue: "4.2", reviewCount: "12" }],
    });
    const checks = run(reviewSchemaRule, pageCtx(html));

    expect(check(checks, "aggregate-rating")?.status).toBe("pass");
  });

  test("array-wrapped rating missing ratingValue → still warns", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Half Widget",
      aggregateRating: [{ "@type": "AggregateRating", ratingCount: "5" }],
    });
    const checks = run(reviewSchemaRule, pageCtx(html));
    const rating = check(checks, "aggregate-rating");

    expect(rating?.status).toBe("warn");
    expect(rating?.message).toBe("AggregateRating missing ratingValue");
  });

  test("array with null entry then complete rating → passes without crashing", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Null Then Rating",
      aggregateRating: [null, COMPLETE],
    });
    const checks = run(reviewSchemaRule, pageCtx(html));

    expect(check(checks, "aggregate-rating")?.status).toBe("pass");
  });

  test("empty array → treated as no rating (info, no false missing-field warn)", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Empty Rating",
      aggregateRating: [],
    });
    const checks = run(reviewSchemaRule, pageCtx(html));

    expect(check(checks, "aggregate-rating")).toBeUndefined();
    expect(check(checks, "review-schema")?.status).toBe("info");
  });

  test("plain object complete rating → still passes (regression)", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Plain Widget",
      aggregateRating: COMPLETE,
    });
    const checks = run(reviewSchemaRule, pageCtx(html));
    const rating = check(checks, "aggregate-rating");

    expect(rating?.status).toBe("pass");
    expect(rating?.message).toBe("AggregateRating: 4.7/5 (89 reviews)");
  });

  test("plain object missing ratingValue → still warns (regression)", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Plain Half Widget",
      aggregateRating: { "@type": "AggregateRating", ratingCount: "5" },
    });
    const checks = run(reviewSchemaRule, pageCtx(html));
    const rating = check(checks, "aggregate-rating");

    expect(rating?.status).toBe("warn");
    expect(rating?.message).toBe("AggregateRating missing ratingValue");
  });

  test("plain object missing ratingCount/reviewCount → still warns (regression)", () => {
    const html = withSchema({
      "@type": "Product",
      name: "Countless Widget",
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.0" },
    });
    const checks = run(reviewSchemaRule, pageCtx(html));
    const rating = check(checks, "aggregate-rating");

    expect(rating?.status).toBe("warn");
    expect(rating?.message).toBe("AggregateRating missing ratingCount/reviewCount");
  });

  test("standalone AggregateRating node → unchanged (regression)", () => {
    const html = withSchema({
      "@type": "AggregateRating",
      ratingValue: "4.9",
      ratingCount: "200",
    });
    const checks = run(reviewSchemaRule, pageCtx(html));

    expect(check(checks, "aggregate-rating")?.status).toBe("pass");
  });
});
