// links/internal-links - Validates internal links

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const optionsSchema = z.object({
  min_internal_links: z.number().default(1).describe("Minimum internal links"),
  max_internal_links: z
    .number()
    .default(100)
    .describe("Maximum internal links"),
});

export const internalLinksRule: Rule = {
  meta: {
    id: "links/internal-links",
    name: "Internal Links",
    description: "Validates internal link count",
    solution:
      "Internal links help users navigate your site and distribute page authority. Each page should have at least one internal link pointing to it (not counting navigation). Add contextual internal links from related content. Use descriptive anchor text that indicates what the linked page is about. Avoid orphan pages (no internal links) and ensure important pages receive more internal links. Review your site structure to create logical content clusters.",
    category: "links",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const { links } = ctx.parsed;
    const checks: CheckResult[] = [];

    const internalLinks = links.filter((l) => l.isInternal);
    const count = internalLinks.length;

    if (count < opts.min_internal_links) {
      checks.push({
        name: "internal-links",
        status: "warn",
        message: `Too few internal links (${count}, min ${opts.min_internal_links})`,
        value: count,
        expected: opts.min_internal_links,
      });
    } else if (count > opts.max_internal_links) {
      checks.push({
        name: "internal-links",
        status: "warn",
        message: `Too many internal links (${count}, max ${opts.max_internal_links})`,
        value: count,
        expected: opts.max_internal_links,
      });
    } else {
      checks.push({
        name: "internal-links",
        status: "pass",
        message: `${count} internal link(s)`,
        value: count,
      });
    }

    return { checks };
  },
};
