// a11y/aria-hidden-focus - Aria-hidden not on focusable elements

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { UNCONFIRMED_CHECK_SUFFIX } from "@squirrelscan/core-contracts/resolution";
import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

import {
  createStaticVisibility,
  unconfirmedItem,
  unconfirmedMessageFor,
  type StaticVisibility,
} from "../shared/static-hidden";

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

type Finding = "focusable" | "honeypot" | "unconfirmed";

/** A finding's entries: the true total, the first ten, whether every unconfirmed one is width-only. */
interface Findings {
  total: number;
  first: CheckItem[];
  allWidth: boolean;
}

/** An element a hidden container's scan reports, at its pre-order position. */
interface Reportable {
  pos: number;
  el: Element;
  finding: Finding;
  seen: StaticVisibility;
}

/** First index in `list` whose position is above `pos`. */
function firstAfter(list: Reportable[], pos: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.pos <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const ariaHiddenFocusRule: Rule = {
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
    // Controls an inline style the check cannot read exactly may hide are
    // reported as candidates, not as failures (pub#664).
    // aria-hidden is what this rule is about, so it does not count as hiding.
    const visibility = createStaticVisibility({ ariaHidden: false });

    /** What a focusable element would be filed as, or null when CSS or markup hides it. */
    const findingOf = (el: Element): { finding: Finding; seen: StaticVisibility } | null => {
      const seen = visibility.visibility(el);
      // Hidden by markup or a plain inline style: not focusable.
      if (seen.state === "hidden") return null;
      if (isHoneypotCandidate(el)) return { finding: "honeypot", seen };
      return { finding: seen.state === "unknown" ? "unconfirmed" : "focusable", seen };
    };

    // squirrelscan/repo#3066: one pre-order walk of the document instead of a
    // `querySelectorAll("*")` per hidden container plus an ancestor walk per
    // descendant, which made nested containers cubic (55 s at 1,000 levels).
    //
    // A container is skipped when `inert` or `hidden` covers it, and a
    // descendant under such an attribute below it is not reported. So, for a
    // container that is not skipped, a descendant is reported exactly when no
    // such attribute covers the descendant at all: one above the container
    // would have skipped the container. Each container's scan is therefore
    // the run of reportable elements between its entry and exit positions,
    // and its findings are counted from those runs, in the same order and
    // with the same multiplicity (a control inside two hidden containers is
    // filed once per container) as before.
    const isHidden = new Set(hiddenElements);
    const reportables: Record<Finding, Reportable[]> = {
      focusable: [],
      honeypot: [],
      unconfirmed: [],
    };
    const containers: Array<{ el: Element; entry: number; exit: number }> = [];
    let pos = 0;
    const root = doc.documentElement as Element | null;
    if (root) {
      type Frame = { el: Element; covered: boolean; inHidden: boolean } | { leave: number };
      const stack: Frame[] = [{ el: root, covered: false, inHidden: false }];
      while (stack.length > 0) {
        const frame = stack.pop()!;
        if ("leave" in frame) {
          containers[frame.leave]!.exit = pos;
          continue;
        }
        const { el } = frame;
        pos++;
        const hiddenAttr = getAttrCI(el, "hidden");
        const covered =
          frame.covered ||
          hasAttrCI(el, "inert") ||
          (hiddenAttr !== null && hiddenAttr.toLowerCase() !== "until-found");
        // Inside a container (any open one): what its scan would report.
        if (frame.inHidden && !covered && isFocusable(el)) {
          const found = findingOf(el);
          if (found) reportables[found.finding].push({ pos, el, ...found });
        }
        let inHidden = frame.inHidden;
        if (isHidden.has(el) && !covered) {
          inHidden = true;
          containers.push({ el, entry: pos, exit: pos });
          stack.push({ leave: containers.length - 1 });
        }
        const children = el.children;
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ el: children[i] as Element, covered, inHidden });
        }
      }
    }

    const findings: Record<Finding, Findings> = {
      focusable: { total: 0, first: [], allWidth: true },
      honeypot: { total: 0, first: [], allWidth: true },
      unconfirmed: { total: 0, first: [], allWidth: true },
    };
    const isWidthOnly = (seen: StaticVisibility) => seen.state === "unknown" && seen.reason === "width";
    const itemFor = (finding: Finding, label: string, seen: StaticVisibility): CheckItem =>
      finding === "unconfirmed" ? unconfirmedItem(label, seen) : { id: label };
    // Unconfirmed reportables that are not width-only, counted up to each index.
    const notWidthBefore = [0];
    for (const item of reportables.unconfirmed) {
      notWidthBefore.push(notWidthBefore.at(-1)! + (isWidthOnly(item.seen) ? 0 : 1));
    }

    for (const { el: hidden, entry, exit } of containers) {
      // A container that can itself be focused is the finding, and its
      // descendants are not scanned for it. A container CSS hides is not, but
      // a descendant can show itself again (`visibility:visible`), so its
      // descendants are checked instead.
      if (isFocusable(hidden)) {
        const self = findingOf(hidden);
        if (self) {
          const into = findings[self.finding];
          into.total++;
          if (self.finding === "unconfirmed" && !isWidthOnly(self.seen)) into.allWidth = false;
          if (into.first.length < 10) {
            into.first.push(
              itemFor(self.finding, `${hidden.tagName.toLowerCase()} (self is focusable)`, self.seen),
            );
          }
          continue;
        }
      }
      for (const finding of ["focusable", "honeypot", "unconfirmed"] as const) {
        const list = reportables[finding];
        const from = firstAfter(list, entry);
        const to = firstAfter(list, exit);
        if (to === from) continue;
        const into = findings[finding];
        into.total += to - from;
        if (finding === "unconfirmed" && notWidthBefore[to]! - notWidthBefore[from]! > 0) {
          into.allWidth = false;
        }
        for (let i = from; i < to && into.first.length < 10; i++) {
          const item = list[i]!;
          into.first.push(itemFor(finding, labelFor(item.el), item.seen));
        }
      }
    }

    const focusableInHidden = findings.focusable;
    const honeypotInHidden = findings.honeypot;
    const unconfirmed = findings.unconfirmed;

    if (focusableInHidden.total > 0) {
      checks.push({
        name: "aria-hidden-focus",
        status: "fail",
        message: `${focusableInHidden.total} focusable element(s) inside aria-hidden`,
        items: focusableInHidden.first,
        details:
          focusableInHidden.total > 10 ? { additional: focusableInHidden.total - 10 } : undefined,
      });
    }

    if (honeypotInHidden.total > 0) {
      checks.push({
        name: "aria-hidden-focus-honeypot",
        status: "warn",
        message: `${honeypotInHidden.total} focusable element(s) inside aria-hidden appear to be an anti-spam honeypot`,
        items: honeypotInHidden.first,
        value:
          'Add tabindex="-1" (and autocomplete="off") to remove the honeypot from the tab order',
        details:
          honeypotInHidden.total > 10 ? { additional: honeypotInHidden.total - 10 } : undefined,
      });
    }

    if (unconfirmed.total > 0) {
      checks.push({
        name: `aria-hidden-focus${UNCONFIRMED_CHECK_SUFFIX}`,
        status: "warn",
        message: unconfirmedMessageFor(
          "focusable element(s) inside aria-hidden",
          unconfirmed.total,
          unconfirmed.allWidth,
        ),
        items: unconfirmed.first,
        details: unconfirmed.total > 10 ? { additional: unconfirmed.total - 10 } : undefined,
      });
    }

    if (
      focusableInHidden.total === 0 &&
      honeypotInHidden.total === 0 &&
      unconfirmed.total === 0
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
