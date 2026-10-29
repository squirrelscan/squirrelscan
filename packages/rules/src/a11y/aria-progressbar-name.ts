// a11y/aria-progressbar-name - Progressbar elements have accessible names

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

  // Check for associated label (for native progress)
  const id = el.getAttribute("id");
  if (id) {
    const label = labelsFor(doc, id)[0] ?? null;
    if (label?.textContent?.trim()) return true;
  }

  return false;
}

export const ariaProgressbarNameRule: Rule = {
  meta: {
    id: "a11y/aria-progressbar-name",
    name: "ARIA Progressbar Name",
    description: "Checks that progressbar elements have accessible names",
    solution:
      "Progressbar elements must have accessible names to describe what process is being tracked. Add aria-label, aria-labelledby, or an associated <label>. Example: <progress aria-label='Upload progress' value='50' max='100'>50%</progress>. An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. A progress carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
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

    // Check elements with progressbar role
    const progressRoles = doc.querySelectorAll('[role="progressbar"]');
    for (const el of progressRoles) {
      if (!hasAccessibleName(el, doc)) {
        const tagName = el.tagName.toLowerCase();
        unnamed.add(el, `${tagName}[role="progressbar"]`);
      }
    }

    // Check native progress elements
    const progressElements = doc.querySelectorAll("progress");
    for (const progress of progressElements) {
      if (progress.hasAttribute("role")) continue; // Covered by role check
      if (!hasAccessibleName(progress, doc)) {
        const id = progress.getAttribute("id") || "";
        unnamed.add(progress, id ? `progress#${id}` : "progress");
      }
    }

    const missingNames = unnamed.failures;

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-progressbar-name",
        status: "fail",
        message: `${missingNames.length} progressbar element(s) without accessible names`,
        items: missingNames.map((id) => ({ id })),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(unconfirmedRow("aria-progressbar-name", "progressbar element(s) without accessible names", unnamed.unconfirmed));
    }
    if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      if (progressRoles.length > 0 || progressElements.length > 0) {
        checks.push({
          name: "aria-progressbar-name",
          status: "pass",
          message:
            unnamed.hidden > 0
              ? "All progressbar elements in the accessibility tree have accessible names"
              : "All progressbar elements have accessible names",
          ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
        });
      } else {
        checks.push({
          name: "aria-progressbar-name",
          status: "info",
          message: "No progressbar elements found",
        });
      }
    }

    return { checks };
  },
};
