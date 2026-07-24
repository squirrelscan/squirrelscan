// core/favicon - Favicon presence check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const faviconRule: Rule = {
  meta: {
    id: "core/favicon",
    name: "Favicon",
    description: "Checks for favicon presence",
    solution:
      "Favicons help with brand recognition and UX. Include multiple formats: <link rel='icon' href='/favicon.ico'> for legacy, <link rel='icon' type='image/svg+xml' href='/favicon.svg'> for modern browsers, and <link rel='apple-touch-icon' href='/apple-touch-icon.png'> for iOS. 32x32px for .ico, 180x180px for Apple touch icon.",
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check for various favicon formats
    const faviconSelectors = [
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]',
      'link[rel*="icon"]',
    ];

    const foundFavicons: string[] = [];

    for (const selector of faviconSelectors) {
      const links = doc.querySelectorAll(selector);
      for (const link of links) {
        const href = link.getAttribute("href");
        const rel = link.getAttribute("rel") || "";
        if (href) {
          if (rel.includes("apple-touch-icon")) {
            foundFavicons.push("apple-touch-icon");
          } else if (href.endsWith(".svg")) {
            foundFavicons.push("svg");
          } else if (href.endsWith(".ico")) {
            foundFavicons.push("ico");
          } else if (href.endsWith(".png")) {
            foundFavicons.push("png");
          } else {
            foundFavicons.push("icon");
          }
        }
      }
    }

    // Deduplicate
    const uniqueFavicons = [...new Set(foundFavicons)];

    if (uniqueFavicons.length === 0) {
      checks.push({
        name: "favicon",
        status: "warn",
        message: "No favicon found",
        value: "Add <link rel='icon'> for brand recognition",
      });
    } else if (uniqueFavicons.length === 1) {
      checks.push({
        name: "favicon",
        status: "pass",
        message: `Favicon found: ${uniqueFavicons[0]}`,
        value: "Consider adding multiple formats (ico, svg, apple-touch-icon)",
      });
    } else {
      checks.push({
        name: "favicon",
        status: "pass",
        message: `Multiple favicon formats found`,
        items: uniqueFavicons.map((format) => ({ id: format })),
      });
    }

    // Check specifically for apple-touch-icon
    if (
      !uniqueFavicons.includes("apple-touch-icon") &&
      uniqueFavicons.length > 0
    ) {
      checks.push({
        name: "apple-touch-icon",
        status: "info",
        message: "No Apple touch icon found",
        value: "Add for iOS home screen bookmarks",
      });
    }

    return { checks };
  },
};
