// The rule as it was before squirrelscan/repo#3066, kept as the parity oracle
// for a11y-nesting-parity-3066.test.ts: the single-pass rewrite must report
// exactly what this did. Not loaded by the rule registry.

// a11y/aria-hidden-focus - Aria-hidden not on focusable elements

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../../../src/types";

import { UNCONFIRMED_CHECK_SUFFIX } from "@squirrelscan/core-contracts/resolution";
import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

import { createStaticVisibility, unconfirmedItem, unconfirmedMessage } from "../../../src/shared/static-hidden";

// Natively focusable elements. `disabled`, `type="hidden"` and tabindex are
// decided in isFocusable, case-insensitively, rather than in the selectors.
const nativeFocusableSelectors = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[contenteditable="true"]',
  "audio[controls]",
  "video[controls]",
  "details > summary",
].join(", ");

// Form controls the `disabled` attribute applies to.
const DISABLEABLE_TAGS = new Set(["button", "input", "select", "textarea"]);

/** tabindex per the HTML integer parsing rules, or null when absent or not a number. */
function parseTabindex(el: Element): number | null {
  const raw = getAttrCI(el, "tabindex");
  if (raw === null) return null;
  // ASCII whitespace only: a leading NBSP makes the value invalid, as in a browser.
  const match = /^[\t\n\f\r ]*([+-]?\d+)/.exec(raw);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Whether a keyboard user can Tab to the element, following axe-core: a disabled
 * form control never can, a negative tabindex takes it out of the tab order, a
 * tabindex of 0 or more puts it in, and otherwise native focusability decides.
 * Handles React's camelCase tabIndex via the CI helpers. Ancestors (inert,
 * hidden) are checked separately by isOutOfFocusTree, and CSS hiding by the
 * shared static visibility check.
 */
function isFocusable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (DISABLEABLE_TAGS.has(tag) && hasAttrCI(el, "disabled")) return false;
  if (tag === "input" && getAttrCI(el, "type")?.toLowerCase() === "hidden") return false;
  const tabindex = parseTabindex(el);
  if (tabindex !== null) return tabindex >= 0;
  return el.matches(nativeFocusableSelectors);
}

/**
 * Whether `inert`, or `hidden` other than `hidden="until-found"`, removes the
 * element from focus: set on the element itself or on any ancestor below
 * `stop` (pass null to walk to the root). Either takes the whole subtree out of
 * the tab order, so nothing under it can be reached with Tab (#456).
 */
function isOutOfFocusTree(el: Element, stop: Element | null): boolean {
  for (let node: Element | null = el; node && node !== stop; node = node.parentElement) {
    if (hasAttrCI(node, "inert")) return true;
    const hidden = getAttrCI(node, "hidden");
    if (hidden !== null && hidden.toLowerCase() !== "until-found") return true;
  }
  return false;
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

export const referenceAriaHiddenFocusRule: Rule = {
  meta: {
    id: "a11y/aria-hidden-focus",
    name: "ARIA Hidden Focus",
    description: "Ensures aria-hidden elements do not contain focusable content",
    solution:
      "Elements with aria-hidden='true' should not contain focusable content. When an element is hidden from assistive technology but still focusable, keyboard users can tab to it but screen reader users won't know what they're interacting with. Either remove aria-hidden, add the inert attribute to the hidden container (which takes its whole subtree out of focus), or make each focusable child non-focusable with tabindex='-1'. A control hidden by the hidden attribute, a closed dialog or an inline style='display:none' or 'visibility:hidden' is not focusable and is not reported. A <style> rule squirrel can decide (a plain selector, no media query) counts too. Vendor-prefixed display values (-webkit-box, -webkit-flex, -ms-flexbox) are read as shown, including the old fallback chain that ends in display: flex. An attribute selector with an operator ([id$=x], [href^=x], [data-a*=x], [class~=x], [lang|=en]) reaches only elements that have the attribute and a value that could satisfy it. A control carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. A control a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so a control hidden only by one is still reported.",
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

    // Find all aria-hidden elements
    const hiddenElements = doc.querySelectorAll('[aria-hidden="true"]');
    const focusableInHidden: string[] = [];
    const honeypotInHidden: string[] = [];
    // Focusable unless an inline style the check cannot read exactly hides
    // them (pub#664): reported as candidates, not as failures.
    const unconfirmed: CheckItem[] = [];
    // aria-hidden is what this rule is about, so it does not count as hiding.
    const visibility = createStaticVisibility({ ariaHidden: false });

    /**
     * Files a focusable element under the finding it belongs to, and says
     * whether it did. Called only for what used to be a finding, so CSS can
     * only clear one or make it unconfirmed.
     */
    const classify = (el: Element, label: string): boolean => {
      const seen = visibility.visibility(el);
      // Hidden by markup or a plain inline style: not focusable.
      if (seen.state === "hidden") return false;
      if (isHoneypotCandidate(el)) {
        honeypotInHidden.push(labelFor(el));
      } else if (seen.state === "unknown") {
        unconfirmed.push(unconfirmedItem(label, seen));
      } else {
        focusableInHidden.push(label);
      }
      return true;
    };

    for (const hidden of hiddenElements) {
      // An inert or hidden region (or one inside such an ancestor) has nothing
      // a keyboard user can reach.
      if (isOutOfFocusTree(hidden, null)) continue;

      // Check if the hidden element itself is focusable. A container CSS
      // hides is not, but a descendant can show itself again
      // (`visibility:visible`), so its descendants are checked instead.
      if (
        isFocusable(hidden) &&
        classify(hidden, `${hidden.tagName.toLowerCase()} (self is focusable)`)
      ) {
        continue;
      }

      // Check for focusable children
      for (const child of hidden.querySelectorAll("*")) {
        if (!isFocusable(child) || isOutOfFocusTree(child, hidden)) continue;
        classify(child, labelFor(child));
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

    if (unconfirmed.length > 0) {
      checks.push({
        name: `aria-hidden-focus${UNCONFIRMED_CHECK_SUFFIX}`,
        status: "warn",
        message: unconfirmedMessage("focusable element(s) inside aria-hidden", unconfirmed),
        items: unconfirmed.slice(0, 10),
        details: unconfirmed.length > 10 ? { additional: unconfirmed.length - 10 } : undefined,
      });
    }

    if (
      focusableInHidden.length === 0 &&
      honeypotInHidden.length === 0 &&
      unconfirmed.length === 0
    ) {
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
