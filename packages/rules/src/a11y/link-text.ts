// a11y/link-text - Check for descriptive link text
// Based on WCAG 2.4.4 Link Purpose (In Context) (Level A)

import { hasUnsafeUrlScheme } from "@squirrelscan/utils";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// Generic link text that doesn't describe the destination
// Expanded list based on Lighthouse and common patterns
const GENERIC_LINK_TEXT = [
  // Original
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "click",
  "this",
  "go",
  "see more",
  "continue",
  "details",
  // Action words without context
  "view",
  "download",
  "visit",
  "open",
  "access",
  "get",
  "start",
  "begin",
  // Sign up/account related
  "sign up",
  "signup",
  "register",
  "subscribe",
  "join",
  "login",
  "log in",
  "sign in",
  // Navigation
  "next",
  "previous",
  "back",
  "forward",
  "skip",
  // Common CTA
  "submit",
  "send",
  "buy",
  "shop",
  "order",
  "buy now",
  "shop now",
  "order now",
  // Info seeking
  "info",
  "information",
  "find out",
  "find out more",
  "see details",
  "view details",
  "full details",
  // Misc
  "website",
  "page",
  "site",
  "check it out",
  "discover",
  "explore",
];

/**
 * Get accessible name from an element
 * Follows accessible name computation (simplified)
 */
function getAccessibleName(link: Element, doc: Document): string | null {
  // 1. aria-labelledby (references other elements)
  const labelledBy = link.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const texts: string[] = [];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) {
        texts.push(el.textContent?.trim() || "");
      }
    }
    if (texts.some((t) => t.length > 0)) {
      return texts.join(" ");
    }
  }

  // 2. aria-label
  const ariaLabel = link.getAttribute("aria-label");
  if (ariaLabel?.trim()) {
    return ariaLabel.trim();
  }

  // 3. title attribute (fallback)
  const title = link.getAttribute("title");
  if (title?.trim()) {
    return title.trim();
  }

  return null;
}

/**
 * Check if link has accessible content (text, image with alt, SVG with accessible name)
 */
function hasAccessibleContent(link: Element): {
  hasContent: boolean;
  contentType: string;
} {
  // Check for text content
  const text = link.textContent?.trim() || "";
  if (text) {
    return { hasContent: true, contentType: "text" };
  }

  // Check for image with alt
  const imgWithAlt = link.querySelector("img[alt]:not([alt=''])");
  if (imgWithAlt) {
    return { hasContent: true, contentType: "image" };
  }

  // Check for SVG with accessible name
  const svg = link.querySelector("svg");
  if (svg) {
    // SVG is accessible if it has title, aria-label, or aria-labelledby
    const svgTitle = svg.querySelector("title");
    const svgAriaLabel = svg.getAttribute("aria-label");
    const svgAriaLabelledby = svg.getAttribute("aria-labelledby");
    if (svgTitle?.textContent?.trim() || svgAriaLabel?.trim() || svgAriaLabelledby) {
      return { hasContent: true, contentType: "svg" };
    }
    // SVG without accessible name - this is a problem
    return { hasContent: false, contentType: "svg-no-name" };
  }

  // Check for icon font (common patterns)
  const iconElement = link.querySelector(
    'i[class*="icon"], span[class*="icon"], i[class*="fa-"], span[class*="fa-"]',
  );
  if (iconElement) {
    return { hasContent: false, contentType: "icon-font" };
  }

  // Check for role="img" with accessible name
  const roleImg = link.querySelector('[role="img"]');
  if (roleImg) {
    const imgAriaLabel = roleImg.getAttribute("aria-label");
    if (imgAriaLabel?.trim()) {
      return { hasContent: true, contentType: "role-img" };
    }
    return { hasContent: false, contentType: "role-img-no-name" };
  }

  return { hasContent: false, contentType: "empty" };
}

export const linkTextRule: Rule = {
  meta: {
    id: "a11y/link-text",
    name: "Link Text",
    description: "Checks for descriptive link text",
    solution:
      "Link text should describe the destination, not generic phrases like 'click here'. Screen reader users often navigate by links, hearing them out of context. Good: 'View our pricing plans'. Bad: 'Click here'. For icon-only links, add aria-label: <a href='/search' aria-label='Search'><svg>...</svg></a>. Empty links are especially problematic - add text or aria-label.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const links = doc.querySelectorAll("a[href]");
    const genericLinks: string[] = [];
    const emptyLinks: Array<{ href: string; reason: string }> = [];

    for (const link of links) {
      const href = link.getAttribute("href") || "";

      // Skip anchor links and javascript
      if (href.trimStart().startsWith("#") || hasUnsafeUrlScheme(href)) continue;

      // Get accessible name (aria-labelledby, aria-label, title)
      const accessibleName = getAccessibleName(link, doc as unknown as Document);

      // If has accessible name via ARIA, skip further checks
      if (accessibleName) {
        // Still check if it's generic
        const normalizedName = accessibleName
          .toLowerCase()
          .replace(/[.,!?;:'"]+/g, "")
          .trim();
        if (GENERIC_LINK_TEXT.includes(normalizedName)) {
          genericLinks.push(accessibleName);
        }
        continue;
      }

      // Check for accessible content
      const { hasContent, contentType } = hasAccessibleContent(link);

      if (!hasContent) {
        emptyLinks.push({
          href: href.substring(0, 50),
          reason: contentType,
        });
        continue;
      }

      // Has content - check if it's generic
      const text = link.textContent?.trim().toLowerCase() || "";
      const normalizedText = text.replace(/[.,!?;:'"]+/g, "").trim();
      if (GENERIC_LINK_TEXT.includes(normalizedText)) {
        genericLinks.push(text);
      }
    }

    if (emptyLinks.length > 0) {
      checks.push({
        name: "link-text-empty",
        status: "fail",
        message: `${emptyLinks.length} link(s) with no accessible text`,
        items: emptyLinks.map((item) => ({
          id: item.href,
          label: item.reason,
        })),
        details: {
          reasons: [...new Set(emptyLinks.map((e) => e.reason))],
        },
      });
    }

    if (genericLinks.length > 0) {
      const uniqueGeneric = [...new Set(genericLinks)];
      checks.push({
        name: "link-text-generic",
        status: "warn",
        message: `${genericLinks.length} link(s) with generic text`,
        items: uniqueGeneric.map((text) => ({ id: text })),
      });
    }

    if (emptyLinks.length === 0 && genericLinks.length === 0 && links.length > 0) {
      checks.push({
        name: "link-text",
        status: "pass",
        message: "All links have descriptive text",
        details: { linksChecked: links.length },
      });
    }

    return { checks };
  },
};
