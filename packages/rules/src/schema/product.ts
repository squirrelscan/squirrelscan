// schema/product - Product schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const REQUIRED_PROPS = ["name", "image"];

export const productSchemaRule: Rule = {
  meta: {
    id: "schema/product",
    name: "Product Schema",
    description: "Validates Product schema for e-commerce",
    solution:
      "Product schema enables rich results in search. Required: name, image. For offers, include price, priceCurrency, availability. Add reviews with AggregateRating for star ratings. Include brand, sku, gtin for product identification. Ensure price and availability are accurate and updated.",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let productSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          const type = schema["@type"];
          if (
            type === "Product" ||
            (Array.isArray(type) && type.includes("Product"))
          ) {
            productSchema = schema;
            break;
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    if (!productSchema) {
      checks.push({
        name: "product-schema",
        status: "info",
        message: "No Product schema found",
      });
      return { checks };
    }

    // Check required properties
    const missing: string[] = [];
    for (const prop of REQUIRED_PROPS) {
      if (!productSchema[prop]) {
        missing.push(prop);
      }
    }

    if (missing.length > 0) {
      checks.push({
        name: "product-required",
        status: "warn",
        message: `Product schema missing required properties`,
        items: missing.map((prop) => ({ id: prop })),
      });
    } else {
      checks.push({
        name: "product-required",
        status: "pass",
        message: "Product schema has required properties",
      });
    }

    // Check for Offer
    const offers = productSchema["offers"];
    if (!offers) {
      checks.push({
        name: "product-offers",
        status: "info",
        message: "Product schema has no offers/pricing",
        value: "Add Offer with price and availability",
      });
    } else {
      const offer = Array.isArray(offers) ? offers[0] : offers;
      const hasPrice = offer && (offer as Record<string, unknown>)["price"];
      const hasAvailability =
        offer && (offer as Record<string, unknown>)["availability"];

      if (!hasPrice || !hasAvailability) {
        checks.push({
          name: "product-offer-details",
          status: "warn",
          message: "Product Offer missing price or availability",
        });
      }
    }

    // Check for reviews
    const hasReview =
      productSchema["review"] || productSchema["aggregateRating"];
    if (hasReview) {
      checks.push({
        name: "product-reviews",
        status: "pass",
        message: "Product has review/rating data",
      });
    }

    return { checks };
  },
};
