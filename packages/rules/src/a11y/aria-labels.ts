// a11y/aria-labels - Interactive elements need accessible names

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { hasAttrCI } from "@squirrelscan/utils";

export const ariaLabelsRule: Rule = {
  meta: {
    id: "a11y/aria-labels",
    name: "ARIA Labels",
    description: "Checks that interactive elements have accessible names",
    solution:
      "All interactive elements (buttons, links, inputs) need accessible names for screen readers. Use: visible text content, aria-label for icon-only buttons, aria-labelledby to reference existing text, or the title attribute as a fallback. Icon buttons especially need aria-label: <button aria-label='Close'>×</button>. Test with a screen reader or browser accessibility inspector.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check buttons without accessible names
    const buttons = doc.querySelectorAll("button, [role='button']");
    const unlabeledButtons: string[] = [];

    for (const button of buttons) {
      const text = (button.textContent || "").trim();
      const ariaLabel = button.getAttribute("aria-label");
      const ariaLabelledby = button.getAttribute("aria-labelledby");
      const title = button.getAttribute("title");

      // Check if button has an accessible name
      if (!text && !ariaLabel && !ariaLabelledby && !title) {
        // Check for image with alt inside
        const imgWithAlt = button.querySelector("img[alt]");
        const svgWithTitle = button.querySelector("svg title");
        if (!imgWithAlt && !svgWithTitle) {
          const id =
            button.getAttribute("id") ||
            button.getAttribute("class") ||
            "button";
          unlabeledButtons.push(id.substring(0, 30));
        }
      }
    }

    if (unlabeledButtons.length > 0) {
      checks.push({
        name: "aria-buttons",
        status: "fail",
        message: `${unlabeledButtons.length} button(s) without accessible names`,
        items: unlabeledButtons.map((id) => ({ id })),
      });
    } else if (buttons.length > 0) {
      checks.push({
        name: "aria-buttons",
        status: "pass",
        message: "All buttons have accessible names",
        details: { buttonsChecked: buttons.length },
      });
    }

    // Check for interactive SVGs without accessible names (case-insensitive for React SSR)
    const allSvgs = doc.querySelectorAll("svg");
    const interactiveSvgs = Array.from(allSvgs).filter(
      (svg) => hasAttrCI(svg, "onclick") || hasAttrCI(svg, "tabindex")
    );
    const unlabeledSvgs: number = Array.from(interactiveSvgs).filter((svg) => {
      const ariaLabel = svg.getAttribute("aria-label");
      const ariaLabelledby = svg.getAttribute("aria-labelledby");
      const title = svg.querySelector("title");
      return !ariaLabel && !ariaLabelledby && !title;
    }).length;

    if (unlabeledSvgs > 0) {
      checks.push({
        name: "aria-svg",
        status: "warn",
        message: `${unlabeledSvgs} interactive SVG(s) without accessible names`,
      });
    }

    return { checks };
  },
};
