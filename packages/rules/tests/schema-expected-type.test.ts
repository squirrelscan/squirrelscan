// schema/expected-type: structured data a page's classified type should carry (#2307).
//
// The classifier's label is the witness; the schema may veto a finding but never
// create one, and only a MODEL label is trusted (a rules label is read from the
// schema, so judging the schema against it is circular).

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageClassification } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { expectedTypeSchemaRule } from "../src/schema/expected-type";
import {
  MAX_ANNOTATED_ELEMENTS,
  MAX_JSONLD_DEPTH,
  MAX_JSONLD_VALUES,
  MAX_TOKENS_PER_ATTRIBUTE,
  MAX_VISITED_NODES,
  UNREADABLE_MESSAGE,
  jsonLdTypes,
  microdataAndRdfaTypes,
} from "../src/schema/markup-types";
import { loadAllRules } from "../src/loader";
import type { ParsedPage, RuleContext } from "../src/types";

function classification(
  label: string,
  confidence: number,
  source: "model" | "rules" = "model",
): PageClassification {
  return { pageType: { label, confidence, source }, degraded: "" };
}

function withSchema(...nodes: unknown[]): string {
  const scripts = nodes
    .map((node) => `<script type="application/ld+json">${JSON.stringify(node)}</script>`)
    .join("");
  return `<html><head><title>Page</title>${scripts}</head><body><p>content</p></body></html>`;
}

function ctxFor(
  html: string,
  cls: PageClassification | undefined,
  options: Record<string, unknown> = {},
  url = "https://example.com/page",
): RuleContext {
  const parsed = parsePage(html, url) as ParsedPage;
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: cls ? { ...parsed, classification: cls } : parsed,
    options,
  };
}

function only(ctx: RuleContext): CheckResult {
  const checks = expectedTypeSchemaRule.run(ctx).checks as CheckResult[];
  expect(checks).toHaveLength(1);
  expect(checks[0]!.name).toBe("expected-type");
  return checks[0]!;
}

const NOT_CONFIDENT = "Page type not classified with enough confidence to expect structured data";

