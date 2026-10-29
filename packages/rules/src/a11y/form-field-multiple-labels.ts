// a11y/form-field-multiple-labels - Inputs don't have multiple labels

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Labelable elements, as HTML defines them (a label's first one is its control). */
const LABELABLE =
  'input:not([type="hidden"]), button, meter, output, progress, select, textarea';

export const formFieldMultipleLabelsRule: Rule = {
  meta: {
    id: "a11y/form-field-multiple-labels",
    name: "Multiple Labels",
    description: "Checks that form fields don't have multiple labels",
    solution:
      "Form inputs should have only one associated label. Multiple labels can confuse assistive technology. If you need multiple text descriptions, use aria-describedby for supplementary text instead of multiple labels.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
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

    // `label[for]` elements by the id they point at, built once. Compared as
    // strings, never spliced into a selector: an id can hold any character.
    const labelsByFor = new Map<string, Element[]>();
    for (const label of doc.querySelectorAll("label[for]")) {
      const target = label.getAttribute("for");
      if (!target) continue;
      const list = labelsByFor.get(target);
      if (list) list.push(label);
      else labelsByFor.set(target, [label]);
    }

    for (const input of inputs) {
      const id = input.getAttribute("id");

      // The label ELEMENTS this control has, as `HTMLInputElement.labels` gives
      // them (#1249): a label that wraps the control and also points at it with
      // `for=` is one element, so it goes in a set once.
      const labels = new Set<Element>(id ? (labelsByFor.get(id) ?? []) : []);

      // A wrapping label labels the control only when it has no `for` of its own
      // (a `for` naming another id sends the label there) and the control is its
      // first labelable descendant (HTML's labeled control rule).
      const wrapper = input.closest("label");
      if (wrapper && !wrapper.hasAttribute("for") && wrapper.querySelector(LABELABLE) === input) {
        labels.add(wrapper);
      }

      const labelCount = labels.size;
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
