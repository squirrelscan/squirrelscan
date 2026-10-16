// pub#869: four more schema rules read a property written as a JSON-LD node
// reference (`{"@id": …}`) from the node it names, as schema/faq, product and
// review do since pub#817. A dangling reference is still judged as written.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { breadcrumbSchemaRule } from "../src/schema/breadcrumb";
import { localBusinessSchemaRule } from "../src/schema/local-business";
import { ratingScopeRule } from "../src/schema/rating-scope";
import { websiteSearchSchemaRule as websiteSearchRule } from "../src/schema/website-search";
import type { Rule, RuleContext } from "../src/types";

const BASE = "https://example.com";

function run(rule: Rule, url: string, graph: unknown[], body = "<h1>Page</h1>"): Record<string, string> {
  const ld = JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
  const html = `<!doctype html><html lang="en"><head><title>t</title><script type="application/ld+json">${ld}</script></head><body>${body}</body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("unexpected async rule");
  const out: Record<string, string> = {};
  for (const c of result.checks) out[c.name] = `${c.status}: ${c.message}`;
  return out;
}

describe("schema/breadcrumb — itemListElement references (pub#869)", () => {
  const url = `${BASE}/shop/anvils`;
  const items = [
    { "@type": "ListItem", "@id": `${BASE}/#crumb-1`, position: 1, name: "Shop", item: `${BASE}/shop` },
    // A relative @id resolves against the page URL, like the reference to it.
    { "@type": "ListItem", "@id": "#crumb-2", position: 2, name: "Anvils" },
  ];

  test("references into the same @graph are read from the ListItem nodes", () => {
    const list = { "@type": "BreadcrumbList", itemListElement: [{ "@id": `${BASE}/#crumb-1` }, { "@id": "#crumb-2" }] };
    expect(run(breadcrumbSchemaRule, url, [list, ...items])).toMatchObject({
      "breadcrumb-valid": "pass: BreadcrumbList has 2 item(s)",
    });
  });

  test("a dangling reference, or a null entry, is an item with no position or name", () => {
    for (const entry of [{ "@id": `${BASE}/#nowhere` }, null]) {
      const list = { "@type": "BreadcrumbList", itemListElement: [{ "@id": `${BASE}/#crumb-1` }, entry] };
      expect(run(breadcrumbSchemaRule, url, [list, ...items])).toMatchObject({
        "breadcrumb-items": "warn: Some breadcrumb items missing position or name",
      });
    }
  });
});

describe("schema/local-business — address references (pub#869)", () => {
  const address = {
    "@type": "PostalAddress",
    "@id": `${BASE}/#address`,
    streetAddress: "1 Forge Lane",
    addressLocality: "Springfield",
    postalCode: "12345",
  };
  const business = (addressValue: unknown) => ({
    "@type": "LocalBusiness",
    name: "Acme Anvils",
    telephone: "+1-555-0100",
    address: addressValue,
  });

  test("an address referenced by @id is read from the PostalAddress node", () => {
    expect(run(localBusinessSchemaRule, `${BASE}/`, [business({ "@id": "#address" }), address])).not.toHaveProperty(
      "local-business-address",
    );
    // Array-wrapped too.
    expect(run(localBusinessSchemaRule, `${BASE}/`, [business([{ "@id": `${BASE}/#address` }]), address])).not.toHaveProperty(
      "local-business-address",
    );
  });

  test("a dangling address reference is still an incomplete address", () => {
    expect(run(localBusinessSchemaRule, `${BASE}/`, [business({ "@id": "#nowhere" }), address])).toMatchObject({
      "local-business-address": "warn: Address incomplete",
    });
  });
});

describe("schema/website-search — potentialAction references (pub#869)", () => {
  const action = {
    "@type": "SearchAction",
    "@id": `${BASE}/#search`,
    target: `${BASE}/search?q={search_term_string}`,
    "query-input": "required name=search_term_string",
  };

  test("a SearchAction referenced by @id is read from its node", () => {
    const site = { "@type": "WebSite", url: `${BASE}/`, potentialAction: { "@id": "#search" } };
    expect(run(websiteSearchRule, `${BASE}/`, [site, action])).toMatchObject({
      "search-action": "pass: SearchAction properly configured",
    });
  });

  test("a dangling reference is judged as written: no SearchAction", () => {
    const site = { "@type": "WebSite", url: `${BASE}/`, potentialAction: [{ "@id": "#nowhere" }, null] };
    expect(run(websiteSearchRule, `${BASE}/`, [site, action])).toMatchObject({
      "website-search": "info: WebSite has no SearchAction",
    });
  });
});

describe("schema/rating-scope — aggregateRating references (pub#869)", () => {
  const PRIVACY =
    "<h1>Privacy Policy</h1><p>We collect the information you give us when you book a repair " +
    "and keep it only as long as we need it.</p>";
  const rating = { "@type": "AggregateRating", "@id": `${BASE}/privacy#rating`, ratingValue: "4.9", ratingCount: "18" };
  const business = { "@type": "LocalBusiness", name: "Northgate Auto Repair", aggregateRating: { "@id": "#rating" } };

  test("a referenced rating is the business's, counted once", () => {
    const checks = run(ratingScopeRule, `${BASE}/privacy`, [business, rating], PRIVACY);
    expect(checks["rating-visible"]).toStartWith("warn:");
    expect(checks["rating-visible"]).toContain("LocalBusiness");
    expect(checks["rating-visible"]).toContain("4.9");
  });

  test("a referenced rating node with no @type of its own is read too", () => {
    const untyped = { "@id": `${BASE}/privacy#rating`, ratingValue: "4.9", ratingCount: "18" };
    const shown = `${PRIVACY}<p>Rated 4.9 from 18 reviews.</p>`;
    // Its value is on the page, so it is visible: no visibility warning.
    expect(run(ratingScopeRule, `${BASE}/privacy`, [business, untyped], shown)["rating-visible"]).not.toStartWith("warn:");
  });

  test("the same rating inline reads the same", () => {
    const inline = { ...business, aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9", ratingCount: "18" } };
    const byRef = run(ratingScopeRule, `${BASE}/privacy`, [business, rating], PRIVACY);
    expect(run(ratingScopeRule, `${BASE}/privacy`, [inline], PRIVACY)).toEqual(byRef);
  });
});
