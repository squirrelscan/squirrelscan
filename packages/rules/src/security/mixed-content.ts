// security/mixed-content - HTTPS page loading HTTP resources

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const mixedContentRule: Rule = {
  meta: {
    id: "security/mixed-content",
    name: "Mixed Content",
    description: "Checks for HTTP resources on HTTPS pages",
    solution:
      "Mixed content occurs when an HTTPS page loads resources over HTTP, breaking the security chain. Browsers may block these resources. Update all resource URLs to use HTTPS or protocol-relative URLs (//example.com). Check images, scripts, stylesheets, fonts, and iframes. Use Content-Security-Policy: upgrade-insecure-requests to automatically upgrade HTTP to HTTPS.",
    category: "security",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const isHttps = ctx.page.url.startsWith("https://");

    if (!isHttps) {
      checks.push({
        name: "mixed-content",
        status: "info",
        message: "Mixed content check not applicable - page not HTTPS",
      });
      return { checks };
    }

    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const mixedContentUrls: string[] = [];

    // Check various resource types
    const selectors = [
      "img[src^='http://']",
      "script[src^='http://']",
      "link[href^='http://']",
      "iframe[src^='http://']",
      "video[src^='http://']",
      "audio[src^='http://']",
      "source[src^='http://']",
      "embed[src^='http://']",
      "object[data^='http://']",
    ];

    for (const selector of selectors) {
      const elements = doc.querySelectorAll(selector);
      for (const el of elements) {
        const url =
          el.getAttribute("src") ||
          el.getAttribute("href") ||
          el.getAttribute("data");
        if (url) {
          mixedContentUrls.push(url);
        }
      }
    }

    if (mixedContentUrls.length > 0) {
      checks.push({
        name: "mixed-content",
        status: "fail",
        message: `${mixedContentUrls.length} HTTP resource(s) on HTTPS page`,
        items: mixedContentUrls.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "mixed-content",
        status: "pass",
        message: "No mixed content detected",
      });
    }

    return { checks };
  },
};
