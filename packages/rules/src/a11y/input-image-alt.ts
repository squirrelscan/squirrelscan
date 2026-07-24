// a11y/input-image-alt - Input type=image has alt

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const inputImageAltRule: Rule = {
  meta: {
    id: "a11y/input-image-alt",
    name: "Input Image Alt",
    description: "Checks that input type='image' elements have alt text",
    solution:
      "Image inputs (input type='image') are submit buttons that use an image. They must have alt text describing the button's action. Example: <input type='image' src='submit.png' alt='Submit form'>",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const imageInputs = doc.querySelectorAll('input[type="image"]');
    const missingAlt: string[] = [];

    for (const input of imageInputs) {
      const alt = input.getAttribute("alt");
      const ariaLabel = input.getAttribute("aria-label");
      const ariaLabelledby = input.getAttribute("aria-labelledby");

      if (!alt?.trim() && !ariaLabel?.trim() && !ariaLabelledby) {
        const name = input.getAttribute("name") || "";
        const src = input.getAttribute("src") || "";
        const filename = src.split("/").pop()?.split("?")[0] || "";
        missingAlt.push(
          name ? `input[name="${name}"]` : filename || "input[type=image]"
        );
      }
    }

    if (missingAlt.length > 0) {
      checks.push({
        name: "input-image-alt",
        status: "fail",
        message: `${missingAlt.length} image input(s) without alt text`,
        items: missingAlt.map((id) => ({ id })),
      });
    } else if (imageInputs.length > 0) {
      checks.push({
        name: "input-image-alt",
        status: "pass",
        message: `${imageInputs.length} image input(s) have alt text`,
      });
    } else {
      checks.push({
        name: "input-image-alt",
        status: "info",
        message: "No image inputs found",
      });
    }

    return { checks };
  },
};
