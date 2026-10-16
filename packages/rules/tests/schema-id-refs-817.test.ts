// pub#817: JSON-LD node references (`{"@id": …}`) inside one page resolve to
// the node they name before a schema rule reads them. Yoast and many SEO
// playbooks emit `FAQPage.mainEntity` as references to `Question` nodes
// elsewhere in the same `@graph`; schema/faq checked the reference objects and
// reported every question as missing its name and answer. schema/product
// (offers) and schema/review (reviews, aggregateRating) read nested nodes the
// same way.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { faqSchemaRule as faqRule } from "../src/schema/faq";
import { productSchemaRule as productRule } from "../src/schema/product";
import { reviewSchemaRule as reviewRule } from "../src/schema/review";
import type { Rule, RuleContext } from "../src/types";

const BASE = "http://127.0.0.1:8765/";

function run(rule: Rule, ...blocks: unknown[]): Record<string, string> {
  const scripts = blocks
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><title>t</title>${scripts}</head><body><h1>t</h1></body></html>`;
  const ctx = {
    page: { url: BASE, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, BASE),
    options: {},
  } as unknown as RuleContext;
  const out: Record<string, string> = {};
  for (const c of rule.run(ctx).checks as Array<{ name: string; status: string; message: string }>) {
    // A rule may emit a warn and a pass under one name: keep both.
    out[out[c.name] ? `${c.name}#${c.status}` : c.name] = `${c.status}: ${c.message}`;
  }
  return out;
}

const question = (id: string, over: Record<string, unknown> = {}) => ({
  "@type": "Question",
  "@id": `${BASE}#${id}`,
  name: "What is it?",
  acceptedAnswer: { "@type": "Answer", text: "A repro." },
  ...over,
});

describe("schema/faq — mainEntity @id references (pub#817)", () => {
  test("the issue's repro: references into the same @graph resolve, like the inlined control", () => {
    const repro = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": ["WebPage", "FAQPage"],
          "@id": `${BASE}#webpage`,
          url: BASE,
          name: "FAQ",
          mainEntity: [{ "@id": `${BASE}#q1` }],
        },
        question("q1"),
      ],
    };
    const inlined = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [question("q1")],
    };
    expect(run(faqRule, repro)).toEqual(run(faqRule, inlined));
    expect(run(faqRule, repro)["faq-valid"]).toBe("pass: FAQPage has 1 valid question(s)");
  });

  test("a reference to a node in another script on the page resolves too", () => {
    const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@id": `${BASE}#q1` }, { "@id": `${BASE}#q2` }] };
    const questions = { "@context": "https://schema.org", "@graph": [question("q1"), question("q2")] };
    expect(run(faqRule, faq, questions)["faq-valid"]).toBe("pass: FAQPage has 2 valid question(s)");
  });

  test("a dangling reference, or a referenced Question without an answer, is still reported", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "FAQPage", mainEntity: [{ "@id": `${BASE}#q1` }, { "@id": `${BASE}#gone` }, { "@id": `${BASE}#q3` }] },
        question("q1"),
        question("q3", { acceptedAnswer: undefined }),
      ],
    };
    expect(run(faqRule, graph)).toMatchObject({
      "faq-questions": "warn: 2 question(s) missing required properties",
    });
  });
});

describe("schema/faq — entries that are not objects (pub#817 review)", () => {
  test("a null or a bare string in mainEntity is an invalid question, not a crash", () => {
    const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [null, "What?", question("q1")] };
    expect(run(faqRule, faq)).toMatchObject({ "faq-questions": "warn: 2 question(s) missing required properties" });
  });
});

describe("schema/product and schema/review — @id references (pub#817)", () => {
  test("a Product's offers referenced by @id are read from the Offer node", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product", name: "Chair", image: `${BASE}c.jpg`, offers: { "@id": `${BASE}#offer` } },
        { "@type": "Offer", "@id": `${BASE}#offer`, price: "10", priceCurrency: "EUR", availability: "https://schema.org/InStock" },
      ],
    };
    expect(run(productRule, graph)["product-offer-details"]).toBeUndefined();
  });

  test("reviews and an aggregateRating referenced by @id are read from their nodes, each review once", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Product",
          name: "Chair",
          aggregateRating: { "@id": `${BASE}#rating` },
          review: [{ "@id": `${BASE}#r1` }],
        },
        { "@type": "AggregateRating", "@id": `${BASE}#rating`, ratingValue: "4.5", reviewCount: "12" },
        {
          "@type": "Review",
          "@id": `${BASE}#r1`,
          author: { "@type": "Person", name: "Ann" },
          reviewRating: { "@type": "Rating", ratingValue: "5" },
        },
      ],
    };
    const result = run(reviewRule, graph);
    expect(result["aggregate-rating"]).toStartWith("pass");
    expect(Object.values(result).filter((v) => v.startsWith("warn"))).toEqual([]);
    expect(Object.values(result).join("\n")).toContain("1 valid review");
  });
});

describe("@id resolution edge cases (pub#817 review)", () => {
  test("a reference carrying @context, and a relative @id, resolve", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "FAQPage",
          mainEntity: [{ "@context": "https://schema.org", "@id": `${BASE}#q1` }, { "@id": "#q2" }],
        },
        question("q1"),
        question("q2"),
      ],
    };
    expect(run(faqRule, graph)["faq-valid"]).toBe("pass: FAQPage has 2 valid question(s)");
  });

  test("an Offer defined inline on one node resolves from a reference on another", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          about: {
            "@type": "Offer",
            "@id": `${BASE}#offer`,
            price: "10",
            priceCurrency: "EUR",
            availability: "https://schema.org/InStock",
          },
        },
        { "@type": "Product", name: "Chair", image: `${BASE}c.jpg`, offers: { "@id": `${BASE}#offer` } },
      ],
    };
    expect(run(productRule, graph)["product-offer-details"]).toBeUndefined();
  });

  test("a minimal Review stub and its references are one review; a stub never empties a resolved rating", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product", name: "Chair", review: [{ "@id": `${BASE}#r1` }], aggregateRating: { "@id": `${BASE}#rating` } },
        { "@type": "Review", "@id": `${BASE}#r1` },
        { "@type": "AggregateRating", "@id": `${BASE}#rating`, ratingValue: "4.5", reviewCount: "12" },
        { "@type": "AggregateRating", "@id": `${BASE}#rating` },
      ],
    };
    const result = run(reviewRule, graph);
    expect(result["individual-reviews"]).toBe("warn: 1 review(s) missing author or rating");
    expect(result["aggregate-rating"]).toStartWith("pass");
  });
});
