// i18n/hreflang - Checks for hreflang tags

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const hreflangRule: Rule = {
  meta: {
    id: "i18n/hreflang",
    name: "Hreflang Tags",
    description: "Checks for hreflang link elements",
    solution:
      "Hreflang tags tell search engines about language and regional variations of pages, preventing duplicate content issues and ensuring users see the right version. Add hreflang link tags for each language/region version of a page. Include x-default for the fallback. Every page referenced should link back to all variants (bidirectional). Use correct ISO language and country codes.",
    category: "i18n",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const hreflangs = doc.querySelectorAll('link[rel="alternate"][hreflang]');

    if (hreflangs.length === 0) {
      // This is only informational - not all pages need hreflang
      checks.push({
        name: "hreflang",
        status: "info",
        message:
          "No hreflang tags found (not required for single-language sites)",
        value: null,
      });
      return { checks };
    }

    // Check for x-default
    let hasXDefault = false;
    let hasSelfReference = false;
    const languages: string[] = [];

    for (const link of hreflangs) {
      const hreflang = (link as Element).getAttribute("hreflang");
      const href = (link as Element).getAttribute("href");

      if (hreflang) {
        languages.push(hreflang);
        if (hreflang === "x-default") {
          hasXDefault = true;
        }
        // Check if this is self-referencing
        if (href) {
          try {
            const linkUrl = new URL(href, ctx.page.url);
            const pageUrl = new URL(ctx.page.url);
            if (linkUrl.href === pageUrl.href) {
              hasSelfReference = true;
            }
          } catch {
            // Ignore URL parsing errors
          }
        }
      }
    }

    if (!hasXDefault) {
      checks.push({
        name: "hreflang-xdefault",
        status: "warn",
        message: "No x-default hreflang found",
        value: null,
      });
    }

    if (!hasSelfReference) {
      checks.push({
        name: "hreflang-self",
        status: "warn",
        message: "No self-referencing hreflang found",
        value: null,
      });
    }

    checks.push({
      name: "hreflang",
      status: "pass",
      message: `${hreflangs.length} hreflang tag(s) found`,
      items: languages.map((lang) => ({ id: lang })),
    });

    return { checks };
  },
};
