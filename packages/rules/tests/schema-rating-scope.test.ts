// schema/rating-scope — AggregateRating that is not about the page it sits on (#106).
//
// schema/review only ever checked the SHAPE of AggregateRating, so a sitewide
// "5/5 from 18 reviews" block emitted by a template passed on every page of the
// site, privacy policy included. These lock in the two relationship signals that
// separate a real finding from a legitimate LocalBusiness badge:
//
//   - is a rating visible to the reader anywhere on the page, and
//   - is the rated entity the subject of THIS page.
//
// The false-positive side matters as much as the true-positive side (#106: the
// naive "AggregateRating on many pages" version claimed 379 offending pages, the
// relationship version 53), so the negative cases below are load-bearing: a
// LocalBusiness homepage with a visible badge and a Product page whose rating
// matches its on-page reviews must stay silent.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { ratingScopeRule } from "../src/schema/rating-scope";
import { rules as schemaRules } from "../src/schema";
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

function page(schema: unknown, body: string, head = ""): string {
  return `<html><head><title>Page</title>${head}<script type="application/ld+json">${JSON.stringify(
    schema,
  )}</script></head><body>${body}</body></html>`;
}

/** The sitewide badge: one LocalBusiness rating the template prints everywhere. */
const SITEWIDE_BUSINESS = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Northgate Auto Repair",
  aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9", ratingCount: "18" },
};

const LEGAL_BODY =
  "<h1>Privacy Policy</h1><p>We collect the information you give us when you book a repair " +
  "and keep it only as long as we need it. You can ask us to delete it at any time.</p>";

