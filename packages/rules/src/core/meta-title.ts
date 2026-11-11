// core/meta-title - Validates page title presence and length

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { pageTypeSkip, skippablePageType } from "../shared/page-type";

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

    // Too short and too long are separate checks, and every page reports both
    // (a pass for the side it clears). The resolution signal keys on
    // ruleId|checkName: a fixed title resolves its old finding only when the
    // same check name reports it clean (pub#1765).
    const label = (bound: "under" | "over", limit: number) => [
      { id: ctx.page.url, label: `${title.slice(0, 50)} (${len} chars, ${bound} ${limit})` },
    ];
    const expected = `${opts.min_length}-${opts.max_length} characters`;
    const tooShort = len < opts.min_length;
    const tooLong = len > opts.max_length;
    const skipType = tooShort ? skippablePageType(ctx.parsed, SHORT_OK_PAGE_TYPES) : null;

    if (tooShort && skipType !== null) {
      // A contact or legal page is not a search target worth a long title (pub#841). Too long still applies.
      checks.push(pageTypeSkip("meta-title-too-short", skipType, "The title length floor"));
    } else if (tooShort) {
      checks.push({
        name: "meta-title-too-short",
        status: "warn",
        message: `Title too short (${len} chars, min ${opts.min_length})`,
        value: title,
        expected,
        items: label("under", opts.min_length),
      });
    } else {
      checks.push({ name: "meta-title-too-short", status: "pass", message: "Title is long enough", value: title });
    }
    if (tooLong) {
      checks.push({
        name: "meta-title-too-long",
        status: "warn",
        message: `Title too long (${len} chars, max ${opts.max_length})`,
        value: title,
        expected,
        items: label("over", opts.max_length),
      });
    } else {
      checks.push({ name: "meta-title-too-long", status: "pass", message: "Title is short enough", value: title });
    }

    return { checks };
  },
};
