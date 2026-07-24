// images/dimensions - Checks for image dimension attributes

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const dimensionsRule: Rule = {
  meta: {
    id: "images/dimensions",
    name: "Image Dimensions",
    description: "Checks for width/height attributes (prevents CLS)",
    solution:
      "Specifying width and height attributes prevents Cumulative Layout Shift (CLS) by reserving space before images load. Add width and height attributes to img tags matching the image's intrinsic dimensions. Use CSS for responsive sizing if needed. For responsive images, the aspect ratio from width/height prevents layout shifts even when CSS overrides the actual size.",
    category: "images",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const { images } = ctx.parsed;
    const checks: CheckResult[] = [];

    if (images.length === 0) {
      checks.push({
        name: "image-dimensions",
        status: "pass",
        message: "No images on page",
        value: 0,
      });
      return { checks };
    }

    const missingDimensions = images.filter((img) => !img.width || !img.height);

    if (missingDimensions.length > 0) {
      checks.push({
        name: "image-dimensions",
        status: "warn",
        message: `${missingDimensions.length} image(s) missing width/height (causes CLS)`,
        value: missingDimensions.length,
        items: missingDimensions.map((img) => ({
          id: img.src,
          label: img.src,
          snippet: `<img src="${img.src}"${img.alt !== null ? ` alt="${img.alt}"` : ""}>`,
        })),
      });
    } else {
      checks.push({
        name: "image-dimensions",
        status: "pass",
        message: `All ${images.length} image(s) have dimensions`,
        value: images.length,
      });
    }

    return { checks };
  },
};
