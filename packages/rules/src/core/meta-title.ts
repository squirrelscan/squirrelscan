// core/meta-title - Validates page title presence and length

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const optionsSchema = z.object({
  min_length: z.number().default(30).describe("Minimum title length"),
  max_length: z.number().default(75).describe("Maximum title length"),
});

export const metaTitleRule: Rule = {
  meta: {
    id: "core/meta-title",
    name: "Meta Title",
    description: "Validates page title presence and length",
    solution:
      "Every page needs a unique, descriptive title tag between 30-75 characters. Titles appear in browser tabs, search results, and social shares. Write titles that accurately describe the page content while including your primary keyword near the beginning. If your title is too short, add more descriptive context. If too long, prioritize the most important information first and trim secondary details. Avoid keyword stuffing or duplicate titles across pages.",
    category: "core",
    scope: "page",
    severity: "error",
    weight: 8,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const { title } = ctx.parsed.meta;
    const checks: CheckResult[] = [];

    if (!title) {
      checks.push({
        name: "meta-title",
        status: "fail",
        message: "Missing page title",
        value: null,
      });
      checks.push({
        name: "document-title",
        status: "fail",
        message: "Missing document title",
        value: null,
      });
      return { checks };
    }

    const len = title.length;

    if (len < opts.min_length) {
      checks.push({
        name: "meta-title",
        status: "warn",
        message: "Title too short",
        value: title,
        expected: `${opts.min_length}-${opts.max_length} characters`,
        items: [
          { id: ctx.page.url, label: `${title.slice(0, 50)} (${len} chars)` },
        ],
      });
    } else if (len > opts.max_length) {
      checks.push({
        name: "meta-title",
        status: "warn",
        message: "Title too long",
        value: title,
        expected: `${opts.min_length}-${opts.max_length} characters`,
        items: [
          { id: ctx.page.url, label: `${title.slice(0, 50)} (${len} chars)` },
        ],
      });
    } else {
      checks.push({
        name: "meta-title",
        status: "pass",
        message: "Title length OK",
        value: title,
      });
    }

    return { checks };
  },
};
