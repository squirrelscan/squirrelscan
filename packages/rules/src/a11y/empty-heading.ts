// a11y/empty-heading - Headings have content

import type { CheckItem } from "@squirrelscan/core-contracts";

import { fieldSnippet } from "../shared/form-fields";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Last-wins inline declaration for one property, ignoring comments and `!important`. */
function inlineStyle(el: Element, property: string): string | null {
  const style = el.getAttribute("style");
  if (!style) return null;
  let value: string | null = null;
  for (const decl of style.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1 || decl.slice(0, colon).trim().toLowerCase() !== property) continue;
    value = decl
      .slice(colon + 1)
      .replace(/!\s*important/i, "")
      .trim()
      .toLowerCase();
  }
  return value;
}

/** `display` values that are `none` or defer to the cascade, so `hidden` still applies. */
const NO_OVERRIDE_DISPLAY = new Set(["none", "inherit", "initial", "unset", "revert", "revert-layer"]);

/** `hidden` removes the element from rendering, except `hidden="until-found"`. */
function hasHiddenAttribute(el: Element): boolean {
  const value = el.getAttribute("hidden");
  if (value === null || value.trim().toLowerCase() === "until-found") return false;
  // An author `display` other than none beats the user-agent `[hidden]` rule.
  const display = inlineStyle(el, "display");
  return !display || !/^[a-z-]+$/.test(display) || NO_OVERRIDE_DISPLAY.has(display);
}

/**
 * True when the markup alone proves the heading is not in the accessibility
 * tree: `hidden`, inline `display:none` or `visibility:hidden` on the heading,
 * or on an ancestor `hidden`, `aria-hidden="true"`, inline `display:none`, or
 * an inherited inline `visibility:hidden` the heading does not override.
 * Hiding through CSS classes or stylesheets cannot be seen from the markup.
 */
function isHiddenFromMarkup(heading: Element): boolean {
  let visibility: string | null = null;
  for (let el: Element | null = heading; el; el = el.parentElement) {
    if (hasHiddenAttribute(el)) return true;
    if (el.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") return true;
    if (inlineStyle(el, "display") === "none") return true;
    // visibility inherits: the nearest declaration decides.
    const own = inlineStyle(el, "visibility");
    if (visibility === null && own !== null && own !== "inherit") visibility = own;
  }
  return visibility === "hidden" || visibility === "collapse";
}

export const emptyHeadingRule: Rule = {
  meta: {
    id: "a11y/empty-heading",
    name: "Empty Headings",
    description: "Checks that heading elements have visible content",
    solution:
      "Headings (h1-h6) must have text content for screen readers to announce. Empty headings create confusing navigation. Either add text content, use aria-label, or remove the empty heading element.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const emptyHeadings: CheckItem[] = [];

    let position = 0;
    for (const heading of headings) {
      position++;
      const text = heading.textContent?.trim();
      const ariaLabel = heading.getAttribute("aria-label")?.trim();
      const ariaLabelledby = heading.getAttribute("aria-labelledby");

      // Check if heading has any accessible content
      let hasContent = !!text || !!ariaLabel;

      // Check aria-labelledby
      if (!hasContent && ariaLabelledby) {
        const ids = ariaLabelledby.split(/\s+/);
        for (const id of ids) {
          if (doc.getElementById(id)?.textContent?.trim()) {
            hasContent = true;
            break;
          }
        }
      }

      // Check for images with alt
      if (!hasContent) {
        const img = heading.querySelector("img[alt]");
        if (img?.getAttribute("alt")?.trim()) {
          hasContent = true;
        }
      }

      // Only an empty heading needs the (costlier) hidden check.
      if (!hasContent && !isHiddenFromMarkup(heading)) {
        const level = heading.tagName.toLowerCase();
        const id = heading.getAttribute("id");
        const cls = heading.getAttribute("class")?.split(" ")[0];
        emptyHeadings.push({
          id: id ? `${level}#${id}` : cls ? `${level}.${cls}` : level,
          label: `${level}, heading ${position} of ${headings.length} on the page`,
          snippet: fieldSnippet(heading),
        });
      }
    }

    if (emptyHeadings.length > 0) {
      checks.push({
        name: "empty-heading",
        status: "warn",
        message: `${emptyHeadings.length} empty heading(s) found`,
        items: emptyHeadings.slice(0, 10),
        details:
          emptyHeadings.length > 10
            ? { additional: emptyHeadings.length - 10 }
            : undefined,
      });
    } else if (headings.length > 0) {
      checks.push({
        name: "empty-heading",
        status: "pass",
        message: "All headings have content",
        details: { headingsChecked: headings.length },
      });
    } else {
      checks.push({
        name: "empty-heading",
        status: "info",
        message: "No headings found",
      });
    }

    return { checks };
  },
};
