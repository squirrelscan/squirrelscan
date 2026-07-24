// perf/font-loading - Font loading optimization

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

function hasHostname(rawUrl: string, baseUrl: string, hostnames: readonly string[]): boolean {
  try {
    return hostnames.includes(new URL(rawUrl, baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const fontLoadingRule: Rule = {
  meta: {
    id: "perf/font-loading",
    name: "Font Loading",
    description: "Checks for font loading best practices",
    solution:
      "Optimize font loading to prevent FOIT (Flash of Invisible Text) and FOUT (Flash of Unstyled Text): 1) Use font-display: swap in @font-face to show fallback text immediately. 2) Preconnect to font CDNs with <link rel='preconnect'>. 3) Use WOFF2 format for best compression. 4) Self-host fonts when possible for faster loading. 5) Limit font families and weights to reduce downloads.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check fonts without font-display
    if (hints.fontsWithoutSwap.length > 0) {
      checks.push({
        name: "font-display",
        status: "warn",
        message: `${hints.fontsWithoutSwap.length} font(s) without font-display: swap`,
        items: hints.fontsWithoutSwap.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "font-display",
        status: "pass",
        message: "All fonts have font-display set",
      });
    }

    // Check for Google Fonts preconnect
    const hasGoogleFontsPreconnect = hints.preconnectTags.some((url) =>
      hasHostname(url, ctx.page.url, ["fonts.googleapis.com", "fonts.gstatic.com"]),
    );
    const usesGoogleFonts = Array.from(
      ctx.parsed.document?.querySelectorAll("link[href]") ?? [],
    ).some((link) =>
      hasHostname(link.getAttribute("href") ?? "", ctx.page.url, ["fonts.googleapis.com"]),
    );

    if (usesGoogleFonts && !hasGoogleFontsPreconnect) {
      checks.push({
        name: "font-preconnect",
        status: "warn",
        message: "Using Google Fonts without preconnect",
        value: "Add <link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>",
      });
    } else if (usesGoogleFonts) {
      checks.push({
        name: "font-preconnect",
        status: "pass",
        message: "Google Fonts preconnect configured",
      });
    }

    return { checks };
  },
};
