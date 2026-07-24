// links/anchor-text - Link anchor text quality

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const MAX_SNIPPET_LEN = 120;

function truncateHtml(html: string): string {
  if (html.length <= MAX_SNIPPET_LEN) return html;
  return `${html.slice(0, MAX_SNIPPET_LEN)}...`;
}

const GENERIC_ANCHORS = [
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this",
  "this link",
  "go",
  "continue",
];

export const anchorTextRule: Rule = {
  meta: {
    id: "links/anchor-text",
    name: "Anchor Text",
    description: "Checks for empty or generic anchor text",
    solution:
      "Descriptive anchor text helps users and search engines understand link destinations. Avoid generic text like 'click here' or 'read more'. Use natural language that describes the target page. For accessibility, anchor text should make sense out of context. Avoid overly long anchor text or keyword stuffing.",
    category: "links",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const links = doc.querySelectorAll("a[href]");
    const emptyAnchors: Array<{ href: string; snippet: string }> = [];
    const genericAnchors: string[] = [];

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;

      // Skip anchor-only links
      if (href.startsWith("#")) continue;

      // Get text content, excluding images
      const text = link.textContent?.trim() || "";
      const hasImage = link.querySelector("img");
      const imageAlt = hasImage?.getAttribute("alt") || "";

      // Check for empty anchor
      if (!text && !imageAlt) {
        // Check aria-label on <a>
        const ariaLabel = link.getAttribute("aria-label")?.trim();
        if (ariaLabel) continue;

        // Check aria-labelledby on <a>
        const labelledBy = link.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/);
          const hasLabel = ids.some((id) => {
            const el = doc.getElementById(id);
            return el?.textContent?.trim();
          });
          if (hasLabel) continue;
        }

        // Check title on <a>
        const title = link.getAttribute("title")?.trim();
        if (title) continue;

        // Check SVG with accessible name
        const svg = link.querySelector("svg");
        if (svg) {
          const svgTitle = svg.querySelector("title")?.textContent?.trim();
          const svgAriaLabel = svg.getAttribute("aria-label")?.trim();
          if (svgTitle || svgAriaLabel) continue;
        }

        // Check role="img" with aria-label
        const roleImg = link.querySelector('[role="img"]');
        if (roleImg?.getAttribute("aria-label")?.trim()) continue;

        emptyAnchors.push({
          href,
          snippet: truncateHtml(link.outerHTML),
        });
        continue;
      }

      // Check for generic anchor text
      const anchor = text.toLowerCase();
      if (GENERIC_ANCHORS.includes(anchor)) {
        genericAnchors.push(`"${text}"`);
      }
    }

    if (emptyAnchors.length > 0) {
      checks.push({
        name: "empty-anchor",
        status: "warn",
        message: `${emptyAnchors.length} link(s) have empty anchor text`,
        items: emptyAnchors.map((a) => ({
          id: a.href,
          snippet: a.snippet,
        })),
      });
    }

    if (genericAnchors.length > 0) {
      const uniqueAnchors = [...new Set(genericAnchors)];
      checks.push({
        name: "generic-anchor",
        status: "info",
        message: `${genericAnchors.length} link(s) use generic anchor text`,
        items: uniqueAnchors.map((text) => ({ id: text, label: text })),
      });
    }

    if (emptyAnchors.length === 0 && genericAnchors.length === 0) {
      checks.push({
        name: "anchor-text",
        status: "pass",
        message: "Link anchor text is descriptive",
      });
    }

    return { checks };
  },
};
