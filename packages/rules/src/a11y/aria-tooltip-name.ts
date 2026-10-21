// a11y/aria-tooltip-name - Tooltips have accessible names

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function hasAccessibleName(el: Element, doc: Document): boolean {
  // Check aria-label
  if (el.getAttribute("aria-label")?.trim()) return true;

  // Check aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    for (const id of ids) {
      if (doc.getElementById(id)?.textContent?.trim()) return true;
    }
  }

  // Check text content (tooltips typically have text content as their name)
  if (el.textContent?.trim()) return true;

  return false;
}

export const ariaTooltipNameRule: Rule = {
  meta: {
    id: "a11y/aria-tooltip-name",
    name: "ARIA Tooltip Name",
    description: "Checks that tooltip elements have accessible names",
    solution:
      "Tooltip elements with role='tooltip' must have accessible content. The tooltip content serves as its accessible name. Ensure tooltips have text content or use aria-label for icon-based tooltips. An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. A tooltip carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const tooltips = doc.querySelectorAll('[role="tooltip"]');
    // pub#993: out of the accessibility tree is skipped, a style that may hide
    // it is unconfirmed, like button-name.
    const unnamed = sortUnnamedControls<string>();

    for (const tooltip of tooltips) {
      if (!hasAccessibleName(tooltip, doc)) {
        const tagName = tooltip.tagName.toLowerCase();
        const id = tooltip.getAttribute("id") || "";
        unnamed.add(tooltip, id ? `${tagName}#${id}` : tagName);
      }
    }

    const missingNames = unnamed.failures;

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-tooltip-name",
        status: "fail",
        message: `${missingNames.length} tooltip(s) without accessible content`,
        items: missingNames.map((id) => ({ id })),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow("aria-tooltip-name", "tooltip(s) without accessible content", unnamed.unconfirmed),
      );
    }
    if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      if (tooltips.length > 0) {
        checks.push({
          name: "aria-tooltip-name",
          status: "pass",
          message:
            unnamed.hidden > 0
              ? "All tooltips in the accessibility tree have accessible names"
              : `${tooltips.length} tooltip(s) have accessible names`,
          ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
        });
      } else {
        checks.push({
          name: "aria-tooltip-name",
          status: "info",
          message: "No tooltip elements found",
        });
      }
    }

    return { checks };
  },
};
