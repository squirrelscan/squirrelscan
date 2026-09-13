// Every schema rule must see JSON-LD nested in `@graph` (#317).
//
// Yoast, Rank Math and Slim SEO all emit ONE script containing
// `{"@context":…,"@graph":[…]}`, which is the majority of the WordPress web.
// Seven of these rules parsed each script and looked only at the top level, so
// on those sites every one of them reported the markup as missing — a false
// error on a correctly marked-up page, which is the worst thing an audit can
// say.
//
// The test is written as one fixture checked by every rule rather than seven
// separate fixtures, because the defect was a copied idiom: the value is in
// proving no rule still carries it.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { breadcrumbSchemaRule } from "../src/schema/breadcrumb";
import { faqSchemaRule } from "../src/schema/faq";
import { organizationSchemaRule } from "../src/schema/organization";
import { productSchemaRule } from "../src/schema/product";
import { reviewSchemaRule } from "../src/schema/review";
import { videoSchemaRule } from "../src/schema/video";
import { websiteSearchSchemaRule } from "../src/schema/website-search";
import type { CheckResult, Rule, RuleContext } from "../src/types";

/** One Yoast-style `@graph` carrying every type the seven rules look for. */
const GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://example.com/#website",
      url: "https://example.com/",
      name: "Example",
      potentialAction: [
        {
          "@type": "SearchAction",
          target: "https://example.com/?s={search_term_string}",
          "query-input": "required name=search_term_string",
        },
      ],
    },
    {
      "@type": "Organization",
      "@id": "https://example.com/#organization",
      name: "Example Ltd",
      url: "https://example.com/",
      logo: {
        "@type": "ImageObject",
        url: "https://example.com/logo.png",
        width: 600,
        height: 60,
      },
      sameAs: ["https://x.com/example"],
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://example.com/widget#breadcrumb",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com/" },
        { "@type": "ListItem", position: 2, name: "Widget" },
      ],
    },
    {
      "@type": "FAQPage",
      "@id": "https://example.com/widget#faq",
      mainEntity: [
        {
          "@type": "Question",
          name: "Does it flatten @graph?",
          acceptedAnswer: { "@type": "Answer", text: "It does now." },
        },
        {
          "@type": "Question",
          name: "Did it before?",
          acceptedAnswer: { "@type": "Answer", text: "No, and that was issue 317." },
        },
      ],
    },
    {
      "@type": "Product",
      "@id": "https://example.com/widget#product",
      name: "Widget",
      image: "https://example.com/widget.png",
      description: "A widget.",
      offers: {
        "@type": "Offer",
        price: "19.99",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        url: "https://example.com/widget",
      },
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.5", reviewCount: "24" },
      review: {
        "@type": "Review",
        reviewRating: { "@type": "Rating", ratingValue: "5", bestRating: "5" },
        author: { "@type": "Person", name: "A Buyer" },
      },
    },
    {
      "@type": "VideoObject",
      "@id": "https://example.com/widget#video",
      name: "Widget demo",
      description: "A demo of the widget.",
      thumbnailUrl: "https://example.com/thumb.jpg",
      uploadDate: "2026-01-01T00:00:00+00:00",
      contentUrl: "https://example.com/demo.mp4",
      duration: "PT2M30S",
    },
  ],
};

/** The same nodes, emitted one per script at the top level. */
const FLAT_SCRIPTS = (GRAPH["@graph"] as Record<string, unknown>[]).map((node) =>
  JSON.stringify({ "@context": "https://schema.org", ...node })
);

function html(scripts: string[]): string {
  const tags = scripts
    .map((s) => `<script type="application/ld+json">${s}</script>`)
    .join("\n");
  return `<!doctype html><html><head><title>Widget</title>${tags}</head><body><h1>Widget</h1></body></html>`;
}

function ctx(pageHtml: string, url = "https://example.com/widget"): RuleContext {
  return {
    page: { url, html: pageHtml, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(pageHtml, url),
    options: {},
  };
}

async function checks(rule: Rule, pageHtml: string, url?: string): Promise<CheckResult[]> {
  const result = await Promise.resolve(rule.run(ctx(pageHtml, url)));
  return result.checks;
}

/**
 * The rules under test, with the check whose presence proves the type was
 * found, and the status that proves it was NOT.
 */
const CASES: Array<{ rule: Rule; check: string; missingStatus: string; url?: string }> = [
  {
    rule: websiteSearchSchemaRule,
    check: "website-schema",
    missingStatus: "info",
    url: "https://example.com/",
  },
  { rule: organizationSchemaRule, check: "organization-schema", missingStatus: "info" },
  { rule: breadcrumbSchemaRule, check: "breadcrumb-schema", missingStatus: "info" },
  { rule: faqSchemaRule, check: "faq-schema", missingStatus: "info" },
  { rule: productSchemaRule, check: "product-schema", missingStatus: "info" },
  { rule: videoSchemaRule, check: "video-schema", missingStatus: "info" },
  { rule: reviewSchemaRule, check: "review-schema", missingStatus: "info" },
];

describe("@graph-nested JSON-LD is read by every schema rule", () => {
  const graphHtml = html([JSON.stringify(GRAPH)]);
  const flatHtml = html(FLAT_SCRIPTS);

  for (const { rule, url } of CASES) {
    test(`${rule.meta.id} finds its type inside @graph`, async () => {
      const found = await checks(rule, graphHtml, url);
      // The precise assertion is "does not report the markup as absent". Each
      // rule's positive check differs; the absence message is what users saw.
      //
      // Two separate tests rather than one alternation: `^A|B` anchors only
      // the first branch, which is a real bug and not an obvious one.
      const absent = found.filter(
        (c) => /^No\s/i.test(c.message) || /\bnot found\b/i.test(c.message)
      );
      expect(absent).toEqual([]);
      expect(found.length).toBeGreaterThan(0);
    });
  }

  for (const { rule, url } of CASES) {
    test(`${rule.meta.id} reads @graph and flat markup identically`, async () => {
      // The stronger property: flattening did not merely stop the false
      // negative, it produced the SAME verdict as the equivalent flat markup.
      // A rule that found the node but then read it differently would pass the
      // test above and still be wrong.
      const fromGraph = await checks(rule, graphHtml, url);
      const fromFlat = await checks(rule, flatHtml, url);
      expect(fromGraph).toEqual(fromFlat);
    });
  }

  test("a page with no JSON-LD at all is unaffected", async () => {
    const bare = html([]);
    for (const { rule, url } of CASES) {
      const result = await checks(rule, bare, url);
      // Still silent or still reporting absence — the point is it does not throw
      // and does not invent a finding.
      expect(Array.isArray(result)).toBe(true);
    }
  });

  test("unparseable JSON-LD is skipped, not thrown on", async () => {
    // The rules used to swallow this in a try/catch. The flattener returns an
    // empty list instead, and the behaviour must be identical.
    const broken = html(["{not json", JSON.stringify(GRAPH)]);
    for (const { rule, url } of CASES) {
      const withBroken = await checks(rule, broken, url);
      const withoutBroken = await checks(rule, html([JSON.stringify(GRAPH)]), url);
      expect(withBroken).toEqual(withoutBroken);
    }
  });
});