describe("schema/rating-scope — visibility", () => {
  test("privacy policy carrying the sitewide rating with nothing visible → warns", () => {
    const html = page(SITEWIDE_BUSINESS, LEGAL_BODY);
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/privacy"));
    const visible = check(checks, "rating-visible");

    expect(visible?.status).toBe("warn");
    // Names the page type, the rated entity, and frames it as a policy risk.
    expect(visible?.message).toContain("privacy policy page");
    expect(visible?.message).toContain('LocalBusiness "Northgate Auto Repair"');
    expect(visible?.message).toContain("manual action");
    expect(visible?.message).not.toContain("missing");
    expect(visible?.details?.["ratedEntityType"]).toBe("LocalBusiness");
    expect(visible?.details?.["reason"]).toBe("no-visible-rating");
  });

  test("rating value that exists ONLY in the JSON-LD is not counted as visible", () => {
    // 4.9 appears in the markup; the visible text never says it.
    const html = page(SITEWIDE_BUSINESS, LEGAL_BODY);
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/privacy"));

    expect(check(checks, "rating-visible")?.status).toBe("warn");
  });

  test("visible star badge on a LocalBusiness homepage → no warning", () => {
    const html = page(
      SITEWIDE_BUSINESS,
      '<h1>Northgate Auto Repair</h1><div class="badge">★★★★★ 4.9 from 18 reviews</div>',
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/"));

    expect(check(checks, "rating-visible")?.status).toBe("pass");
    expect(checks.every((c) => c.status !== "warn")).toBe(true);
  });

  test("Product page whose rating matches visible on-page reviews → no warning", () => {
    const html = page(
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Trail Runner 3",
        aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "23" },
      },
      "<h1>Trail Runner 3</h1><p>4.6 out of 5 stars based on 23 reviews</p>",
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/products/trail-runner-3"));

    expect(check(checks, "rating-visible")?.status).toBe("pass");
    expect(checks.every((c) => c.status !== "warn")).toBe(true);
  });

  test("decimal rating printed verbatim in the copy counts as visible", () => {
    const html = page(SITEWIDE_BUSINESS, "<h1>Northgate Auto Repair</h1><p>Our customers score us 4.9.</p>");
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/"));

    expect(check(checks, "rating-visible")?.status).toBe("pass");
  });

  test("badge rendered as an image → alt text counts as visible", () => {
    const html = page(
      SITEWIDE_BUSINESS,
      '<h1>Northgate Auto Repair</h1><img src="/stars.svg" alt="Rated 4.9 out of 5 by our customers">',
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/"));

    expect(check(checks, "rating-visible")?.status).toBe("pass");
  });

  test("third-party review widget → visibility is not asserted against a raw-HTML crawl", () => {
    const html = page(
      SITEWIDE_BUSINESS,
      '<h1>Northgate Auto Repair</h1><div class="trustpilot-widget" data-businessunit-id="x"></div>',
      '<script src="https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js"></script>',
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/"));

    expect(check(checks, "rating-visible")?.status).toBe("pass");
    expect(check(checks, "rating-visible")?.message).toContain("review widget");
  });

  test("no AggregateRating anywhere → the rule says nothing at all", () => {
    const html = page(
      { "@context": "https://schema.org", "@type": "Organization", name: "Northgate" },
      "<h1>Northgate</h1><p>We fix cars.</p>",
    );

    expect(run(ratingScopeRule, pageCtx(html, "https://example.com/"))).toEqual([]);
  });

  test("array-wrapped aggregateRating (#721) is still read", () => {
    const html = page(
      {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        name: "Northgate Auto Repair",
        aggregateRating: [{ "@type": "AggregateRating", ratingValue: "4.9", ratingCount: "18" }],
      },
      LEGAL_BODY,
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/privacy"));

    expect(check(checks, "rating-visible")?.status).toBe("warn");
    expect(check(checks, "rating-visible")?.message).toContain("AggregateRating 4.9 from 18 reviews");
  });
});

describe("schema/rating-scope — page subject", () => {
  test("privacy policy carrying the sitewide business rating → warns on scope", () => {
    const html = page(SITEWIDE_BUSINESS, LEGAL_BODY);
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/privacy"));
    const subject = check(checks, "rating-subject");

    expect(subject?.status).toBe("warn");
    expect(subject?.message).toContain("privacy policy page");
    expect(subject?.message).toContain('LocalBusiness "Northgate Auto Repair"');
    expect(subject?.message).toContain("manual action");
    expect(subject?.details?.["reason"]).toBe("entity-not-page-subject");
    expect(subject?.items?.[0]?.label).toContain("Northgate Auto Repair");
  });

  test("privacy policy showing a visible badge still warns on scope", () => {
    // Visibility is not the excuse here: a policy page has no rateable subject.
    const html = page(SITEWIDE_BUSINESS, `${LEGAL_BODY}<footer>★★★★★ 4.9 from 18 reviews</footer>`);
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/privacy"));

    expect(check(checks, "rating-visible")?.status).toBe("pass");
    expect(check(checks, "rating-subject")?.status).toBe("warn");
  });

  test("terms page carrying the sitewide business rating → warns", () => {
    const html = page(
      SITEWIDE_BUSINESS,
      "<h1>Terms and Conditions</h1><p>These terms govern your use of the site.</p>",
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/terms-and-conditions"));

    expect(check(checks, "rating-subject")?.status).toBe("warn");
    expect(check(checks, "rating-subject")?.message).toContain("terms page");
  });

  test("blog post carrying the sitewide business rating → warns", () => {
    const html = page(
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BlogPosting",
            headline: "Five signs your brakes need attention",
            datePublished: "2026-02-03",
          },
          SITEWIDE_BUSINESS,
        ],
      },
      "<h1>Five signs your brakes need attention</h1><p>Grinding, pulling, a soft pedal.</p>",
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/news/brake-signs"));
    const subject = check(checks, "rating-subject");

    expect(subject?.status).toBe("warn");
    expect(subject?.message).toContain("article page");
    expect(subject?.message).toContain('LocalBusiness "Northgate Auto Repair"');
    expect(subject?.details?.["ratedEntityName"]).toBe("Northgate Auto Repair");
  });

  test("review article rating the product it is about → scope passes", () => {
    const html = page(
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Article", headline: "Trail Runner 3 reviewed" },
          {
            "@type": "Product",
            name: "Trail Runner 3",
            aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", ratingCount: "23" },
          },
        ],
      },
      "<h1>Trail Runner 3 reviewed</h1><p>Readers rate it 4.6 out of 5 across 23 reviews.</p>",
    );
    const checks = run(ratingScopeRule, pageCtx(html, "https://example.com/blog/trail-runner-3"));

    expect(check(checks, "rating-subject")?.status).toBe("pass");
    expect(checks.every((c) => c.status !== "warn")).toBe(true);
  });

  test("home and product pages get no subject check at all", () => {
    const html = page(SITEWIDE_BUSINESS, "<h1>Northgate Auto Repair</h1><p>★★★★★ 4.9 from 18 reviews</p>");

    expect(check(run(ratingScopeRule, pageCtx(html, "https://example.com/")), "rating-subject")).toBeUndefined();
  });
});

describe("schema/rating-scope — registration", () => {
  test("registered in the schema rules catalog", () => {
    expect(schemaRules.map((r) => r.meta.id)).toContain("schema/rating-scope");
  });

  test("rule metadata is page-scoped and a warning", () => {
    expect(ratingScopeRule.meta.category).toBe("schema");
    expect(ratingScopeRule.meta.scope).toBe("page");
    expect(ratingScopeRule.meta.severity).toBe("warning");
  });
});
