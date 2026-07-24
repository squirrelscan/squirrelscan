// content/article-links - Article link density based on content length

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const optionsSchema = z.object({
  // Word count thresholds
  short_max_words: z.number().default(800),
  long_min_words: z.number().default(1500),
  // Internal link minimums
  short_min_internal: z.number().default(1),
  medium_min_internal: z.number().default(2),
  long_min_internal: z.number().default(3),
  // External link minimums
  short_min_external: z.number().default(1),
  medium_min_external: z.number().default(2),
  long_min_external: z.number().default(2),
});

export const articleLinksRule: Rule = {
  meta: {
    id: "content/article-links",
    name: "Article Link Density",
    description:
      "Articles should have appropriate internal and external links based on length",
    solution:
      "Add relevant internal links to other pages on your site and cite authoritative external sources. Short articles (<800 words) need at least 1 of each, medium (800-1500) need 2 of each, long (>1500) need 3 internal and 2 external.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const opts = optionsSchema.parse(ctx.options);
    const { pageType, content, links, schemas } = ctx.parsed;

    // Only apply to articles
    const isArticle = pageType === "article" || schemas.article !== null;
    if (!isArticle) {
      return {
        checks: [
          {
            name: "article-links",
            status: "info",
            message: "Not an article page",
          },
        ],
      };
    }

    // Count links
    const internalLinks = links.filter((l) => l.isInternal).length;
    const externalLinks = links.filter((l) => !l.isInternal).length;
    const wordCount = content.wordCount;

    // Determine thresholds based on length
    let minInternal: number;
    let minExternal: number;
    let lengthCategory: string;

    if (wordCount < opts.short_max_words) {
      minInternal = opts.short_min_internal;
      minExternal = opts.short_min_external;
      lengthCategory = "short";
    } else if (wordCount < opts.long_min_words) {
      minInternal = opts.medium_min_internal;
      minExternal = opts.medium_min_external;
      lengthCategory = "medium";
    } else {
      minInternal = opts.long_min_internal;
      minExternal = opts.long_min_external;
      lengthCategory = "long";
    }

    // Check internal links
    if (internalLinks < minInternal) {
      checks.push({
        name: "internal-links",
        status: "warn",
        message: `${lengthCategory} article has ${internalLinks} internal links (min ${minInternal})`,
        value: internalLinks,
        expected: minInternal,
      });
    } else {
      checks.push({
        name: "internal-links",
        status: "pass",
        message: `${internalLinks} internal links`,
        value: internalLinks,
      });
    }

    // Check external links
    if (externalLinks < minExternal) {
      checks.push({
        name: "external-links",
        status: "warn",
        message: `${lengthCategory} article has ${externalLinks} external links (min ${minExternal})`,
        value: externalLinks,
        expected: minExternal,
      });
    } else {
      checks.push({
        name: "external-links",
        status: "pass",
        message: `${externalLinks} external links`,
        value: externalLinks,
      });
    }

    return { checks };
  },
};
