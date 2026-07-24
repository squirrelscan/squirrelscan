// a11y/form-labels - Form inputs have associated labels

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const formLabelsRule: Rule = {
  meta: {
    id: "a11y/form-labels",
    name: "Form Labels",
    description: "Checks that form inputs have associated labels",
    solution:
      "Every form input needs an accessible label for screen readers. Options: 1) Use <label for='inputId'>Label</label> with matching id. 2) Wrap the input inside <label>Label <input></label>. 3) Use aria-label or aria-labelledby for inputs where visible labels aren't feasible. Placeholders are not sufficient substitutes for labels. Hidden inputs, submit buttons, and image buttons don't need labels.",
    category: "a11y",
    scope: "page",
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

    const unlabeledInputs: string[] = [];

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
        const label = doc.querySelector(`label[for="${id}"]`);
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
        unlabeledInputs.push(name);
      }
    }

    if (unlabeledInputs.length > 0) {
      checks.push({
        name: "form-labels",
        status: "fail",
        message: `${unlabeledInputs.length} form input(s) without labels`,
        items: unlabeledInputs.map((id) => ({ id })),
      });
    } else if (inputs.length > 0) {
      checks.push({
        name: "form-labels",
        status: "pass",
        message: "All form inputs have labels",
        details: { inputsChecked: inputs.length },
      });
    } else {
      checks.push({
        name: "form-labels",
        status: "info",
        message: "No form inputs found",
      });
    }

    return { checks };
  },
};
