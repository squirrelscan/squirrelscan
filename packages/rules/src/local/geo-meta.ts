// local/geo-meta - Geographic meta tags

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const geoMetaRule: Rule = {
  meta: {
    id: "local/geo-meta",
    name: "Geo Meta Tags",
    description: "Checks for geographic meta tags for local targeting",
    solution:
      "Geo meta tags help indicate your business location for local search. Add: geo.region (country-state code), geo.placename (city name), geo.position (latitude;longitude), and ICBM meta tag. These supplement LocalBusiness schema. Most useful for location-specific landing pages.",
    category: "local",
    scope: "page",
    severity: "info",
    weight: 2,
    // Geo meta tags only help real-world local businesses. Skip with a visible
    // reason for global SaaS / blogs. Offline / no-metadata runs as today.
    appliesWhen: { requiresLocalBusiness: true },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check for geo meta tags
    const geoRegion = doc.querySelector('meta[name="geo.region"]');
    const geoPlacename = doc.querySelector('meta[name="geo.placename"]');
    const geoPosition = doc.querySelector('meta[name="geo.position"]');
    const icbm = doc.querySelector('meta[name="ICBM"]');

    const geoTags: string[] = [];

    if (geoRegion) geoTags.push("geo.region");
    if (geoPlacename) geoTags.push("geo.placename");
    if (geoPosition) geoTags.push("geo.position");
    if (icbm) geoTags.push("ICBM");

    if (geoTags.length > 0) {
      checks.push({
        name: "geo-meta",
        status: "pass",
        message: `${geoTags.length} geo meta tag(s) found`,
        items: geoTags.map((tag) => ({ id: tag })),
      });
    } else {
      checks.push({
        name: "geo-meta",
        status: "info",
        message: "No geo meta tags found",
        value: "Consider adding for local businesses",
      });
    }

    return { checks };
  },
};
