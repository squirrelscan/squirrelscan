// a11y/input-image-alt - Input type=image has alt

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const inputImageAltRule: Rule = {
  meta: {
    id: "a11y/input-image-alt",
    name: "Input Image Alt",
    description: "Checks that input type='image' elements have alt text",
    solution:
      "Image inputs (input type='image') are submit buttons that use an image. They must have alt text describing the button's action. Example: <input type='image' src='submit.png' alt='Submit form'> An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. An image input carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const imageInputs = doc.querySelectorAll('input[type="image"]');
    // pub#993: out of the accessibility tree is skipped, a style that may hide
    // it is unconfirmed, like button-name.
    const unnamed = sortUnnamedControls<string>();

    for (const input of imageInputs) {
      const alt = input.getAttribute("alt");
      const ariaLabel = input.getAttribute("aria-label");
      const ariaLabelledby = input.getAttribute("aria-labelledby");

      if (!alt?.trim() && !ariaLabel?.trim() && !ariaLabelledby) {
        const name = input.getAttribute("name") || "";
        const src = input.getAttribute("src") || "";
        const filename = src.split("/").pop()?.split("?")[0] || "";
        unnamed.add(
          input,
          name ? `input[name="${name}"]` : filename || "input[type=image]"
        );
      }
    }

    const missingAlt = unnamed.failures;

    if (missingAlt.length > 0) {
      checks.push({
        name: "input-image-alt",
        status: "fail",
        message: `${missingAlt.length} image input(s) without alt text`,
        items: missingAlt.map((id) => ({ id })),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow("input-image-alt", "image input(s) without alt text", unnamed.unconfirmed),
      );
    }
    if (missingAlt.length === 0 && unnamed.unconfirmed.length === 0) {
      if (imageInputs.length > 0) {
        checks.push({
          name: "input-image-alt",
          status: "pass",
          message:
            unnamed.hidden > 0
              ? "All image inputs in the accessibility tree have alt text"
              : `${imageInputs.length} image input(s) have alt text`,
          ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
        });
      } else {
        checks.push({
          name: "input-image-alt",
          status: "info",
          message: "No image inputs found",
        });
      }
    }

    return { checks };
  },
};