describe("schema/expected-type", () => {
  test("model product_detail 0.99 with no Product fails; confidence is in details, not the message", () => {
    const check = only(ctxFor(withSchema({ "@type": "WebPage", name: "x" }), classification("product_detail", 0.99)));
    expect(check.status).toBe("fail");
    expect(check.message).toBe("Reads as a product page but declares no Product structured data");
    expect(check.details).toMatchObject({ pageType: "product_detail", pageTypeSource: "model", confidence: 0.99, expected: "Product" });
  });

  test("two pages of one page type at different confidences share one message", () => {
    const html = "<html><body></body></html>";
    const a = only(ctxFor(html, classification("docs", 0.93)));
    const b = only(ctxFor(html, classification("docs", 0.98)));
    expect(a.message).toBe(b.message);
    expect(a.details).toMatchObject({ confidence: 0.93 });
    expect(b.details).toMatchObject({ confidence: 0.98 });
  });

  test("a page with no JSON-LD at all fails the same way", () => {
    const check = only(ctxFor("<html><body><p>hi</p></body></html>", classification("product_detail", 0.95)));
    expect(check.status).toBe("fail");
  });

  test("ProductGroup satisfies product_detail", () => {
    const check = only(
      ctxFor(withSchema({ "@type": "ProductGroup", name: "Parka" }), classification("product_detail", 0.99)),
    );
    expect(check.status).toBe("pass");
    expect(check.message).toBe("Product page declares ProductGroup");
  });

  test("a Product inside an @graph is found", () => {
    const check = only(
      ctxFor(
        withSchema({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, { "@type": "Product" }] }),
        classification("product_detail", 0.99),
      ),
    );
    expect(check.status).toBe("pass");
  });

  test("a URL-prefixed @type reads as its bare name", () => {
    const check = only(
      ctxFor(withSchema({ "@type": "https://schema.org/Product" }), classification("product_detail", 0.99)),
    );
    expect(check.status).toBe("pass");
  });

  test("a Product declared as microdata counts: no JSON-LD is needed", () => {
    const html =
      '<html><body><div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Parka</span></div></body></html>';
    const check = only(ctxFor(html, classification("product_detail", 0.99)));
    expect(check.status).toBe("pass");
    expect(check.message).toBe("Product page declares Product");
  });

  test("an Organization declared as RDFa counts for a contact page", () => {
    const html = '<html><body><div vocab="https://schema.org/" typeof="schema:Organization"></div></body></html>';
    expect(only(ctxFor(html, classification("contact", 0.99))).status).toBe("pass");
  });

  test("a SoftwareApplication satisfies product_detail", () => {
    const check = only(ctxFor(withSchema({ "@type": "SoftwareApplication" }), classification("product_detail", 0.99)));
    expect(check.status).toBe("pass");
  });

  test("a NaN or missing confidence reads as not confident", () => {
    const html = "<html><body></body></html>";
    expect(only(ctxFor(html, classification("product_detail", Number.NaN))).status).toBe("info");
    const noConfidence = { pageType: { label: "product_detail", source: "model" }, degraded: "" } as unknown;
    expect(only(ctxFor(html, noConfidence as PageClassification)).status).toBe("info");
  });

  test("a Product nested as WebPage.mainEntity counts as declared", () => {
    const html = withSchema({ "@type": "WebPage", mainEntity: { "@type": "Product", name: "Parka" } });
    const check = only(ctxFor(html, classification("product_detail", 0.99)));
    expect(check.status).toBe("pass");
    expect(check.message).toBe("Product page declares Product");
  });

  test("a nested type inside an array of nodes counts as declared", () => {
    const html = withSchema({ "@type": "WebPage", hasPart: [{ "@type": "Thing" }, { "@type": ["Product"] }] });
    expect(only(ctxFor(html, classification("product_detail", 0.99))).status).toBe("pass");
  });

  test("a nested isPartOf Blog does not veto a post with no Article type", () => {
    const html = withSchema({ "@type": "WebPage", isPartOf: { "@type": "Blog", name: "Blog" } });
    const check = only(ctxFor(html, classification("blog_post", 0.97)));
    expect(check.status).toBe("fail");
  });

  test("a top-level Blog still vetoes", () => {
    expect(only(ctxFor(withSchema({ "@type": "Blog" }), classification("blog_post", 0.97))).status).toBe("pass");
  });

  test("an @context term definition is not read as a type", () => {
    const html = withSchema({
      "@context": { "@vocab": "https://schema.org/", url: { "@type": "Product" } },
      "@type": "WebPage",
    });
    expect(only(ctxFor(html, classification("product_detail", 0.99))).status).toBe("fail");
  });

  test("markup too large to read is an info check, not a fail", () => {
    const filler = '<i itemtype="https://example.com/Thing"></i>'.repeat(MAX_ANNOTATED_ELEMENTS + 1);
    const check = only(ctxFor(`<html><body>${filler}</body></html>`, classification("product_detail", 0.99)));
    expect(check.status).toBe("info");
    expect(check.message).toBe(UNREADABLE_MESSAGE);
  });

  test("a found schema still passes when the rest of the markup is too large to read", () => {
    const html = `<html><body><div itemtype="https://schema.org/Product"></div>${'<i itemtype="https://example.com/Thing"></i>'.repeat(
      MAX_ANNOTATED_ELEMENTS + 1,
    )}</body></html>`;
    expect(only(ctxFor(html, classification("product_detail", 0.99))).status).toBe("pass");
  });

  test("a page with no document cannot be judged", () => {
    const ctx = ctxFor("<html><body></body></html>", classification("product_detail", 0.99));
    const unreadable = { ...ctx, parsed: { ...ctx.parsed, document: null } } as RuleContext;
    const check = only(unreadable);
    expect(check.status).toBe("info");
    expect(check.message).toBe(UNREADABLE_MESSAGE);
  });

  test("missing ctx.options reads as the defaults", () => {
    const ctx = ctxFor("<html><body></body></html>", classification("product_detail", 0.95));
    const noOptions = { ...ctx, options: undefined } as unknown as RuleContext;
    expect(only(noOptions).status).toBe("fail");
  });

  test("blog_post that declares CollectionPage is vetoed: read as a listing, not flagged", () => {
    const check = only(
      ctxFor(withSchema({ "@type": "CollectionPage", name: "Blog" }), classification("blog_post", 0.97)),
    );
    expect(check.status).toBe("pass");
    expect(check.message).toBe("Page declares CollectionPage, read as a listing");
  });

  test("blog_post that declares Blog is vetoed", () => {
    const check = only(ctxFor(withSchema({ "@type": "Blog" }), classification("blog_post", 0.97)));
    expect(check.status).toBe("pass");
  });

  test("blog_post with BlogPosting passes on the family, not the veto", () => {
    const check = only(
      ctxFor(withSchema({ "@type": "BlogPosting" }, { "@type": "ItemList" }), classification("blog_post", 0.97)),
    );
    expect(check.status).toBe("pass");
    expect(check.message).toBe("Blog post declares BlogPosting");
  });

  test("blog_post with no Article-family type fails", () => {
    const check = only(ctxFor(withSchema({ "@type": "WebPage" }), classification("blog_post", 0.97)));
    expect(check.status).toBe("fail");
    expect(check.message).toBe(
      "Reads as a blog post but declares no Article or BlogPosting structured data",
    );
  });

  test("a JobPosting is not an article", () => {
    const check = only(ctxFor(withSchema({ "@type": "JobPosting" }), classification("article", 0.97)));
    expect(check.status).toBe("fail");
  });

  test("a product_detail page is NOT vetoed by OfferCatalog, only by an index type", () => {
    const check = only(ctxFor(withSchema({ "@type": "OfferCatalog" }), classification("product_detail", 0.97)));
    expect(check.status).toBe("fail");
  });

  test("a rules-sourced article label is not applicable, even with no schema", () => {
    const check = only(ctxFor("<html><body></body></html>", classification("article", 0.99, "rules")));
    expect(check.status).toBe("info");
    expect(check.message).toBe(NOT_CONFIDENT);
  });

  test("model 0.85 is below the default 0.9 and not applicable", () => {
    const check = only(ctxFor("<html><body></body></html>", classification("product_detail", 0.85)));
    expect(check.status).toBe("info");
    expect(check.message).toBe(NOT_CONFIDENT);
  });

  test("a page with no classification at all is not applicable", () => {
    const check = only(ctxFor("<html><body></body></html>", undefined));
    expect(check.status).toBe("info");
    expect(check.message).toBe(NOT_CONFIDENT);
  });

  test("contact with no ContactPage or Organization fails", () => {
    const check = only(ctxFor(withSchema({ "@type": "WebPage" }), classification("contact", 0.99)));
    expect(check.status).toBe("fail");
    expect(check.message).toBe("Reads as a contact page but declares no ContactPage or Organization structured data");
  });

  test("contact is satisfied by ContactPage or by an Organization", () => {
    expect(only(ctxFor(withSchema({ "@type": "ContactPage" }), classification("contact", 0.99))).status).toBe("pass");
    expect(only(ctxFor(withSchema({ "@type": "Organization" }), classification("contact", 0.99))).status).toBe("pass");
  });

  test("contact is satisfied by a LocalBusiness subtype that is not spelled Business", () => {
    expect(only(ctxFor(withSchema({ "@type": "Restaurant" }), classification("contact", 0.99))).status).toBe("pass");
  });

  test("about with ProfessionalService passes; so does AboutPage and Person", () => {
    expect(only(ctxFor(withSchema({ "@type": "ProfessionalService" }), classification("about", 0.99))).status).toBe(
      "pass",
    );
    expect(only(ctxFor(withSchema({ "@type": "AboutPage" }), classification("about", 0.99))).status).toBe("pass");
    expect(only(ctxFor(withSchema({ "@type": ["Person", "Thing"] }), classification("about", 0.99))).status).toBe(
      "pass",
    );
  });

  test("any type ending in Business or Organization counts as the organization family", () => {
    expect(
      only(ctxFor(withSchema({ "@type": "HomeAndConstructionBusiness" }), classification("about", 0.99))).status,
    ).toBe("pass");
    expect(only(ctxFor(withSchema({ "@type": "NewsMediaOrganization" }), classification("about", 0.99))).status).toBe(
      "pass",
    );
  });

  test("docs with nothing fails; Article, HowTo and FAQPage each satisfy it", () => {
    const check = only(ctxFor("<html><body></body></html>", classification("docs", 0.93)));
    expect(check.status).toBe("fail");
    expect(check.message).toBe(
      "Reads as a documentation page but declares no Article, TechArticle, HowTo or FAQPage structured data",
    );
    for (const type of ["TechArticle", "HowTo", "FAQPage", "APIReference"]) {
      expect(only(ctxFor(withSchema({ "@type": type }), classification("docs", 0.93))).status).toBe("pass");
    }
  });

  test("listings are satisfied by CollectionPage, ItemList, SearchResultsPage, Blog or OfferCatalog", () => {
    for (const label of ["product_listing", "listing_index"]) {
      for (const type of ["CollectionPage", "ItemList", "SearchResultsPage", "Blog", "OfferCatalog"]) {
        expect(only(ctxFor(withSchema({ "@type": type }), classification(label, 0.95))).status).toBe("pass");
      }
      expect(only(ctxFor(withSchema({ "@type": "WebPage" }), classification(label, 0.95))).status).toBe("fail");
    }
  });

  test("labels with no expectation are not applicable", () => {
    for (const label of ["homepage", "legal", "pricing", "other", "unknown", "something_new"]) {
      const check = only(ctxFor("<html><body></body></html>", classification(label, 0.99)));
      expect(check.status).toBe("info");
    }
  });

  test("min_confidence 0.95 excludes a 0.92 page that the default 0.9 includes", () => {
    const html = "<html><body></body></html>";
    expect(only(ctxFor(html, classification("product_detail", 0.92))).status).toBe("fail");
    const check = only(ctxFor(html, classification("product_detail", 0.92), { min_confidence: 0.95 }));
    expect(check.status).toBe("info");
    expect(check.message).toBe(NOT_CONFIDENT);
  });

  test("a confidence exactly at the threshold is included", () => {
    expect(only(ctxFor("<html><body></body></html>", classification("product_detail", 0.9))).status).toBe("fail");
  });

  test("an out-of-range min_confidence is rejected by the options schema", () => {
    expect(() => only(ctxFor("<html></html>", classification("docs", 0.99), { min_confidence: 4 }))).toThrow();
  });

  test("the rule is registered with the schema category, warning severity and its option", () => {
    const rule = loadAllRules().get("schema/expected-type");
    expect(rule).toBeDefined();
    expect(rule!.meta.category).toBe("schema");
    expect(rule!.meta.severity).toBe("warning");
    expect(rule!.meta.weight).toBe(5);
    expect(rule!.meta.verdictScope).toBe("page");
    expect(Object.keys(rule!.meta.optionsSchema?.shape ?? {})).toEqual(["min_confidence"]);
  });
});

