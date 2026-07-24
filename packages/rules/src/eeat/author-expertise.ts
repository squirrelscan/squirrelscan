// eeat/author-expertise - Author credentials and expertise signals

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

export const authorExpertiseRule: Rule = {
  meta: {
    id: "eeat/author-expertise",
    name: "Author Expertise",
    description: "Checks for author credentials and expertise indicators",
    solution:
      "Author expertise is key for E-E-A-T, especially for YMYL content. Include: professional credentials (MD, JD, CPA), work experience, education, relevant certifications, and author bio pages. Link authors to LinkedIn or professional profiles. For health content, show medical reviewer credentials.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 4,
    // Author credentials matter for editorial / YMYL content sites; irrelevant to
    // SaaS marketing / ecommerce / landing pages. Gate to content-publishing
    // types. Offline / no-metadata / low-confidence runs as today.
    appliesWhen: { siteTypes: ["blog", "news", "healthcare_provider", "education", "nonprofit"] },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "author-expertise",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for author pages
    const authorPatterns = [
      /\/author\//i,
      /\/authors\/?$/i,
      /\/team\/?$/i,
      /\/contributors\/?$/i,
      /\/about-the-author/i,
    ];

    let authorPages = 0;

    for (const page of pages) {
      const path = getPathname(page.url);
      if (authorPatterns.some((p) => p.test(path))) {
        authorPages++;
      }
    }

    // Check for Person schema
    let hasPersonSchema = false;
    for (const page of pages) {
      if (page.parsed.schema.types.includes("Person")) {
        hasPersonSchema = true;
        break;
      }
    }

    const expertiseSignals: string[] = [];

    if (authorPages > 0) {
      expertiseSignals.push(`${authorPages} author page(s)`);
    }

    if (hasPersonSchema) {
      expertiseSignals.push("Person schema");
    }

    if (expertiseSignals.length > 0) {
      checks.push({
        name: "author-expertise",
        status: "pass",
        message: `Author expertise signals found`,
        items: expertiseSignals.map((signal) => ({ id: signal })),
      });
    } else {
      checks.push({
        name: "author-expertise",
        status: "info",
        message: "Limited author expertise signals",
        value: "Consider adding author pages with credentials",
      });
    }

    return { checks };
  },
};
