// a11y/empty-heading - Headings have content

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const emptyHeadingRule: Rule = {
  meta: {
    id: "a11y/empty-heading",
    name: "Empty Headings",
    description: "Checks that heading elements have visible content",
    solution:
      "Headings (h1-h6) must have text content for screen readers to announce. Empty headings create confusing navigation. Either add text content, use aria-label, or remove the empty heading element.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const emptyHeadings: string[] = [];

    for (const heading of headings) {
      const text = heading.textContent?.trim();
      const ariaLabel = heading.getAttribute("aria-label")?.trim();
      const ariaLabelledby = heading.getAttribute("aria-labelledby");
      const ariaHidden = heading.getAttribute("aria-hidden");

      // Skip hidden headings
      if (ariaHidden === "true") continue;

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

      if (!hasContent) {
        const level = heading.tagName.toLowerCase();
        const id = heading.getAttribute("id");
        const cls = heading.getAttribute("class")?.split(" ")[0];
        emptyHeadings.push(
          id ? `${level}#${id}` : cls ? `${level}.${cls}` : level
        );
      }
    }

    if (emptyHeadings.length > 0) {
      checks.push({
        name: "empty-heading",
        status: "warn",
        message: `${emptyHeadings.length} empty heading(s) found`,
        items: emptyHeadings.slice(0, 10).map((id) => ({ id })),
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
