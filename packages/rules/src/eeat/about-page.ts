// eeat/about-page - About/company page presence

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname } from "@squirrelscan/utils";

export const aboutPageRule: Rule = {
  meta: {
    id: "eeat/about-page",
    name: "About Page",
    description: "Checks for an about/company page with content",
    solution:
      "An About page establishes credibility and trust. Include company history, mission, team overview, and credentials. Link from main navigation or footer. For E-E-A-T, explain your expertise and why visitors should trust you. Include contact information and physical location if applicable.",
    category: "eeat",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "about-page",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for about page by multilingual URL pattern, then fall back to
    // Schema.org `AboutPage` @type when the URL slug isn't recognized
    // (e.g. an unknown localized path). See issue #121.
    const aboutPatterns = EEAT_PAGE_PATTERNS.about;

    let aboutPage: string | null = null;
    let aboutPageWordCount = 0;

    for (const page of pages) {
      const path = getPathname(page.url);
      const matchesUrl = aboutPatterns.some((p) => p.test(path));
      const matchesSchema = page.parsed.schemas.hasType("AboutPage");
      if (matchesUrl || matchesSchema) {
        aboutPage = page.url;
        aboutPageWordCount = page.parsed.content.wordCount;
        break;
      }
    }

    if (aboutPage) {
      if (aboutPageWordCount >= 200) {
        checks.push({
          name: "about-page",
          status: "pass",
          message: "About page exists with substantial content",
          value: aboutPage,
        });
      } else {
        checks.push({
          name: "about-page",
          status: "info",
          message: "About page exists but has limited content",
          value: `${aboutPageWordCount} words - consider expanding`,
        });
      }
    } else {
      checks.push({
        name: "about-page",
        status: "warn",
        message: "No About page found",
        value: "Create /about or /about-us page",
      });
    }

    return { checks };
  },
};
