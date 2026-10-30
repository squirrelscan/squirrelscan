// core/meta-title - Validates page title presence and length

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { isTrustedPageTypeIn, pageTypeSkip, trustedPageType } from "../shared/page-type";

/** Page types whose short title or description is normal (pub#841). */
const SHORT_OK_PAGE_TYPES = ["contact", "legal"] as const;

export const optionsSchema = z.object({
  min_length: z.number().default(30).describe("Minimum title length"),
  max_length: z.number().default(75).describe("Maximum title length"),
});

/**
 * The title as a browser displays it (`document.title`): runs of ASCII
 * whitespace collapsed to one space, then trimmed (HTML Standard, "strip and
 * collapse ASCII whitespace"). Themes that indent `<title>` across lines
 * (Shopware, Shopify) otherwise measured their indentation (pub#658). Only
 * ASCII whitespace: a no-break space is part of the displayed title.
 */
function displayedTitle(raw: string): string {
  return raw.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
}

export const metaTitleRule: Rule = {
  meta: {
    id: "core/meta-title",
    name: "Meta Title",
    description: "Validates page title presence and length",
    solution:
      "Every page needs a unique, descriptive title tag between 30-75 characters. Titles appear in browser tabs, search results, and social shares. Write titles that accurately describe the page content while including your primary keyword near the beginning. If your title is too short, add more descriptive context. If too long, prioritize the most important information first and trim secondary details. Avoid keyword stuffing or duplicate titles across pages.",
    category: "core",
    scope: "page",
    verdictScope: "page",
    // Search-result presentation only: skipped on noindex pages (pub#457).
    skipOnNoindex: true,
    severity: "error",
    weight: 8,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const rawTitle = ctx.parsed.meta.title;
    const title = rawTitle ? displayedTitle(rawTitle) : null;
    const checks: CheckResult[] = [];

    // A whitespace-only title displays as empty, the same as `<title></title>`.
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

    if (len < opts.min_length && isTrustedPageTypeIn(ctx.parsed, SHORT_OK_PAGE_TYPES)) {
      // A contact or legal page is not a search target worth a long title (pub#841). Too long still applies.
      checks.push(pageTypeSkip("meta-title", trustedPageType(ctx.parsed)!, "The title length floor"));
    } else if (len < opts.min_length) {
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
