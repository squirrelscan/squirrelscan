// images/figure-figcaption - Figure and figcaption check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const figureFigcaptionRule: Rule = {
  meta: {
    id: "images/figure-figcaption",
    name: "Figure Captions",
    description: "Checks for proper use of figure and figcaption elements",
    solution:
      "Use <figure> and <figcaption> for images with captions. This provides semantic meaning and accessibility benefits. Screen readers announce figcaption as the image caption. Good for SEO as captions often contain keywords. Example: <figure><img src='...' alt='...'><figcaption>Description</figcaption></figure>.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const figures = doc.querySelectorAll("figure");
    const standaloneImages = doc.querySelectorAll("img:not(figure img)");

    if (figures.length === 0 && standaloneImages.length === 0) {
      checks.push({
        name: "figure-figcaption",
        status: "skipped",
        message: "No images or figures found",
      });
      return { checks };
    }

    let figuresWithoutCaption = 0;

    for (const figure of figures) {
      const caption = figure.querySelector("figcaption");
      if (!caption || !caption.textContent?.trim()) {
        figuresWithoutCaption++;
      }
    }

    if (figures.length > 0) {
      if (figuresWithoutCaption > 0) {
        checks.push({
          name: "figure-figcaption",
          status: "info",
          message: `${figuresWithoutCaption}/${figures.length} figure(s) missing figcaption`,
          value: "Add descriptive captions to figures",
        });
      } else {
        checks.push({
          name: "figure-figcaption",
          status: "pass",
          message: `All ${figures.length} figure(s) have captions`,
        });
      }
    }

    // Note about standalone images (not a warning, just info)
    if (standaloneImages.length > 0 && figures.length === 0) {
      checks.push({
        name: "figure-usage",
        status: "info",
        message: `${standaloneImages.length} image(s) not using figure/figcaption`,
        value: "Consider using <figure> for images that need captions",
      });
    }

    return { checks };
  },
};
