// a11y/aria-hidden-focus - Aria-hidden not on focusable elements

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

// Selectors for natively focusable elements (no tabindex — handled separately via CI helper)
const nativeFocusableSelectors = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  "audio[controls]",
  "video[controls]",
  "details > summary",
].join(", ");

/** Check if element is focusable (handles camelCase tabIndex from React SSR) */
function isFocusable(el: Element): boolean {
  if (el.matches(nativeFocusableSelectors)) return true;
  const tabindex = getAttrCI(el, "tabindex");
  return tabindex !== null && tabindex !== "-1";
}

// Anti-spam honeypot inputs (formshield-style decoy fields bots fill in) are
// intentionally focusable-and-hidden — the WCAG finding is still technically
// correct (a keyboard user can tab into it), but it reads as a false positive
// to site owners without context. Require BOTH signals — a form-field name/id
// token matching hp/honeypot/trap AND a <form> ancestor — so a real a11y bug
// on an unrelated hidden control never gets silently downgraded (#1100).
const HONEYPOT_TOKEN_PATTERN = /(?:^|[-_])(?:hp|honeypot|trap)(?:$|[-_])/i;

function isHoneypotCandidate(el: Element): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const id = el.getAttribute("id") || "";
  const name = el.getAttribute("name") || "";
  if (!HONEYPOT_TOKEN_PATTERN.test(id) && !HONEYPOT_TOKEN_PATTERN.test(name)) {
    return false;
  }
  return el.closest("form") !== null;
}

function labelFor(el: Element): string {
  const tagName = el.tagName.toLowerCase();
  const id = el.getAttribute("id") || el.getAttribute("name") || "";
  return id ? `${tagName}#${id}` : tagName;
}

export const ariaHiddenFocusRule: Rule = {
  meta: {
    id: "a11y/aria-hidden-focus",
    name: "ARIA Hidden Focus",
    description: "Ensures aria-hidden elements do not contain focusable content",
    solution:
      "Elements with aria-hidden='true' should not contain focusable content. When an element is hidden from assistive technology but still focusable, keyboard users can tab to it but screen reader users won't know what they're interacting with. Either remove aria-hidden or make children non-focusable with tabindex='-1'.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Find all aria-hidden elements
    const hiddenElements = doc.querySelectorAll('[aria-hidden="true"]');
    const focusableInHidden: string[] = [];
    const honeypotInHidden: string[] = [];

    for (const hidden of hiddenElements) {
      // Check if the hidden element itself is focusable
      if (isFocusable(hidden)) {
        if (isHoneypotCandidate(hidden)) {
          honeypotInHidden.push(labelFor(hidden));
        } else {
          focusableInHidden.push(`${hidden.tagName.toLowerCase()} (self is focusable)`);
        }
        continue;
      }

      // Check for focusable children
      const allChildren = hidden.querySelectorAll("*");
      for (const child of allChildren) {
        if (!isFocusable(child)) continue;

        const label = labelFor(child);
        if (isHoneypotCandidate(child)) {
          honeypotInHidden.push(label);
        } else {
          focusableInHidden.push(label);
        }
      }
    }

    if (focusableInHidden.length > 0) {
      checks.push({
        name: "aria-hidden-focus",
        status: "fail",
        message: `${focusableInHidden.length} focusable element(s) inside aria-hidden`,
        items: focusableInHidden.slice(0, 10).map((id) => ({ id })),
        details:
          focusableInHidden.length > 10 ? { additional: focusableInHidden.length - 10 } : undefined,
      });
    }

    if (honeypotInHidden.length > 0) {
      checks.push({
        name: "aria-hidden-focus-honeypot",
        status: "warn",
        message: `${honeypotInHidden.length} focusable element(s) inside aria-hidden appear to be an anti-spam honeypot`,
        items: honeypotInHidden.slice(0, 10).map((id) => ({ id })),
        value:
          'Add tabindex="-1" (and autocomplete="off") to remove the honeypot from the tab order',
        details:
          honeypotInHidden.length > 10 ? { additional: honeypotInHidden.length - 10 } : undefined,
      });
    }

    if (focusableInHidden.length === 0 && honeypotInHidden.length === 0) {
      if (hiddenElements.length > 0) {
        checks.push({
          name: "aria-hidden-focus",
          status: "pass",
          message: "No focusable elements inside aria-hidden regions",
          details: { hiddenRegions: hiddenElements.length },
        });
      } else {
        checks.push({
          name: "aria-hidden-focus",
          status: "info",
          message: "No aria-hidden elements found",
        });
      }
    }

    return { checks };
  },
};
