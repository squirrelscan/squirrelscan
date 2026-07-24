// crawl/robots-txt - robots.txt validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const robotsTxtRule: Rule = {
  meta: {
    id: "crawl/robots-txt",
    name: "Robots.txt",
    description: "Checks if robots.txt exists and is properly configured",
    solution:
      "robots.txt tells search engines which pages to crawl. Place it at the root of your domain (example.com/robots.txt). Include your sitemap URL. Avoid blocking important resources (CSS, JS, images) that search engines need to render pages. Never use 'Disallow: /' unless you want to block all crawling. Use Google Search Console to test your robots.txt.",
    category: "crawl",
    scope: "site",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const robotsTxt = ctx.site?.robotsTxt;

    if (!robotsTxt) {
      checks.push({
        name: "robots-txt-exists",
        status: "info",
        message: "robots.txt data not available",
      });
      return { checks };
    }

    // Check existence
    if (!robotsTxt.exists) {
      checks.push({
        name: "robots-txt-exists",
        status: "warn",
        message: "No robots.txt found",
        value: "Search engines will crawl all accessible pages",
      });
      return { checks };
    }

    checks.push({
      name: "robots-txt-exists",
      status: "pass",
      message: "robots.txt exists",
      value: robotsTxt.url,
    });

    // Check for syntax errors
    if (robotsTxt.errors.length > 0) {
      checks.push({
        name: "robots-txt-syntax",
        status: "warn",
        message: `${robotsTxt.errors.length} syntax error(s) in robots.txt`,
        items: robotsTxt.errors.map((err) => ({ id: err })),
      });
    } else {
      checks.push({
        name: "robots-txt-syntax",
        status: "pass",
        message: "robots.txt syntax is valid",
      });
    }

    // Check for full disallow
    const hasFullDisallow = robotsTxt.rules.some(
      (rule) =>
        rule.userAgent === "*" &&
        rule.rules.some((r) => r.type === "disallow" && r.path === "/")
    );

    if (hasFullDisallow) {
      // Check if there are allow rules that might permit some crawling
      const hasAllowRules = robotsTxt.rules.some(
        (rule) =>
          rule.userAgent === "*" && rule.rules.some((r) => r.type === "allow")
      );

      if (!hasAllowRules) {
        checks.push({
          name: "robots-txt-disallow",
          status: "fail",
          message: "robots.txt blocks all crawling",
          value: "Disallow: / with no Allow rules",
        });
      } else {
        checks.push({
          name: "robots-txt-disallow",
          status: "info",
          message: "robots.txt has Disallow: / with Allow exceptions",
        });
      }
    } else {
      checks.push({
        name: "robots-txt-disallow",
        status: "pass",
        message: "robots.txt does not block all crawling",
      });
    }

    // Check if sitemap is referenced
    if (robotsTxt.sitemaps.length > 0) {
      checks.push({
        name: "robots-txt-sitemap",
        status: "pass",
        message: `Sitemap referenced in robots.txt`,
        items: robotsTxt.sitemaps.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "robots-txt-sitemap",
        status: "info",
        message: "No sitemap referenced in robots.txt",
        value: "Add: Sitemap: https://example.com/sitemap.xml",
      });
    }

    // Check file size (shouldn't be too large)
    if (robotsTxt.sizeBytes > 500 * 1024) {
      checks.push({
        name: "robots-txt-size",
        status: "warn",
        message: "robots.txt is very large",
        value: `${Math.round(robotsTxt.sizeBytes / 1024)}KB (Google limit: 500KB)`,
      });
    }

    return { checks };
  },
};
