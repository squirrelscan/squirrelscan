// a11y/aria-meter-name - Meter elements have accessible names

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { labelsFor } from "../shared/attribute-lookup";

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

  // Check title
  if (el.getAttribute("title")?.trim()) return true;

  // Check for associated label (for native meter)
  const id = el.getAttribute("id");
  if (id) {
    const label = labelsFor(doc, id)[0] ?? null;
    if (label?.textContent?.trim()) return true;
  }

  return false;
}

export const ariaMeterNameRule: Rule = {
  meta: {
    id: "a11y/aria-meter-name",
    name: "ARIA Meter Name",
    description: "Checks that meter elements have accessible names",
    solution:
      "Meter elements must have accessible names to describe what they're measuring. Add aria-label, aria-labelledby, or an associated <label>. Example: <meter aria-label='Battery level' value='0.8'>80%</meter>. An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. A meter carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
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

    // pub#993: out of the accessibility tree is skipped, a style that may hide
    // it is unconfirmed, like button-name.
    const unnamed = sortUnnamedControls<string>();

    // Check elements with meter role
    const meterRoles = doc.querySelectorAll('[role="meter"]');
    for (const el of meterRoles) {
      if (!hasAccessibleName(el, doc)) {
        const tagName = el.tagName.toLowerCase();
        unnamed.add(el, `${tagName}[role="meter"]`);
      }
    }

    // Check native meter elements
    const meters = doc.querySelectorAll("meter");
    for (const meter of meters) {
      if (meter.hasAttribute("role")) continue; // Covered by role check
      if (!hasAccessibleName(meter, doc)) {
        const id = meter.getAttribute("id") || "";
        unnamed.add(meter, id ? `meter#${id}` : "meter");
      }
    }

    const missingNames = unnamed.failures;

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-meter-name",
        status: "fail",
        message: `${missingNames.length} meter element(s) without accessible names`,
        items: missingNames.map((id) => ({ id })),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(unconfirmedRow("aria-meter-name", "meter element(s) without accessible names", unnamed.unconfirmed));
    }
    if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      if (meterRoles.length > 0 || meters.length > 0) {
        checks.push({
          name: "aria-meter-name",
          status: "pass",
          message:
            unnamed.hidden > 0
              ? "All meter elements in the accessibility tree have accessible names"
              : "All meter elements have accessible names",
          ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
        });
      } else {
        checks.push({
          name: "aria-meter-name",
          status: "info",
          message: "No meter elements found",
        });
      }
    }

    return { checks };
  },
};
