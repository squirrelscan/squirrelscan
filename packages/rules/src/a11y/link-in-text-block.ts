// a11y/link-in-text-block - Links distinguishable from text

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

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
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check links within text-heavy elements
    const textBlocks = doc.querySelectorAll(
      "p, li, td, th, dd, blockquote, figcaption"
    );
    let linksInText = 0;
    const linksWithoutUnderline: string[] = [];

    for (const block of textBlocks) {
      const links = block.querySelectorAll("a[href]");

      for (const link of links) {
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

        if (hasNoUnderlineStyle || hasNoUnderlineClass) {
          const text = link.textContent?.trim().slice(0, 30);
          linksWithoutUnderline.push(
            `"${text}${text && text.length >= 30 ? "..." : ""}"`
          );
        }
      }
    }

    if (linksWithoutUnderline.length > 0) {
      checks.push({
        name: "link-in-text-block",
        status: "warn",
        message: `${linksWithoutUnderline.length} link(s) in text may lack underlines`,
        items: linksWithoutUnderline.slice(0, 10).map((id) => ({ id })),
        details: {
          note: "Links need visual distinction beyond color",
          suggestion:
            "Ensure 3:1 contrast with surrounding text or add underlines",
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