describe("markup-types scans are bounded", () => {
  const parse = (html: string): Document => parsePage(html, "https://example.com/x").document as Document;

  test("microdata and RDFa types are read case-insensitively and split on whitespace", () => {
    const doc = parse(
      '<html><body><div ITEMTYPE="https://schema.org/Product https://schema.org/Offer"></div><p typeof="schema:Person Organization"></p></body></html>',
    );
    const scan = microdataAndRdfaTypes(doc);
    expect(scan.complete).toBe(true);
    expect(scan.types.sort()).toEqual(["Offer", "Organization", "Person", "Product"]);
  });

  test("a token at the cap is read, one past it is not and the scan is incomplete", () => {
    const filler = Array.from({ length: MAX_TOKENS_PER_ATTRIBUTE - 1 }, (_, i) => `https://example.com/T${i}`);
    const atCap = microdataAndRdfaTypes(
      parse(`<html><body><div itemtype="${[...filler, "https://schema.org/Product"].join(" ")}"></div></body></html>`),
    );
    expect(atCap.complete).toBe(true);
    expect(atCap.types).toContain("Product");

    const pastCap = microdataAndRdfaTypes(
      parse(
        `<html><body><div itemtype="${[...filler, "https://example.com/Last", "https://schema.org/Product"].join(" ")}"></div></body></html>`,
      ),
    );
    expect(pastCap.complete).toBe(false);
    expect(pastCap.types).not.toContain("Product");
  });

  test("an element budget stops the walk and reports it", () => {
    const html = `<html><body>${"<b></b>".repeat(MAX_VISITED_NODES + 1)}</body></html>`;
    expect(microdataAndRdfaTypes(parse(html)).complete).toBe(false);
  });

  test("a missing document is incomplete, not empty", () => {
    expect(microdataAndRdfaTypes(null)).toEqual({ types: [], complete: false });
  });

  test("json-ld: nested types are read at the depth cap and not past it", () => {
    let node: Record<string, unknown> = { "@type": "Product" };
    for (let i = 0; i < MAX_JSONLD_DEPTH; i++) node = { "@type": "Thing", child: node };
    const atCap = jsonLdTypes([node]);
    expect(atCap.complete).toBe(true);
    expect(atCap.types).toContain("Product");

    const tooDeep = jsonLdTypes([{ "@type": "Thing", child: node }]);
    expect(tooDeep.complete).toBe(false);
    expect(tooDeep.types).not.toContain("Product");
  });

  test("json-ld: a value budget stops the scan and reports it", () => {
    const wide = { "@type": "ItemList", itemListElement: Array.from({ length: MAX_JSONLD_VALUES + 1 }, () => ({})) };
    expect(jsonLdTypes([wide]).complete).toBe(false);
  });

  test("json-ld: a self-referencing structure cannot loop", () => {
    const cyclic: Record<string, unknown> = { "@type": "Thing" };
    cyclic.self = cyclic;
    expect(jsonLdTypes([cyclic]).complete).toBe(false);
  });
});
