// local/service-area - Service area page detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

export const serviceAreaRule: Rule = {
  meta: {
    id: "local/service-area",
    name: "Service Area Pages",
    description: "Checks for service area/location pages",
    solution:
      "Service area pages help rank for '[service] in [location]' searches. Create pages for each major city/area you serve. Include location-specific content, testimonials, and case studies. Use unique content - don't just swap city names. Add LocalBusiness schema with areaServed property.",
    category: "local",
    scope: "site",
    severity: "info",
    weight: 3,
    // Service-area pages only matter for real-world local businesses. Skip with a
    // visible reason for global SaaS / blogs. Offline / no-metadata runs as today.
    appliesWhen: { requiresLocalBusiness: true },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "service-area",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for service area/location pages
    const locationPatterns = [
      /\/locations?\/?$/i,
      /\/service-areas?\/?$/i,
      /\/areas?-served\/?$/i,
      /\/cities\/?$/i,
      /\/neighborhoods?\/?$/i,
    ];

    const locationPages: string[] = [];

    for (const page of pages) {
      const path = getPathname(page.url);
      if (locationPatterns.some((p) => p.test(path))) {
        locationPages.push(path);
      }
    }

    if (locationPages.length > 0) {
      checks.push({
        name: "service-area",
        status: "pass",
        message: `${locationPages.length} location/service area page(s) found`,
        items: locationPages.map((path) => ({ id: path })),
      });
    } else {
      checks.push({
        name: "service-area",
        status: "info",
        message: "No dedicated location pages found",
        value: "Consider adding for multi-location businesses",
      });
    }

    return { checks };
  },
};
