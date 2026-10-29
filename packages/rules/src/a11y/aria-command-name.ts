// a11y/aria-command-name - Command elements have accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import { commandRoles } from "./aria-data";
import { elementsWithAttribute } from "../shared/attribute-lookup";

function hasAccessibleName(el: Element): boolean {
  // Check aria-label
  if (el.getAttribute("aria-label")?.trim()) return true;

  // Check aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = el.ownerDocument;
    const ids = labelledBy.split(/\s+/);
    for (const id of ids) {
      const labelEl = doc?.getElementById(id);
      if (labelEl?.textContent?.trim()) return true;
    }
  }

  // Check title attribute
  if (el.getAttribute("title")?.trim()) return true;

  // Check text content
  if (el.textContent?.trim()) return true;

  // Check for nested img with alt
  const img = el.querySelector("img[alt]");
  if (img?.getAttribute("alt")?.trim()) return true;

  // Check for nested svg with title
  const svg = el.querySelector("svg title");
  if (svg?.textContent?.trim()) return true;

  return false;
}

export const ariaCommandNameRule: Rule = {
  meta: {
    id: "a11y/aria-command-name",
    name: "ARIA Command Name",
    description: "Checks that command elements have accessible names",
    solution:
      "Command elements (buttons, links, menu items) must have accessible names. Add text content, aria-label, aria-labelledby, or title attribute. For icon-only buttons, use aria-label to describe the action (e.g., aria-label='Close'). An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide (a plain selector, no media query) counts too. Vendor-prefixed display values (-webkit-box, -webkit-flex, -ms-flexbox) are read as shown, including the old fallback chain that ends in display: flex. An attribute selector with an operator ([id$=x], [href^=x], [data-a*=x], [class~=x], [lang|=en]) reaches only elements that have the attribute and a value that could satisfy it. A control carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. An element a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
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

    // pub#671: a control out of the accessibility tree is not reported.
    const unnamed = sortUnnamedControls<string>();

    // Check elements with command roles
    for (const role of commandRoles) {
      const elements = elementsWithAttribute(doc, "role", role);
      for (const el of elements) {
        if (!hasAccessibleName(el)) {
          const tagName = el.tagName.toLowerCase();
          unnamed.add(el, `${tagName}[role="${role}"]`);
        }
      }
    }

    // Check native buttons
    const buttons = doc.querySelectorAll("button");
    for (const btn of buttons) {
      // Skip if it has explicit role
      if (btn.hasAttribute("role")) continue;
      if (!hasAccessibleName(btn)) {
        const type = btn.getAttribute("type") || "submit";
        unnamed.add(btn, `button[type="${type}"]`);
      }
    }

    // Check native links
    const links = doc.querySelectorAll("a[href]");
    for (const link of links) {
      if (link.hasAttribute("role")) continue;
      if (!hasAccessibleName(link)) {
        const href = link.getAttribute("href") || "";
        const shortHref = href.length > 30 ? href.slice(0, 30) + "..." : href;
        unnamed.add(link, `a[href="${shortHref}"]`);
      }
    }

    const missingNames = unnamed.failures;
    if (missingNames.length > 0) {
      checks.push({
        name: "aria-command-name",
        status: "fail",
        message: `${missingNames.length} command element(s) without accessible names`,
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details:
          missingNames.length > 10
            ? { additional: missingNames.length - 10 }
            : undefined,
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "aria-command-name",
          "command element(s) without accessible names",
          unnamed.unconfirmed
        )
      );
    }
    if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      checks.push({
        name: "aria-command-name",
        status: "pass",
        ...(unnamed.hidden > 0
          ? {
              message:
                "All command elements in the accessibility tree have accessible names",
              details: { hiddenWithoutName: unnamed.hidden },
            }
          : { message: "All command elements have accessible names" }),
      });
    }

    return { checks };
  },
};
