// eeat/about-page - About/company page presence

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname } from "@squirrelscan/utils";

import {
  INPAGE_SECTIONS_UNMEASURED_MESSAGE,
  describeSectionPage,
  findInPageSection,
  inPageSectionsUnmeasured,
} from "../shared/inpage-section";
import { eeatPathsSchema, matchesConfiguredPaths, probedConfiguredPages, probedNote } from "../shared/eeat-paths";
import { findLinkedUncrawledPage, linkedUncrawledCheck } from "../shared/linked-uncrawled-page";

export const optionsSchema = z.object({ paths: eeatPathsSchema });

// A configured path wins first (#1261), then the built-in slugs.
const isAboutPath = (url: string, paths: readonly string[] = []): boolean =>
  matchesConfiguredPaths(url, paths) ||
  EEAT_PAGE_PATTERNS.about.some((p) => p.test(getPathname(url)));

export const aboutPageRule: Rule = {
  meta: {
    id: "eeat/about-page",
    name: "About Page",
    description: "Checks for an about/company page with content",
    solution:
      "An About page establishes credibility and trust. Include company history, mission, team overview, and credentials. Link from main navigation or footer. For E-E-A-T, explain your expertise and why visitors should trust you. Include contact information and physical location if applicable. A concrete path in `paths` that the crawl did not reach is requested once after the crawl (robots.txt and the per-host limits apply), so an About page nothing links to is found; the finding says which paths were probed. An About page your pages link to but the crawl did not fetch (an excluded path, or past the page limit) is reported as linked but not crawled rather than missing. On a single-page site, an About section (an element whose id is about, about-us or a localised slug, linked from the page as #about) counts as the About page; add enough content to it (200 words or more).",
    category: "eeat",
    scope: "site",
    discoveryProbes: ["configured-pages"],
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const { paths } = optionsSchema.parse(ctx.options);
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
    let section: ReturnType<typeof findInPageSection> = null;

    for (const page of pages) {
      const matchesUrl = isAboutPath(page.url, paths);
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
    } else if ((section = findInPageSection(ctx, "about"))) {
      // #1208: a one-page site's About is a section of the homepage.
      const where = `${describeSectionPage(section.url)} (#${section.id})`;
      checks.push(
        section.wordCount >= 200
          ? {
              name: "about-page",
              status: "pass",
              message: `About section found on ${where}`,
              value: `${section.url}#${section.id}`,
            }
          : {
              name: "about-page",
              status: "info",
              message: `About section exists on ${where} but has limited content`,
              value: `${section.wordCount} words - consider expanding`,
            },
      );
    } else if (pages.length === 1 && inPageSectionsUnmeasured(ctx)) {
      // A one-page site's About may be a section, and this cached snapshot never recorded them.
      checks.push({
        name: "about-page",
        status: "skipped",
        message: INPAGE_SECTIONS_UNMEASURED_MESSAGE,
      });
    } else {
      // pub#740: an About page the pages link to but the crawl never fetched
      // (an excluded path, or past the page budget) is unverified, not missing.
      const probed = probedConfiguredPages(ctx.site, paths);
      const probedFound = probed.find((p) => p.outcome === "found");
      const linked = ctx.site ? findLinkedUncrawledPage(ctx.site, { href: (url) => isAboutPath(url, paths) }) : null;
      if (probedFound) {
        // #1428: the crawl did not reach it, the probe did.
        const words = probedFound.wordCount;
        checks.push(
          words !== null && words < 200
            ? {
                name: "about-page",
                status: "info",
                message: `About page exists but has limited content (found by probing ${probedFound.path}, not reached by the crawl)`,
                value: `${words} words - consider expanding`,
                details: { probed: true, path: probedFound.path, status: probedFound.status },
              }
            : {
                name: "about-page",
                status: "pass",
                message: `About page exists (found by probing ${probedFound.path}, not reached by the crawl)`,
                value: probedFound.url,
                details: { probed: true, path: probedFound.path, status: probedFound.status },
              },
        );
      } else {
        checks.push(
          linked
            ? linkedUncrawledCheck("about-page", "About page", linked)
            : {
                name: "about-page",
                status: "warn",
                message: probed.length > 0 ? `No About page found ${probedNote(probed)}` : "No About page found",
                value: "Create /about or /about-us page",
                ...(probed.length > 0 ? { details: { probed: true, paths: probed.map((p) => p.path) } } : {}),
              },
        );
      }
    }

    return { checks };
  },
};
