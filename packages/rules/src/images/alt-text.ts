// images/alt-text - Validates image alt text

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const altTextRule: Rule = {
  meta: {
    id: "images/alt-text",
    name: "Image Alt Text",
    description: "Validates image alt attributes",
    solution:
      'Alt text describes images for screen readers and displays when images fail to load. It\'s essential for accessibility and helps with image search SEO. Add descriptive alt text to all meaningful images. Keep it concise (under 125 characters) but descriptive. For decorative images, use empty alt="" to indicate they should be skipped by screen readers. Avoid keyword stuffing in alt text.',
    category: "images",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const { images } = ctx.parsed;
    const checks: CheckResult[] = [];

    if (images.length === 0) {
      checks.push({
        name: "alt-text",
        status: "pass",
        message: "No images on page",
        value: 0,
      });
      return { checks };
    }

    const missingAlt = images.filter(
      (img) => img.alt === null || img.alt.trim() === ""
    );

    if (missingAlt.length > 0) {
      checks.push({
        name: "alt-text-missing",
        status: "fail",
        message: `${missingAlt.length} image(s) missing alt text`,
        items: missingAlt.map((img) => ({ id: img.src })),
      });
    }

    const withAlt = images.filter((img) => img.alt && img.alt.length > 0);
    if (withAlt.length === images.length) {
      checks.push({
        name: "alt-text",
        status: "pass",
        message: `All ${images.length} image(s) have alt text`,
      });
    } else if (missingAlt.length === 0) {
      checks.push({
        name: "alt-text",
        status: "pass",
        message: `${withAlt.length}/${images.length} images have alt text`,
      });
    }

    return { checks };
  },
};
