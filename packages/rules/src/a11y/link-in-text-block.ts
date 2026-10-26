// a11y/link-in-text-block - Links distinguishable from text

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const TEXT_BLOCK_SELECTOR = "p, li, td, th, dd, blockquote, figcaption";

/**
 * Every link inside a text block, once, in document order
 * (squirrelscan/repo#3355). A link in nested blocks (a list in a list item, a
 * quote in a quote) used to be counted, and reported, once per enclosing block,
 * and the per-block `querySelectorAll("a[href]")` made nested blocks quadratic.
 * One walk of the page instead, over the elements the two selectors return.
 */
function linksInTextBlocks(doc: Document): Element[] {
  const isLink = new Set<Element>(doc.querySelectorAll("a[href]"));
  if (isLink.size === 0) return [];
  const isBlock = new Set<Element>(doc.querySelectorAll(TEXT_BLOCK_SELECTOR));
  const links: Element[] = [];
  const stack: Array<{ el: Element; inBlock: boolean }> = [];
  const pushChildren = (parent: ParentNode, inBlock: boolean) => {
    const children = parent.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ el: children[i] as Element, inBlock });
    }
  };
  pushChildren(doc, false);
  while (stack.length > 0) {
    const { el, inBlock } = stack.pop()!;
    // The selectors above never return template content.
    if (el.localName === "template") continue;
    if (inBlock && isLink.has(el)) links.push(el);
    pushChildren(el, inBlock || isBlock.has(el));
  }
  return links;
}

export const linkInTextBlockRule: Rule = {
  meta: {
    id: "a11y/link-in-text-block",
    name: "Link in Text Block",
    description:
      "Checks that links in text blocks are visually distinguishable",
    solution:
      "Links within text blocks must be distinguishable by more than just color (for color-blind users). Use underlines, bold, borders, or other visual indicators. Exception: Links can rely on color alone if the contrast ratio between link and surrounding text is at least 3:1 and you provide additional cues on hover/focus.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    let linksInText = 0;
    const linksWithoutUnderline: Element[] = [];

    // Check links within text-heavy elements
    for (const link of linksInTextBlocks(doc)) {
      linksInText++;

      // Check inline styles for text-decoration: none
      const style = link.getAttribute("style") || "";
      const hasNoUnderlineStyle =
        style.toLowerCase().includes("text-decoration") &&
        (style.toLowerCase().includes("none") ||
          !style.toLowerCase().includes("underline"));

      // Also check for common class patterns that remove underlines
      const className = link.getAttribute("class") || "";
      const hasNoUnderlineClass =
        className.includes("no-underline") ||
        className.includes("text-decoration-none");

      if (hasNoUnderlineStyle || hasNoUnderlineClass) linksWithoutUnderline.push(link);
    }

    if (linksWithoutUnderline.length > 0) {
      checks.push({
        name: "link-in-text-block",
        status: "warn",
        message: `${linksWithoutUnderline.length} link(s) in text may lack underlines`,
        // Text read for the shown ten only: a link's text is its whole subtree's.
        items: linksWithoutUnderline.slice(0, 10).map((link) => {
          const text = link.textContent?.trim().slice(0, 30);
          return { id: `"${text}${text && text.length >= 30 ? "..." : ""}"` };
        }),
        details: {
          note: "Links need visual distinction beyond color",
          suggestion:
            "Ensure 3:1 contrast with surrounding text or add underlines",
          ...(linksWithoutUnderline.length > 10
            ? { additional: linksWithoutUnderline.length - 10 }
            : {}),
        },
      });
    } else if (linksInText > 0) {
      checks.push({
        name: "link-in-text-block",
        status: "pass",
        message: "Links in text blocks appear distinguishable",
        details: { linksChecked: linksInText },
      });
    } else {
      checks.push({
        name: "link-in-text-block",
        status: "info",
        message: "No links found in text blocks",
      });
    }

    return { checks };
  },
};
