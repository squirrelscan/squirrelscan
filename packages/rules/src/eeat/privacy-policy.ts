// eeat/privacy-policy - Privacy policy page presence

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { eeatPathsSchema, matchesConfiguredPaths, probedConfiguredPages, probedNote } from "../shared/eeat-paths";
import { findLinkedUncrawledPage, linkedUncrawledCheck } from "../shared/linked-uncrawled-page";
import {
  findPrivacyPage,
  isPrivacyLinkText,
  isPrivacyPath,
  pageLinksToPrivacyHref,
} from "../shared/privacy-page";

export const optionsSchema = z.object({ paths: eeatPathsSchema });

export const privacyPolicyRule: Rule = {
  meta: {
    id: "eeat/privacy-policy",
    name: "Privacy Policy",
    description: "Checks for privacy policy page linked from footer",
    solution:
      "A privacy policy is required by law in many jurisdictions (GDPR, CCPA) and signals trustworthiness. Link it from your footer on every page. Cover: what data you collect, how you use it, third-party sharing, user rights, and contact for privacy concerns. Keep it updated when practices change. A concrete path in `paths` that the crawl did not reach is requested once after the crawl (robots.txt and the per-host limits apply), so a policy nothing links to is found; the finding says which paths were probed. A policy your pages link to but the crawl did not fetch (an excluded path, or past the page limit) is reported as linked but not crawled rather than missing; crawl it to have it checked.",
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
        name: "privacy-policy",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for a privacy policy page: known slug (multilingual) OR a crawled page
    // whose title/h1 reads "privacy policy" — the slug-independent fallback that
    // catches redirects/unusual slugs (#1098). Unlike about/contact, there is no
    // standard Schema.org @type for privacy pages, so no schema fallback (#121).
    let linkedFromPages = 0;
    const privacyPage = findPrivacyPage(pages, paths);

    if (privacyPage) {
      checks.push({
        name: "privacy-policy",
        status: "pass",
        message: "Privacy Policy page exists",
        value: privacyPage,
      });
    } else {
      // pub#672: a policy the pages link to but the crawl never fetched (an
      // excluded `/policies/**`, or past the page budget) is unverified, not
      // missing. Same link acceptance as legal/privacy-policy: slug, then text.
      const linked = ctx.site
        ? findLinkedUncrawledPage(ctx.site, {
            href: (url) => matchesConfiguredPaths(url, paths) || isPrivacyPath(url),
            text: isPrivacyLinkText,
          })
        : null;
      const probed = probedConfiguredPages(ctx.site, paths);
      const probedFound = probed.find((p) => p.outcome === "found");
      if (probedFound) {
        // #1428: the crawl did not reach it, the probe did.
        checks.push({
          name: "privacy-policy",
          status: "pass",
          message: `Privacy Policy page exists (found by probing ${probedFound.path}, not reached by the crawl)`,
          value: probedFound.url,
          details: { probed: true, path: probedFound.path, status: probedFound.status },
        });
      } else if (!linked) {
        checks.push({
          name: "privacy-policy",
          status: "warn",
          message: probed.length > 0 ? `No Privacy Policy page found ${probedNote(probed)}` : "No Privacy Policy page found",
          value: "Create /privacy-policy page",
          ...(probed.length > 0 ? { details: { probed: true, paths: probed.map((p) => p.path) } } : {}),
        });
        return { checks };
      } else {
        checks.push(linkedUncrawledCheck("privacy-policy", "Privacy Policy", linked));
        // Coverage below counts href-slug links only, so it cannot measure a
        // policy recognised by its anchor text alone.
        if (linked.matchedBy === "text") return { checks };
      }
    }

    // Check how many pages link to it (href-slug only — the original metric, not
    // widened by anchor-text matching which belongs to the legal rule).
    for (const page of pages) {
      if (pageLinksToPrivacyHref(page, paths)) linkedFromPages++;
    }

    const linkPercentage = Math.round((linkedFromPages / pages.length) * 100);

    if (linkPercentage >= 80) {
      checks.push({
        name: "privacy-linked",
        status: "pass",
        message: `Privacy policy linked from ${linkPercentage}% of pages`,
      });
    } else if (linkPercentage >= 50) {
      checks.push({
        name: "privacy-linked",
        status: "info",
        message: `Privacy policy linked from ${linkPercentage}% of pages`,
        value: "Consider adding to all page footers",
      });
    } else {
      checks.push({
        name: "privacy-linked",
        status: "warn",
        message: `Privacy policy only linked from ${linkPercentage}% of pages`,
        value: "Add privacy link to footer on all pages",
      });
    }

    return { checks };
  },
};
