// a11y/aria-command-name - Command elements have accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { commandRoles } from "./aria-data";

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
      "Command elements (buttons, links, menu items) must have accessible names. Add text content, aria-label, aria-labelledby, or title attribute. For icon-only buttons, use aria-label to describe the action (e.g., aria-label='Close').",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const missingNames: string[] = [];

    // Check elements with command roles
    for (const role of commandRoles) {
      const elements = doc.querySelectorAll(`[role="${role}"]`);
      for (const el of elements) {
        if (!hasAccessibleName(el)) {
          const tagName = el.tagName.toLowerCase();
          missingNames.push(`${tagName}[role="${role}"]`);
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
        missingNames.push(`button[type="${type}"]`);
      }
    }

    // Check native links
    const links = doc.querySelectorAll("a[href]");
    for (const link of links) {
      if (link.hasAttribute("role")) continue;
      if (!hasAccessibleName(link)) {
        const href = link.getAttribute("href") || "";
        const shortHref = href.length > 30 ? href.slice(0, 30) + "..." : href;
        missingNames.push(`a[href="${shortHref}"]`);
      }
    }

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
    } else {
      checks.push({
        name: "aria-command-name",
        status: "pass",
        message: "All command elements have accessible names",
      });
    }

    return { checks };
  },
};
