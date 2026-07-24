// eeat/trust-signals - Trust badges and security indicators

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

export const trustSignalsRule: Rule = {
  meta: {
    id: "eeat/trust-signals",
    name: "Trust Signals",
    description: "Checks for trust badges, certifications, and social proof",
    solution:
      "Trust signals help visitors feel confident. Include: security badges (Norton, McAfee), payment badges (Visa, PayPal), certifications (BBB, industry-specific), customer reviews/testimonials, and social proof (customer count, awards). Place trust signals prominently on homepage, checkout, and contact pages.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "trust-signals",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Check for review/rating schema
    let hasReviewSchema = false;
    let hasTestimonials = false;

    for (const page of pages) {
      if (
        page.parsed.schema.types.includes("Review") ||
        page.parsed.schema.types.includes("AggregateRating")
      ) {
        hasReviewSchema = true;
      }

      // Check for testimonial section (heuristic)
      const path = getPathname(page.url);
      if (/testimonial|review|customer-stories/i.test(path)) {
        hasTestimonials = true;
      }
    }

    const signals: string[] = [];

    if (hasReviewSchema) {
      signals.push("Review/Rating schema");
    }

    if (hasTestimonials) {
      signals.push("Testimonials section");
    }

    if (signals.length > 0) {
      checks.push({
        name: "trust-signals",
        status: "pass",
        message: `${signals.length} trust signal(s) detected`,
        items: signals.map((signal) => ({ id: signal })),
      });
    } else {
      checks.push({
        name: "trust-signals",
        status: "info",
        message: "Limited trust signals detected",
        value: "Consider adding reviews, testimonials, or certifications",
      });
    }

    return { checks };
  },
};
