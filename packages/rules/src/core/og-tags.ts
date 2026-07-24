// core/og-tags - Validates Open Graph tags

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const ogTagsRule: Rule = {
  meta: {
    id: "core/og-tags",
    name: "Open Graph Tags",
    description: "Validates Open Graph meta tags for social sharing",
    solution:
      "Open Graph tags control how your content appears when shared on Facebook, LinkedIn, and other platforms. Required tags: og:title, og:description, og:image, og:url, and og:type. Add OG tags in your page head. Use images at least 1200x630 pixels for best display. Keep og:title under 60 characters and og:description under 200. Test shares using Facebook's Sharing Debugger tool.",
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const { og } = ctx.parsed;
    const checks: CheckResult[] = [];
    let hasMissing = false;

    // Check og:title
    if (!og.title) {
      checks.push({
        name: "og-title",
        status: "warn",
        message: "Missing og:title",
        value: null,
      });
      hasMissing = true;
    }

    // Check og:description
    if (!og.description) {
      checks.push({
        name: "og-description",
        status: "warn",
        message: "Missing og:description",
        value: null,
      });
      hasMissing = true;
    }

    // Check og:image (important for social sharing)
    if (!og.image) {
      checks.push({
        name: "og-image",
        status: "warn",
        message: "Missing og:image - social shares will lack imagery",
        value: null,
      });
      hasMissing = true;
    }

    // Check og:type
    if (!og.type) {
      checks.push({
        name: "og-type",
        status: "info",
        message: "Missing og:type (defaults to website)",
        value: null,
      });
    }

    // Summary check
    if (!hasMissing) {
      checks.push({
        name: "og-tags",
        status: "pass",
        message: "Essential Open Graph tags present",
        value: `title: ${og.title?.slice(0, 30)}...`,
      });
    }

    return { checks };
  },
};
