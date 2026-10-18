// a11y/aria-labels - Interactive elements need accessible names

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { hasAttrCI } from "@squirrelscan/utils";

import {
  createStaticVisibility,
  sortUnnamedControls,
  unconfirmedRow,
} from "../shared/static-hidden";

export const ariaLabelsRule: Rule = {
  meta: {
    id: "a11y/aria-labels",
    name: "ARIA Labels",
    description: "Checks that interactive elements have accessible names",
    solution:
      "All interactive elements (buttons, links, inputs) need accessible names for screen readers. Use: visible text content, aria-label for icon-only buttons, aria-labelledby to reference existing text, or the title attribute as a fallback. Icon buttons especially need aria-label: <button aria-label='Close'>×</button>. Test with a screen reader or browser accessibility inspector. A button hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide (a plain selector, no media query) counts too. A button a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so a button hidden only by one is still reported.",
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

    // Check buttons without accessible names
    const buttons = doc.querySelectorAll("button, [role='button']");
    // pub#671: a control out of the accessibility tree is not reported.
    const visibility = createStaticVisibility({ ariaHidden: true });
    const unlabeled = sortUnnamedControls<string>(visibility);

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
          unlabeled.add(button, id.substring(0, 30));
        }
      }
    }

    const unlabeledButtons = unlabeled.failures;
    if (unlabeledButtons.length > 0) {
      checks.push({
        name: "aria-buttons",
        status: "fail",
        message: `${unlabeledButtons.length} button(s) without accessible names`,
        items: unlabeledButtons.map((id) => ({ id })),
      });
    }
    if (unlabeled.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "aria-buttons",
          "button(s) without accessible names",
          unlabeled.unconfirmed
        )
      );
    }
    if (
      unlabeledButtons.length === 0 &&
      unlabeled.unconfirmed.length === 0 &&
      buttons.length > 0
    ) {
      checks.push({
        name: "aria-buttons",
        status: "pass",
        ...(unlabeled.hidden > 0
          ? {
              message:
                "All buttons in the accessibility tree have accessible names",
              details: {
                buttonsChecked: buttons.length,
                hiddenWithoutName: unlabeled.hidden,
              },
            }
          : {
              message: "All buttons have accessible names",
              details: { buttonsChecked: buttons.length },
            }),
      });
    }

    // Check for interactive SVGs without accessible names (case-insensitive for React SSR)
    const allSvgs = doc.querySelectorAll("svg");
    // Not one out of the accessibility tree (pub#671).
    const interactiveSvgs = Array.from(allSvgs).filter(
      (svg) =>
        (hasAttrCI(svg, "onclick") || hasAttrCI(svg, "tabindex")) &&
        visibility.visibility(svg).state !== "hidden"
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
