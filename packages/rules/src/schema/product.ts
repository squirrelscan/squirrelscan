// schema/product - Product schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes } from "@squirrelscan/utils";

import { fieldEvidenceCheck, readProductEvidence, type ProductField } from "./product-evidence";

const REQUIRED_PROPS: ProductField[] = ["name", "image"];

export const productSchemaRule: Rule = {
  meta: {
    id: "schema/product",
    name: "Product Schema",
    description: "Validates Product schema for e-commerce",
    solution:
      "Product schema enables rich results in search. Required: name, image. For offers, include price, priceCurrency, availability. Add reviews with AggregateRating for star ratings. Include brand, sku, gtin for product identification. Ensure price and availability are accurate and updated.",
    category: "schema",
    scope: "page",
    verdictScope: "page",
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
    // pub#817: every node on the page, so an `offers` reference resolves.
    const pageNodes: Record<string, unknown>[] = [];

    for (const script of schemaScripts) {
      // Flattened per script, so a Yoast / Rank Math `@graph` wrapper is
      // descended into rather than read as one typeless node (#317). Per
      // SCRIPT and not over the joined `schema.raw`, because that join can
      // mis-split a pretty-printed block (#1099). Unparseable JSON yields an
      // empty list, which is what the old try/catch was for.
      const schemas = flattenJsonLdNodes(script.textContent || "");
      pageNodes.push(...schemas);

      for (const schema of schemas) {
        const type = schema["@type"];
        if (
          type === "Product" ||
          type === "ProductGroup" ||
          (Array.isArray(type) && (type.includes("Product") || type.includes("ProductGroup")))
        ) {
          productSchema = schema;
          break;
        }
      }
    }

    const evidence = readProductEvidence(ctx, pageNodes, productSchema);

    if (!evidence) {
      checks.push({
        name: "product-schema",
        status: "info",
        message: "No Product schema found",
      });
      return { checks };
    }

    const statusOf = (field: ProductField) => evidence.fields.find((f) => f.field === field)?.status;

    // Required properties. Only a field proven absent from a complete read
    // warns; an unchecked one (truncated read, rendered-only shell) does not.
    const missing = REQUIRED_PROPS.filter((prop) => statusOf(prop) === "absent");
    const unchecked = REQUIRED_PROPS.filter((prop) => statusOf(prop) === "unknown");

    if (missing.length > 0) {
      checks.push({
        name: "product-required",
        status: "warn",
        message: `Product schema missing required properties`,
        items: missing.map((prop) => ({ id: prop })),
      });
    } else if (unchecked.length > 0) {
      checks.push({
        name: "product-required",
        status: "info",
        message: "Product required properties could not all be checked",
        items: unchecked.map((prop) => ({ id: prop })),
      });
    } else {
      checks.push({
        name: "product-required",
        status: "pass",
        message: "Product schema has required properties",
      });
    }

    // Check for Offer
    if (!evidence.hasOffers) {
      // Without a complete read an absent Offer is not proven: the evidence
      // check below carries the unknown price and availability instead.
      if (evidence.read === "complete" && statusOf("price") !== "unknown") {
        checks.push({
          name: "product-offers",
          status: "info",
          message: "Product schema has no offers/pricing",
          value: "Add Offer with price and availability",
        });
      }
    } else if (statusOf("price") === "absent" || statusOf("availability") === "absent") {
      checks.push({
        name: "product-offer-details",
        status: "warn",
        message: "Product Offer missing price or availability",
      });
    }

    checks.push(fieldEvidenceCheck(evidence));

    // Check for reviews
    const hasReview =
      productSchema?.["review"] || productSchema?.["aggregateRating"];
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
