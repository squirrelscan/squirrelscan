// content/word-count - Checks for thin content

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const optionsSchema = z.object({
  min_words: z.number().default(300).describe("Minimum word count"),
  warn_threshold: z
    .number()
    .default(500)
    .describe("Word count for optimal content"),
});

export const wordCountRule: Rule = {
  meta: {
    id: "content/word-count",
    name: "Word Count",
    description: "Checks content length for thin content issues",
    solution:
      "Pages with thin content (under 300 words) often struggle to rank well and are actively deindexed by Google since the June 2025 core update. Add more valuable, relevant content to thin pages—aim for at least 500 words for standard pages and 1000+ for in-depth articles. If a page can't be fleshed out, voluntarily noindex it or consolidate it into a more comprehensive resource. Trimming thin pages from your index is better than leaving low-value content for Google to penalize.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const { content } = ctx.parsed;
    const checks: CheckResult[] = [];

    if (content.wordCount < opts.min_words) {
      checks.push({
        name: "word-count",
        status: "warn",
        message: `Thin content: ${content.wordCount} words (min ${opts.min_words})`,
        value: content.wordCount,
        expected: opts.min_words,
      });
    } else if (content.wordCount < opts.warn_threshold) {
      checks.push({
        name: "word-count",
        status: "info",
        message: `Content could be longer: ${content.wordCount} words`,
        value: content.wordCount,
      });
    } else {
      checks.push({
        name: "word-count",
        status: "pass",
        message: `Good content length: ${content.wordCount} words`,
        value: content.wordCount,
      });
    }

    return { checks };
  },
};
