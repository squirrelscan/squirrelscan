// analytics/gtm-present - Google Tag Manager / analytics check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const gtmPresentRule: Rule = {
  meta: {
    id: "analytics/gtm-present",
    name: "Analytics Tracking",
    description: "Checks for Google Tag Manager or analytics implementation",
    solution:
      "Analytics tracking helps understand user behavior and measure SEO success. Use Google Tag Manager (GTM) to manage all tags centrally. GTM should be in the <head> with a noscript fallback in <body>. Alternatives: Google Analytics 4 directly, Plausible, Fathom, or Matomo. Ensure tracking complies with privacy laws.",
    category: "analytics",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const html = ctx.page.html;

    const analyticsFound: string[] = [];

    // Check for Google Tag Manager
    if (html.includes("googletagmanager.com") || html.includes("gtm.js")) {
      analyticsFound.push("GTM");
    }

    // Check for Google Analytics 4
    if (
      html.includes("gtag/js") ||
      html.includes("googletagmanager.com/gtag")
    ) {
      analyticsFound.push("GA4");
    }

    // Check for legacy Universal Analytics
    if (html.includes("analytics.js") || html.includes("ga.js")) {
      analyticsFound.push("UA (legacy)");
    }

    // Check for alternative analytics
    const scripts = doc.querySelectorAll("script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src") || "";
      if (src.includes("plausible")) analyticsFound.push("Plausible");
      if (src.includes("fathom")) analyticsFound.push("Fathom");
      if (src.includes("matomo") || src.includes("piwik"))
        analyticsFound.push("Matomo");
      if (src.includes("segment")) analyticsFound.push("Segment");
      if (src.includes("mixpanel")) analyticsFound.push("Mixpanel");
      if (src.includes("amplitude")) analyticsFound.push("Amplitude");
      if (src.includes("heap")) analyticsFound.push("Heap");
      if (src.includes("hotjar")) analyticsFound.push("Hotjar");
      if (src.includes("clarity.ms")) analyticsFound.push("MS Clarity");
    }

    // Deduplicate
    const uniqueAnalytics = [...new Set(analyticsFound)];

    if (uniqueAnalytics.length > 0) {
      checks.push({
        name: "gtm-present",
        status: "pass",
        message: `${uniqueAnalytics.length} analytics platform(s) detected`,
        items: uniqueAnalytics.map((analytics) => ({ id: analytics })),
      });
    } else {
      checks.push({
        name: "gtm-present",
        status: "info",
        message: "No analytics tracking detected",
        value: "Consider adding analytics to measure performance",
      });
    }

    return { checks };
  },
};
