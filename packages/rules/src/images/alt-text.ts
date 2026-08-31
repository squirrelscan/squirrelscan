// images/alt-text - Reports images with no alt attribute. alt="" is decorative
// markup (HTML spec, WCAG H67), not a missing attribute (#143).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const altTextRule: Rule = {
  meta: {
    id: "images/alt-text",
    name: "Image Alt Text",
    description:
      "Checks that every image carries an alt attribute, counting an empty alt as a decorative marker",
    solution:
      'Alt text describes images for screen readers and displays when images fail to load. It is essential for accessibility and helps with image search SEO. Add descriptive alt text to every image that carries information, keeping it concise (under 125 characters) and free of keyword stuffing. An image that is purely decorative should carry an empty alt attribute (alt="") instead: that is the correct markup for "skip me" and this rule accepts it. Only an image with no alt attribute at all is reported here.',
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

    // An absent alt attribute is the defect. alt="" is the spec-endorsed way to
    // mark a decorative image (HTML spec, WCAG H67) — a positive "skip me", not
    // a missing attribute — so it passes, or the rule would fail pages for doing
    // exactly what its own solution text asks for (#143).
    const missingAlt = images.filter((img) => img.alt === null);

    if (missingAlt.length > 0) {
      checks.push({
        name: "alt-text-missing",
        status: "fail",
        message: `${missingAlt.length} image(s) missing alt text`,
        items: missingAlt.map((img) => ({ id: img.src })),
      });
      return { checks };
    }

    // Whitespace-only alt is a sloppy spelling of alt="", not a description.
    const decorative = images.filter((img) => img.alt !== null && img.alt.trim() === "");
    const describedCount = images.length - decorative.length;

    if (decorative.length === 0) {
      checks.push({
        name: "alt-text",
        status: "pass",
        message: `All ${images.length} image(s) have alt text`,
      });
    } else if (describedCount === 0) {
      checks.push({
        name: "alt-text",
        status: "pass",
        message: `All ${images.length} image(s) marked decorative (alt="")`,
      });
    } else {
      checks.push({
        name: "alt-text",
        status: "pass",
        message: `${describedCount}/${images.length} image(s) have alt text, ${decorative.length} marked decorative (alt="")`,
      });
    }

    return { checks };
  },
};
