// images/srcset - Responsive images check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const srcsetRule: Rule = {
  meta: {
    id: "images/srcset",
    name: "Responsive Images",
    description: "Checks for responsive images with srcset attribute",
    solution:
      "Use srcset and sizes attributes to serve appropriately sized images for each viewport. This reduces bandwidth on mobile and improves LCP. Example: srcset='img-320.jpg 320w, img-640.jpg 640w, img-1280.jpg 1280w' sizes='(max-width: 640px) 100vw, 50vw'. Use <picture> element for art direction.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const images = doc.querySelectorAll("img[src]");

    if (images.length === 0) {
      checks.push({
        name: "srcset",
        status: "skipped",
        message: "No images found",
      });
      return { checks };
    }

    let withSrcset = 0;
    let withoutSrcset = 0;

    for (const img of images) {
      if (img.hasAttribute("srcset")) {
        withSrcset++;
      } else {
        withoutSrcset++;
      }
    }

    // Also check for picture elements
    const pictureElements = doc.querySelectorAll("picture");
    const pictureCount = pictureElements.length;

    if (withSrcset > 0 || pictureCount > 0) {
      const responsiveCount = withSrcset + pictureCount;
      if (withoutSrcset === 0) {
        checks.push({
          name: "srcset",
          status: "pass",
          message: `All ${responsiveCount} image(s) are responsive`,
        });
      } else {
        checks.push({
          name: "srcset",
          status: "info",
          message: `${responsiveCount} responsive, ${withoutSrcset} fixed-size image(s)`,
          value: "Consider adding srcset for remaining images",
        });
      }
    } else {
      checks.push({
        name: "srcset",
        status: "info",
        message: `${withoutSrcset} image(s) without responsive srcset`,
        value: "Add srcset for multiple image sizes",
      });
    }

    return { checks };
  },
};
