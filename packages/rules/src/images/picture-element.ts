// images/picture-element - Validates <picture> elements have required <img> fallback

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const pictureElementRule: Rule = {
  meta: {
    id: "images/picture-element",
    name: "Picture Element Validation",
    description: "Validates <picture> elements have required <img> fallback",
    solution: `Every <picture> element MUST contain an <img> child element as fallback.

Correct structure:
<picture>
  <source srcset="image.webp" type="image/webp">
  <source srcset="image.jpg" type="image/jpeg">
  <img src="image.jpg" alt="Description">
</picture>

The <img> provides fallback for:
- Browsers without <picture> support
- Screen readers
- Search engine crawlers
- Failed srcset loading`,
    category: "images",
    scope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const { document } = ctx.parsed;
    const checks: CheckResult[] = [];
    if (!document) return { checks: [] };

    const pictureElements = document.querySelectorAll("picture");

    if (pictureElements.length === 0) {
      checks.push({
        name: "picture-element",
        status: "skipped",
        message: "No <picture> elements found",
        skipReason: "Page has no picture elements",
      });
      return { checks };
    }

    // Check each picture element
    const invalidPictures: string[] = [];

    for (const picture of Array.from(pictureElements)) {
      const imgChild = picture.querySelector("img");

      if (!imgChild) {
        // Try to identify the picture for debugging
        const sources = picture.querySelectorAll("source");
        const firstSrcset =
          sources[0]?.getAttribute("srcset") || "unknown source";
        invalidPictures.push(firstSrcset);
      }
    }

    if (invalidPictures.length === 0) {
      checks.push({
        name: "picture-element",
        status: "pass",
        message: `All ${pictureElements.length} <picture> element(s) have <img> fallback`,
      });
    } else {
      checks.push({
        name: "picture-element",
        status: "fail",
        message: `${invalidPictures.length} of ${pictureElements.length} <picture> element(s) missing <img> fallback`,
        items: invalidPictures.map((src) => ({ id: src })),
      });
    }

    return { checks };
  },
};
