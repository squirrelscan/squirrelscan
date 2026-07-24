// a11y/form-field-multiple-labels - Inputs don't have multiple labels

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const formFieldMultipleLabelsRule: Rule = {
  meta: {
    id: "a11y/form-field-multiple-labels",
    name: "Multiple Labels",
    description: "Checks that form fields don't have multiple labels",
    solution:
      "Form inputs should have only one associated label. Multiple labels can confuse assistive technology. If you need multiple text descriptions, use aria-describedby for supplementary text instead of multiple labels.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const inputs = doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select'
    );

    const multipleLabels: string[] = [];

    for (const input of inputs) {
      const id = input.getAttribute("id");
      let labelCount = 0;

      // Check for label via for attribute
      if (id) {
        const labelsById = doc.querySelectorAll(`label[for="${id}"]`);
        labelCount += labelsById.length;
      }

      // Check for wrapping label
      const parentLabel = input.closest("label");
      if (parentLabel) {
        labelCount++;
      }

      if (labelCount > 1) {
        const name =
          input.getAttribute("name") || id || input.tagName.toLowerCase();
        multipleLabels.push(`${name} (${labelCount} labels)`);
      }
    }

    if (multipleLabels.length > 0) {
      checks.push({
        name: "form-field-multiple-labels",
        status: "warn",
        message: `${multipleLabels.length} input(s) with multiple labels`,
        items: multipleLabels.map((id) => ({ id })),
        details: {
          suggestion: "Use aria-describedby for additional descriptions",
        },
      });
    } else if (inputs.length > 0) {
      checks.push({
        name: "form-field-multiple-labels",
        status: "pass",
        message: "No inputs have multiple labels",
        details: { inputsChecked: inputs.length },
      });
    } else {
      checks.push({
        name: "form-field-multiple-labels",
        status: "info",
        message: "No form inputs found",
      });
    }

    return { checks };
  },
};
