// ai/page-type-match - cloud page-type classification vs declared structured data

import type { AiParseResult } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

// JSON-LD @type → the classification the cloud service should agree with.
const SCHEMA_TYPE_TO_PAGE_TYPE: Record<string, string> = {
  Article: "article",
  BlogPosting: "article",
  NewsArticle: "article",
  TechArticle: "article",
  Product: "product",
  ContactPage: "contact",
  AboutPage: "about",
  CollectionPage: "category",
  ItemList: "listing",
  FAQPage: "docs",
};

/** Only flag when classification confidence is at least this high. */
const MIN_CONFIDENCE = 0.7;

export const pageTypeMatchRule: Rule = {
  meta: {
    id: "ai/page-type-match",
    name: "Page Type Match",
    description:
      "Checks that the page's AI-classified type agrees with its declared structured data",
    solution:
      "A mismatch between what a page IS (as an AI or search engine reads it) and what its structured data declares confuses rich-result eligibility and AI answers. Either fix the JSON-LD @type to describe the page truthfully, or restructure the page content so its primary purpose is unambiguous.",
    category: "ax",
    scope: "page",
    severity: "warning",
    weight: 3,
    cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<AiParseResult>(ctx.cloudResults, "ai-parse", ctx.page.url);
    if (!envelope || envelope.status === "skipped") {
      const reason = envelope?.skipReason ?? "not-prefetched";
      checks.push({
        name: "page-type-match",
        status: "skipped",
        message: "Page type classification skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const classified = envelope.data;
    if (!classified) {
      checks.push({
        name: "page-type-match",
        status: "skipped",
        message: "No classification returned for this page",
        skipReason: humanizeCloudSkip("service-unavailable"),
      });
      return { checks };
    }

    // Expected type from declared JSON-LD (first mapped @type wins).
    const declared = ctx.parsed.schemas.types.find((t) => SCHEMA_TYPE_TO_PAGE_TYPE[t]);
    const expected = declared ? SCHEMA_TYPE_TO_PAGE_TYPE[declared] : null;

    if (!expected) {
      checks.push({
        name: "page-type-match",
        status: "pass",
        message: `Classified as "${classified.pageType}" (no page-type structured data to compare)`,
        value: classified.pageType,
      });
      return { checks };
    }

    if (classified.pageType === expected || classified.confidence < MIN_CONFIDENCE) {
      checks.push({
        name: "page-type-match",
        status: "pass",
        message: `Page type "${classified.pageType}" matches declared ${declared} schema`,
        value: classified.pageType,
        expected,
      });
    } else {
      checks.push({
        name: "page-type-match",
        status: "warn",
        message: `Page reads as "${classified.pageType}" but declares ${declared} structured data`,
        value: classified.pageType,
        expected,
      });
    }

    return { checks };
  },
};
