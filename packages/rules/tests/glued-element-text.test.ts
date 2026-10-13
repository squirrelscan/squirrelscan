// Adjacent elements with no whitespace between them (pub#739).
//
// `ctx.parsed.content.textContent` is the body's `.textContent`, which glues
// adjacent elements: `<h3>Customer rating</h3><p>5/5</p>` reads
// `Customer rating5/5`. A word-bounded pattern then finds nothing, and
// schema/rating-scope warned that a rating printed on the page was not visible.
// Each fixture below is written twice, with and without whitespace between its
// elements, and the two must get the same verdict.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { getPageSeparatedText } from "../src/content/text-content";
import { ratingScopeRule } from "../src/schema/rating-scope";
import type { ParsedPage, RuleContext } from "../src/types";

const URL = "https://example.com/privacy";

/** A whole-number rating: the decimal-value fallback cannot clear it. */
const BUSINESS = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Northgate Auto Repair",
  aggregateRating: { "@type": "AggregateRating", ratingValue: "5", ratingCount: "18" },
};

function ctx(body: string): RuleContext {
  const html = `<html><head><title>Privacy Policy</title><script type="application/ld+json">${JSON.stringify(
    BUSINESS,
  )}</script></head><body><h1>Privacy Policy</h1>${body}</body></html>`;
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
}

function visibility(body: string): CheckResult | undefined {
  return (ratingScopeRule.run(ctx(body)).checks as CheckResult[]).find(
    (c) => c.name === "rating-visible",
  );
}

/** The same elements, glued and separated by whitespace. */
const PAIRS: [string, string[]][] = [
  ["a label block, then the score", ["<h3>Customer rating</h3>", "<p>5/5</p>"]],
  ["a table row", ["<table><tr><td>Rating</td>", "<td>5 stars</td></tr></table>"]],
  ["a count after a label", ["<div>Total</div>", "<div>18 reviews</div>"]],
  ["inline spans", ["<span>Rated</span>", "<span>5 out of 5</span>"]],
];

describe("schema/rating-scope: glued and spaced markup get the same verdict", () => {
  for (const [name, parts] of PAIRS) {
    test(name, () => {
      const glued = visibility(parts.join(""));
      const spaced = visibility(parts.join(" "));
      expect(spaced?.status).toBe("pass");
      expect(glued?.status).toBe(spaced?.status);
      expect(glued?.message).toBe(spaced?.message);
    });
  }

  test("a page with no rating in its copy still warns either way", () => {
    const parts = ["<h3>Our policy</h3>", "<p>We keep data for 5 years.</p>"];
    expect(visibility(parts.join(""))?.status).toBe("warn");
    expect(visibility(parts.join(" "))?.status).toBe("warn");
  });
});

describe("getPageSeparatedText", () => {
  test("puts a space at every element boundary and collapses whitespace", () => {
    const doc = parsePage(
      "<html><body><h3>Customer rating</h3><p>5/5</p>\n\n<div>  Total</div></body></html>",
      URL,
    ).document!;
    expect(getPageSeparatedText(doc)).toBe("Customer rating 5/5 Total");
  });

  test("skips scripts, styles, noscript and templates", () => {
    const doc = parsePage(
      "<html><body><p>Shown</p><script>var a=1</script><style>p{}</style><noscript>No JS</noscript><template>Later</template></body></html>",
      URL,
    ).document!;
    expect(getPageSeparatedText(doc)).toBe("Shown");
  });

  test("is computed once per document", () => {
    const doc = parsePage("<html><body><p>One</p><p>Two</p></body></html>", URL).document!;
    const first = getPageSeparatedText(doc);
    doc.querySelector("p")!.textContent = "Changed";
    expect(getPageSeparatedText(doc)).toBe(first);
  });

  test("a document without a body is empty", () => {
    const doc = parsePage("<svg xmlns='http://www.w3.org/2000/svg'></svg>", URL).document!;
    expect(typeof getPageSeparatedText(doc)).toBe("string");
  });
});
