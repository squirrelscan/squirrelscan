// a11y/select-name - Select elements have accessible names

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

  // Check for associated label
  const id = el.getAttribute("id");
  if (id) {
    const label = labelsFor(doc, id)[0] ?? null;
    if (label?.textContent?.trim()) return true;
  }

  // Check for wrapping label
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent?.trim()) return true;

  // Check title attribute
  if (el.getAttribute("title")?.trim()) return true;

  return false;
}

export const selectNameRule: Rule = {
  meta: {
    id: "a11y/select-name",
    name: "Select Name",
    description: "Checks that select elements have accessible names",
    solution:
      "Select elements need accessible labels. Use <label for='selectId'>Label</label>, wrap in <label>, or use aria-label/aria-labelledby. A select hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. A select carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. A select a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so a select hidden only by one is still reported.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const selects = doc.querySelectorAll("select");
    // pub#991: a select out of the accessibility tree is not reported, and
    // one a style may hide is unconfirmed, like the other naming checks.
    const unnamed = sortUnnamedControls<string>();

    for (const select of selects) {
      if (!hasAccessibleName(select, doc)) {
        const name = select.getAttribute("name") || "";
        const id = select.getAttribute("id") || "";
        unnamed.add(select, name ? `select[name="${name}"]` : id ? `select#${id}` : "select");
      }
    }
    const missingNames = unnamed.failures;

    if (missingNames.length > 0) {
      checks.push({
        name: "select-name",
        status: "fail",
        message: `${missingNames.length} select element(s) without accessible names`,
        items: missingNames.map((id) => ({ id })),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "select-name",
          "select element(s) without accessible names",
          unnamed.unconfirmed,
        ),
      );
    }
    if (selects.length === 0) {
      checks.push({
        name: "select-name",
        status: "info",
        message: "No select elements found",
      });
    } else if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      checks.push({
        name: "select-name",
        status: "pass",
        message:
          unnamed.hidden > 0
            ? "All select elements in the accessibility tree have accessible names"
            : `${selects.length} select element(s) have accessible names`,
        ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
      });
    }

    return { checks };
  },
};
