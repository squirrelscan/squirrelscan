// eeat/about-page - About/company page presence

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname } from "@squirrelscan/utils";

import { findLinkedUncrawledPage, linkedUncrawledCheck } from "../shared/linked-uncrawled-page";

const isAboutPath = (url: string): boolean =>
  EEAT_PAGE_PATTERNS.about.some((p) => p.test(getPathname(url)));

export const aboutPageRule: Rule = {
  meta: {
    id: "eeat/about-page",
    name: "About Page",
    description: "Checks for an about/company page with content",
    solution:
      "An About page establishes credibility and trust. Include company history, mission, team overview, and credentials. Link from main navigation or footer. For E-E-A-T, explain your expertise and why visitors should trust you. Include contact information and physical location if applicable. An About page your pages link to but the crawl did not fetch (an excluded path, or past the page limit) is reported as linked but not crawled rather than missing.",
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
    let aboutPage: string | null = null;
    let aboutPageWordCount = 0;

    for (const page of pages) {
      const matchesUrl = isAboutPath(page.url);
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
      // pub#740: an About page the pages link to but the crawl never fetched
      // (an excluded path, or past the page budget) is unverified, not missing.
      const linked = ctx.site ? findLinkedUncrawledPage(ctx.site, { href: isAboutPath }) : null;
      checks.push(
        linked
          ? linkedUncrawledCheck("about-page", "About page", linked)
          : {
              name: "about-page",
              status: "warn",
              message: "No About page found",
              value: "Create /about or /about-us page",
            },
      );
    }

    return { checks };
  },
};
