// a11y/label-content-name-mismatch - Label text matches accessible name

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function getVisibleText(el: Element): string {
  // Get only visible text content (excluding aria-hidden)
  let text = "";

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      // Text node
      text += node.textContent || "";
    } else if (node.nodeType === 1) {
      // Element node
      const element = node as Element;
      const ariaHidden = element.getAttribute("aria-hidden");
      const hidden = element.getAttribute("hidden");

      if (ariaHidden === "true" || hidden !== null) return;

      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }
  };

  walk(el);
  return text.trim().toLowerCase();
}

export const labelContentNameMismatchRule: Rule = {
  meta: {
    id: "a11y/label-content-name-mismatch",
    name: "Label Content Name Mismatch",
    description: "Checks that visible label text is part of accessible name",
    solution:
      "For controls with visible labels, the accessible name should contain the visible text. Voice control users say what they see - if the accessible name doesn't include the visible label, voice commands won't work. Example: A button showing 'Search' should not have aria-label='Find products'.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check elements with visible text and aria-label
    const elementsWithAriaLabel = doc.querySelectorAll(
      "button[aria-label], a[aria-label], [role='button'][aria-label], [role='link'][aria-label], input[aria-label], select[aria-label]"
    );

    const mismatches: string[] = [];

    for (const el of elementsWithAriaLabel) {
      const ariaLabel =
        el.getAttribute("aria-label")?.toLowerCase().trim() || "";
      if (!ariaLabel) continue;

      const visibleText = getVisibleText(el);
      if (!visibleText) continue; // No visible text to compare

      // Check if visible text is contained in aria-label
      // Normalize for comparison
      const normalizedVisible = visibleText.replace(/\s+/g, " ");
      const normalizedAriaLabel = ariaLabel.replace(/\s+/g, " ");

      if (!normalizedAriaLabel.includes(normalizedVisible)) {
        const tagName = el.tagName.toLowerCase();
        mismatches.push(
          `${tagName}: visible="${normalizedVisible.slice(0, 20)}" vs aria-label="${normalizedAriaLabel.slice(0, 20)}"`
        );
      }
    }

    if (mismatches.length > 0) {
      checks.push({
        name: "label-content-name-mismatch",
        status: "fail",
        message: `${mismatches.length} element(s) where visible text doesn't match accessible name`,
        items: mismatches.slice(0, 10).map((id) => ({ id })),
        details: {
          issue:
            "Voice control users may not be able to activate these controls",
        },
      });
    } else if (elementsWithAriaLabel.length > 0) {
      checks.push({
        name: "label-content-name-mismatch",
        status: "pass",
        message: "Visible labels match accessible names",
      });
    } else {
      checks.push({
        name: "label-content-name-mismatch",
        status: "info",
        message: "No elements with aria-label and visible text found",
      });
    }

    return { checks };
  },
};
