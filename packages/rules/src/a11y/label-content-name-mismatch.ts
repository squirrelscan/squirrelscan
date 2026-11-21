// a11y/label-content-name-mismatch - Label text matches accessible name

import { wcag } from "@squirrelscan/core-contracts/wcag";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { elementSelector } from "../element-path";
import {
  type ControlItem,
  createStaticVisibility,
  unconfirmedItem,
  unconfirmedRow,
} from "../shared/static-hidden";

// Elements that render apart from their siblings, so text on either side is two words.
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const INLINE_BLOCK_DISPLAY =
  /display\s*:\s*(?:block|flex|grid|table|list-item|flow-root)/i;

// Items show both strings in full up to this many characters.
const MAX_ITEM_TEXT = 120;
const clip = (s: string) =>
  s.length > MAX_ITEM_TEXT ? `${s.slice(0, MAX_ITEM_TEXT)}...` : s;

function getVisibleText(el: Element): string {
  // Get only visible text content (excluding aria-hidden)
  let text = "";

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      // Text node
      text += node.textContent || "";
    } else if (node.nodeType === 1) {
      // Element node
      const element = node as Element;
      const ariaHidden = element.getAttribute("aria-hidden");
      const hidden = element.getAttribute("hidden");

      if (ariaHidden === "true" || hidden !== null) return;

      const apart =
        BLOCK_TAGS.has(element.tagName.toLowerCase()) ||
        INLINE_BLOCK_DISPLAY.test(element.getAttribute("style") ?? "");
      if (apart) text += " ";
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
      if (apart) text += " ";
    }
  };

  walk(el);
  return text.trim().toLowerCase();
}

// Visible text with no letter or digit (✕ × ✖ ☰ › punctuation, emoji) is a symbol used as an icon,
// not a label a user would speak: WCAG 2.5.3 excludes it, as does axe-core's rule of the same name.
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export const labelContentNameMismatchRule: Rule = {
  meta: {
    id: "a11y/label-content-name-mismatch",
    name: "Label Content Name Mismatch",
    description: "Checks that visible label text is part of accessible name",
    solution:
      "For controls with visible labels, the accessible name should contain the visible text. Voice control users say what they see - if the accessible name doesn't include the visible label, voice commands won't work. Example: A button showing 'Search' should not have aria-label='Find products'.",
    category: "a11y",
    wcag: [wcag("2.5.3")],
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 7,
    messageCountsItems: true,
    itemSelectors: true,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check elements with visible text and aria-label
    const elementsWithAriaLabel = doc.querySelectorAll(
      "button[aria-label], a[aria-label], [role='button'][aria-label], [role='link'][aria-label], input[aria-label], select[aria-label]"
    );

    const mismatches: Array<{ id: string; selector?: string }> = [];
    const unconfirmed: ControlItem[] = [];
    // A control that is not rendered is out of the accessibility tree, so it has no label to speak.
    const visibility = createStaticVisibility({ ariaHidden: true });

    for (const el of elementsWithAriaLabel) {
      const ariaLabel =
        el.getAttribute("aria-label")?.toLowerCase().trim() || "";
      if (!ariaLabel) continue;

      const visibleText = getVisibleText(el);
      if (!visibleText) continue; // No visible text to compare
      if (!HAS_LETTER_OR_DIGIT.test(visibleText)) continue; // A symbol used as an icon

      // Check if visible text is contained in aria-label
      // Normalize for comparison
      const normalizedVisible = visibleText.replace(/\s+/g, " ");
      const normalizedAriaLabel = ariaLabel.replace(/\s+/g, " ");

      // Class-based flex/block children cannot be seen statically and may join with no space
      // ("Baptist" + "Example"), so whitespace differences alone are not a mismatch.
      const squash = (v: string) => v.replace(/\s+/g, "");
      if (
        !normalizedAriaLabel.includes(normalizedVisible) &&
        !squash(normalizedAriaLabel).includes(squash(normalizedVisible))
      ) {
        const seen = visibility.visibility(el);
        if (seen.state === "hidden") continue;
        const tagName = el.tagName.toLowerCase();
        const id = `${tagName}: visible="${clip(normalizedVisible)}" vs aria-label="${clip(normalizedAriaLabel)}"`;
        if (seen.state === "unknown") {
          const item = unconfirmedItem(id, seen) as Exclude<
            ControlItem,
            string
          >;
          unconfirmed.push(
            ctx.wantsItemSelectors
              ? { ...item, selector: elementSelector(el) }
              : item
          );
          continue;
        }
        mismatches.push({
          id,
          ...(ctx.wantsItemSelectors ? { selector: elementSelector(el) } : {}),
        });
      }
    }

    if (mismatches.length > 0) {
      checks.push({
        name: "label-content-name-mismatch",
        status: "fail",
        message: `${mismatches.length} element(s) where visible text doesn't match accessible name`,
        items: mismatches.slice(0, 10),
        details: {
          issue:
            "Voice control users may not be able to activate these controls",
          ...(mismatches.length > 10
            ? { additional: mismatches.length - 10 }
            : {}),
        },
      });
    }
    if (unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "label-content-name-mismatch",
          "control(s) with a mismatched name",
          unconfirmed
        )
      );
    }
    if (
      mismatches.length === 0 &&
      unconfirmed.length === 0 &&
      elementsWithAriaLabel.length > 0
    ) {
      checks.push({
        name: "label-content-name-mismatch",
        status: "pass",
        message: "Visible labels match accessible names",
      });
    } else if (mismatches.length === 0 && unconfirmed.length === 0) {
      checks.push({
        name: "label-content-name-mismatch",
        status: "info",
        message: "No elements with aria-label and visible text found",
      });
    }

    return { checks };
  },
};
