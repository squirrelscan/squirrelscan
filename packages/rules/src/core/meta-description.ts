// core/meta-description - Validates meta description presence and length

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { pageTypeSkip, skippablePageType } from "../shared/page-type";

/** Page types whose short title or description is normal (pub#841). */
const SHORT_OK_PAGE_TYPES = ["contact", "legal"] as const;

export const optionsSchema = z.object({
  min_length: z.number().default(120).describe("Minimum description length"),
  max_length: z.number().default(160).describe("Maximum description length"),
});

export const metaDescriptionRule: Rule = {
  meta: {
    id: "core/meta-description",
    name: "Meta Description",
    description: "Validates meta description presence and length",
    solution:
      "Meta descriptions should be 120-160 characters and provide a compelling summary of the page. While not a direct ranking factor, good descriptions improve click-through rates from search results. Write unique descriptions for each page that accurately preview the content. Include a call-to-action when appropriate. If missing, search engines will auto-generate snippets which may not represent your page optimally.",
    category: "core",
    scope: "page",
    verdictScope: "page",
    // Search-result presentation only: skipped on noindex pages (pub#457).
    skipOnNoindex: true,
    severity: "error",
    weight: 7,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const { description } = ctx.parsed.meta;
    const checks: CheckResult[] = [];

    if (!description) {
      checks.push({
        name: "meta-description",
        status: "fail",
        message: "Missing meta description",
        value: null,
      });
      return { checks };
    }

    const len = description.length;

    // Separate checks per side, both reported on every page: see core/meta-title (pub#1765).
    const label = (bound: "under" | "over", limit: number) => [
      { id: ctx.page.url, label: `${description.slice(0, 50)} (${len} chars, ${bound} ${limit})` },
    ];
    const expected = `${opts.min_length}-${opts.max_length} characters`;
    const tooShort = len < opts.min_length;
    const tooLong = len > opts.max_length;
    const skipType = tooShort ? skippablePageType(ctx.parsed, SHORT_OK_PAGE_TYPES) : null;

    if (tooShort && skipType !== null) {
      // A contact or legal page is not a search target worth a long snippet (pub#841). Too long still applies.
      checks.push(pageTypeSkip("meta-description-too-short", skipType, "The description length floor"));
    } else if (tooShort) {
      checks.push({
        name: "meta-description-too-short",
        status: "warn",
        message: `Description too short (${len} chars, min ${opts.min_length})`,
        value: description,
        expected,
        items: label("under", opts.min_length),
      });
    } else {
      checks.push({ name: "meta-description-too-short", status: "pass", message: "Description is long enough", value: description });
    }
    if (tooLong) {
      checks.push({
        name: "meta-description-too-long",
        status: "warn",
        message: `Description too long (${len} chars, max ${opts.max_length})`,
        value: description,
        expected,
        items: label("over", opts.max_length),
      });
    } else {
      checks.push({ name: "meta-description-too-long", status: "pass", message: "Description is short enough", value: description });
    }

    return { checks };
  },
};
