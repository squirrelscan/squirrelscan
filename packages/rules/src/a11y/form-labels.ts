// a11y/form-labels - Form inputs have associated labels

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import { labelsFor } from "../shared/attribute-lookup";

export const formLabelsRule: Rule = {
  meta: {
    id: "a11y/form-labels",
    name: "Form Labels",
    description: "Checks that form inputs have associated labels",
    solution:
      "Every form input needs an accessible label for screen readers. Options: 1) Use <label for='inputId'>Label</label> with matching id. 2) Wrap the input inside <label>Label <input></label>. 3) Use aria-label or aria-labelledby for inputs where visible labels aren't feasible. Placeholders are not sufficient substitutes for labels. Hidden inputs, submit buttons, and image buttons don't need labels. A control hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a label before it is shown. A <style> rule squirrel can decide (a plain selector, no media query) counts too. Vendor-prefixed display values (-webkit-box, -webkit-flex, -ms-flexbox) are read as shown, including the old fallback chain that ends in display: flex. An attribute selector with an operator ([id$=x], [href^=x], [data-a*=x], [class~=x], [lang|=en]) reaches only elements that have the attribute and a value that could satisfy it. A control carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. A control a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so a control hidden only by one is still reported.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const inputs = doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select'
    );

    // pub#671: a field out of the accessibility tree is not reported.
    const unlabeled = sortUnnamedControls<string>();

    for (const input of inputs) {
      const id = input.getAttribute("id");
      const ariaLabel = input.getAttribute("aria-label");
      const ariaLabelledby = input.getAttribute("aria-labelledby");
      const title = input.getAttribute("title");

      // Check if input is inside a label
      const isInsideLabel = input.closest("label") !== null;

      // Check for associated label via for attribute
      let hasAssociatedLabel = false;
      if (id) {
        const label = labelsFor(doc, id)[0] ?? null;
        hasAssociatedLabel = label !== null;
      }

      const hasLabel =
        isInsideLabel ||
        hasAssociatedLabel ||
        ariaLabel ||
        ariaLabelledby ||
        title;

      if (!hasLabel) {
        const type = input.getAttribute("type") || input.tagName.toLowerCase();
        const name = input.getAttribute("name") || id || type;
        unlabeled.add(input, name);
      }
    }

    const unlabeledInputs = unlabeled.failures;
    if (unlabeledInputs.length > 0) {
      checks.push({
        name: "form-labels",
        status: "fail",
        message: `${unlabeledInputs.length} form input(s) without labels`,
        items: unlabeledInputs.map((id) => ({ id })),
      });
    }
    if (unlabeled.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "form-labels",
          "form input(s) without labels",
          unlabeled.unconfirmed
        )
      );
    }
    if (unlabeledInputs.length === 0 && unlabeled.unconfirmed.length === 0) {
      if (inputs.length === 0) {
        checks.push({
          name: "form-labels",
          status: "info",
          message: "No form inputs found",
        });
      } else if (unlabeled.hidden > 0) {
        checks.push({
          name: "form-labels",
          status: "pass",
          message: "All form inputs in the accessibility tree have labels",
          details: {
            inputsChecked: inputs.length,
            hiddenWithoutLabel: unlabeled.hidden,
          },
        });
      } else {
        checks.push({
          name: "form-labels",
          status: "pass",
          message: "All form inputs have labels",
          details: { inputsChecked: inputs.length },
        });
      }
    }

    return { checks };
  },
};
