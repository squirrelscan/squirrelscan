import { z } from "zod";

import type { Rule, RuleContext, RuleResult } from "../types";

import { MIN_INTERNAL_LINKS } from "@squirrelscan/utils/constants";
import { normalizeUrl, matchesExcludePattern } from "@squirrelscan/utils";

export const deadEndPages: Rule = {
  meta: {
    id: "links/dead-end-pages",
    name: "Dead-End Pages",
    description:
      "Pages with no outgoing internal links, potentially trapping users",
    solution:
      "Add navigation links or related content links to help users continue browsing. Internal links improve user experience and help search engines discover content.",
    category: "links",
    scope: "page",
    severity: "warning",
    weight: 3,
    optionsSchema: z.object({
      excludePatterns: z
        .array(z.string())
        .default([
          "/thank-you",
          "/confirmation",
          "/download",
          "/success",
          "/submitted",
        ]),
      minLinks: z.number().default(MIN_INTERNAL_LINKS),
      countAnchorLinks: z
        .boolean()
        .default(false)
        .describe(
          "Count anchor links (#section) as valid internal links (useful for single-page apps)"
        ),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const { parsed, page, options } = ctx;

    if (!parsed) {
      return {
        checks: [
          {
            name: "dead-end",
            status: "skipped",
            message: "Page could not be parsed",
            skipReason: "Page could not be parsed",
          },
        ],
      };
    }

    // Check against exclusion patterns
    const excludePatterns = options.excludePatterns as string[];
    const isExcluded = matchesExcludePattern(page.url, excludePatterns);

    if (isExcluded) {
      return {
        checks: [
          {
            name: "dead-end",
            status: "skipped",
            message: "Page excluded by pattern",
            skipReason: "Page excluded by pattern",
          },
        ],
      };
    }

    // Count internal links (excluding self-links)
    const pageUrlNormalized = normalizeUrl(page.url);
    const countAnchorLinks = options.countAnchorLinks as boolean;

    const internalLinks = parsed.links.filter((link) => {
      if (!link.isInternal) return false;

      const linkUrlNormalized = normalizeUrl(link.url);

      // Different page - always count
      if (linkUrlNormalized !== pageUrlNormalized) {
        return true;
      }

      // Same page - check if it's an anchor link and if we should count it
      if (countAnchorLinks) {
        // Compare full URLs including hash
        try {
          const pageUrlObj = new URL(page.url);
          const linkUrlObj = new URL(link.url, page.url);

          // Count if link has a hash and it's different from page hash
          return (
            linkUrlObj.hash &&
            linkUrlObj.hash !== pageUrlObj.hash &&
            linkUrlObj.hash !== "#"
          );
        } catch {
          return false;
        }
      }

      // Default: exclude self-links
      return false;
    });

    const count = internalLinks.length;
    const minLinks = options.minLinks as number;

    if (count < minLinks) {
      return {
        checks: [
          {
            name: "dead-end",
            status: "warn",
            message: "Page has no outgoing internal links (dead-end)",
            value: count,
            expected: minLinks,
          },
        ],
      };
    }

    return {
      checks: [
        {
          name: "dead-end",
          status: "pass",
          message: "Page has outgoing internal links",
          value: count,
        },
      ],
    };
  },
};
