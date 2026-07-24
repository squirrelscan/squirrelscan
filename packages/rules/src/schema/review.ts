// schema/review - Review and AggregateRating schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const reviewSchemaRule: Rule = {
  meta: {
    id: "schema/review",
    name: "Review Schema",
    description: "Validates Review and AggregateRating schema",
    solution:
      "Review schema enables star ratings in search results. AggregateRating needs ratingValue, bestRating (default 5), ratingCount or reviewCount. Individual Review needs author, reviewRating, datePublished. Reviews must be for specific items (Product, LocalBusiness, etc.), not the overall site. Self-reviews violate guidelines.",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let aggregateRating: Record<string, unknown> | null = null;
    let reviews: Record<string, unknown>[] = [];

    for (const script of schemaScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          // Look for aggregateRating in any schema
          if (schema["aggregateRating"]) {
            const raw = schema["aggregateRating"];
            // Some generators array-wrap AggregateRating (#721); take first object entry.
            const candidate = Array.isArray(raw)
              ? raw.find((r) => r && typeof r === "object" && !Array.isArray(r))
              : raw;
            if (candidate) {
              aggregateRating = candidate as Record<string, unknown>;
            }
          }
          if (schema["review"]) {
            const r = schema["review"];
            reviews = reviews.concat(Array.isArray(r) ? r : [r]);
          }

          // Direct AggregateRating type
          if (schema["@type"] === "AggregateRating") {
            aggregateRating = schema;
          }
          // Direct Review type
          if (schema["@type"] === "Review") {
            reviews.push(schema);
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    if (!aggregateRating && reviews.length === 0) {
      checks.push({
        name: "review-schema",
        status: "info",
        message: "No Review or AggregateRating schema found",
      });
      return { checks };
    }

    // Validate AggregateRating
    if (aggregateRating) {
      const ratingValue = aggregateRating["ratingValue"];
      const ratingCount =
        aggregateRating["ratingCount"] || aggregateRating["reviewCount"];

      if (!ratingValue) {
        checks.push({
          name: "aggregate-rating",
          status: "warn",
          message: "AggregateRating missing ratingValue",
        });
      } else if (!ratingCount) {
        checks.push({
          name: "aggregate-rating",
          status: "warn",
          message: "AggregateRating missing ratingCount/reviewCount",
        });
      } else {
        checks.push({
          name: "aggregate-rating",
          status: "pass",
          message: `AggregateRating: ${ratingValue}/5 (${ratingCount} reviews)`,
        });
      }
    }

    // Validate individual reviews
    if (reviews.length > 0) {
      let validReviews = 0;
      let invalidReviews = 0;

      for (const review of reviews) {
        const hasAuthor = !!review["author"];
        const hasRating = !!review["reviewRating"];

        if (hasAuthor && hasRating) {
          validReviews++;
        } else {
          invalidReviews++;
        }
      }

      if (invalidReviews > 0) {
        checks.push({
          name: "individual-reviews",
          status: "warn",
          message: `${invalidReviews} review(s) missing author or rating`,
        });
      }

      if (validReviews > 0) {
        checks.push({
          name: "individual-reviews",
          status: "pass",
          message: `${validReviews} valid review(s) found`,
        });
      }
    }

    return { checks };
  },
};
