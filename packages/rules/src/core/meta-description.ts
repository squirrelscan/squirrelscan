// core/meta-description - Validates meta description presence and length

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

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

    if (len < opts.min_length) {
      checks.push({
        name: "meta-description",
        status: "warn",
        message: "Description too short",
        value: description,
        expected: `${opts.min_length}-${opts.max_length} characters`,
        items: [
          {
            id: ctx.page.url,
            label: `${description.slice(0, 50)} (${len} chars)`,
          },
        ],
      });
    } else if (len > opts.max_length) {
      checks.push({
        name: "meta-description",
        status: "warn",
        message: "Description too long",
        value: description,
        expected: `${opts.min_length}-${opts.max_length} characters`,
        items: [
          {
            id: ctx.page.url,
            label: `${description.slice(0, 50)} (${len} chars)`,
          },
        ],
      });
    } else {
      checks.push({
        name: "meta-description",
        status: "pass",
        message: "Description length OK",
        value: description,
      });
    }

    return { checks };
  },
};
