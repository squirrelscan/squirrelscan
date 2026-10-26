// a11y/aria-treeitem-name - Treeitems have accessible names

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

  // Check text content (treeitems typically get name from content)
  if (el.textContent?.trim()) return true;

  // Check for nested img with alt
  const img = el.querySelector("img[alt]");
  if (img?.getAttribute("alt")?.trim()) return true;

  return false;
}

export const ariaTreeitemNameRule: Rule = {
  meta: {
    id: "a11y/aria-treeitem-name",
    name: "ARIA Treeitem Name",
    description: "Checks that treeitem elements have accessible names",
    solution:
      "Treeitem elements must have accessible names. Add text content, aria-label, or aria-labelledby. The text content within the treeitem typically serves as its name. An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. A treeitem carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
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

    const treeitems = doc.querySelectorAll('[role="treeitem"]');
    // pub#993: out of the accessibility tree is skipped, a style that may hide
    // it is unconfirmed, like button-name.
    const unnamed = sortUnnamedControls<string>();

    for (const item of treeitems) {
      if (!hasAccessibleName(item, doc)) {
        const tagName = item.tagName.toLowerCase();
        const id = item.getAttribute("id") || "";
        unnamed.add(item, id ? `${tagName}#${id}` : tagName);
      }
    }

    const missingNames = unnamed.failures;

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-treeitem-name",
        status: "fail",
        message: `${missingNames.length} treeitem(s) without accessible names`,
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details: missingNames.length > 10 ? { additional: missingNames.length - 10 } : undefined,
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow("aria-treeitem-name", "treeitem(s) without accessible names", unnamed.unconfirmed),
      );
    }
    if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      if (treeitems.length > 0) {
        checks.push({
          name: "aria-treeitem-name",
          status: "pass",
          message:
            unnamed.hidden > 0
              ? "All treeitems in the accessibility tree have accessible names"
              : `${treeitems.length} treeitem(s) have accessible names`,
          ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
        });
      } else {
        checks.push({
          name: "aria-treeitem-name",
          status: "info",
          message: "No treeitem elements found",
        });
      }
    }

    return { checks };
  },
};
