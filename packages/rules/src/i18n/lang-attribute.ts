// i18n/lang-attribute - Checks for lang attribute on html element

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const langAttributeRule: Rule = {
  meta: {
    id: "i18n/lang-attribute",
    name: "Lang Attribute",
    description: "Checks for lang attribute on html element",
    solution:
      'The lang attribute on the html element declares the page\'s language, helping browsers, screen readers, and search engines process content correctly. Add lang="xx" to your html tag using a valid ISO 639-1 code (e.g., "en", "es", "fr"). For regional variants, use lang="en-US" or "en-GB". This improves accessibility and helps search engines serve your content to the right audience.',
    category: "i18n",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const html = doc.querySelector("html");
    const lang = html?.getAttribute("lang");

    if (!lang) {
      checks.push({
        name: "lang-attribute",
        status: "warn",
        message: "Missing lang attribute on <html> element",
        value: null,
      });
      return { checks };
    }

    // Validate lang format (basic check)
    const validLangPattern = /^[a-z]{2}(-[A-Z]{2})?$/;
    if (!validLangPattern.test(lang)) {
      checks.push({
        name: "lang-attribute",
        status: "info",
        message: `Lang attribute format: ${lang}`,
        value: lang,
      });
    } else {
      checks.push({
        name: "lang-attribute",
        status: "pass",
        message: `Lang attribute present: ${lang}`,
        value: lang,
      });
    }

    return { checks };
  },
};
