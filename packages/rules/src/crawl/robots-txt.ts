// crawl/robots-txt - robots.txt validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { describeRefusedFetch } from "@squirrelscan/core-contracts";

import { refusalReason, refusedFor } from "../refused";

const SEARCH_CRAWL_DELAY_AGENTS = new Set(["*", "bingbot", "msnbot", "yandex", "googlebot"]);

function formatInteger(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function crawlDelayCheck(userAgent: string, delay: number): CheckResult | null {
  const normalizedAgent = userAgent.toLowerCase();
  if (!SEARCH_CRAWL_DELAY_AGENTS.has(normalizedAgent) || !Number.isFinite(delay) || delay <= 0) {
    return null;
  }

  const slowBing = delay >= 10 && (normalizedAgent === "*" || normalizedAgent === "bingbot");
  if (slowBing) {
    const dailyCap = Math.floor(86_400 / delay);
    return {
      name: "robots-txt-crawl-delay",
      status: "warn",
      message: `Crawl-delay ${delay}s slows Bing crawling for User-agent: ${userAgent}`,
      value: `Google ignores Crawl-delay; Bing obeys it and may fetch at most about ${formatInteger(dailyCap)} URLs/day`,
      items: [{ id: userAgent, label: `User-agent: ${userAgent}; Crawl-delay: ${delay}` }],
    };
  }

  let behavior = "This search crawler may honor the directive";
  if (normalizedAgent === "*") {
    behavior = "Google ignores Crawl-delay; Bing and Yandex obey it";
  } else if (normalizedAgent === "googlebot") {
    behavior = "Google ignores this directive";
  } else if (normalizedAgent === "bingbot" || normalizedAgent === "msnbot") {
    behavior = "Bing obeys this directive";
  } else if (normalizedAgent === "yandex") {
    behavior = "Yandex obeys this directive";
  }

  return {
    name: "robots-txt-crawl-delay",
    status: "info",
    message: `Crawl-delay ${delay}s applies to User-agent: ${userAgent}`,
    value: behavior,
    items: [{ id: userAgent, label: `User-agent: ${userAgent}; Crawl-delay: ${delay}` }],
  };
}

export const robotsTxtRule: Rule = {
  meta: {
    id: "crawl/robots-txt",
    name: "Robots.txt",
    description: "Checks if robots.txt exists and is properly configured, including crawl delays",
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

    // Check existence. `exists: false` with a recorded error means the probe
    // never got an answer — a timeout, a 5xx, or a fetch the crawl budget cut
    // short. Absence was not established, so this reports what is unknown
    // instead of a definite missing-file finding (squirrelscan/repo#1733).
    if (!robotsTxt.exists && robotsTxt.errors.length > 0) {
      // A refusal is the one no-answer cause worth naming: it is the site, not
      // the network, that withheld the file.
      const refused = refusedFor(ctx.site, "robots.txt");
      if (refused.length > 0) {
        checks.push({
          name: "robots-txt-exists",
          status: "info",
          message: "robots.txt could not be checked",
          value: `The site refused the request (${refusalReason(refused)}), so this is unknown, not missing`,
          details: { refused: refused.map(describeRefusedFetch) },
        });
        return { checks };
      }
      checks.push({
        name: "robots-txt-exists",
        status: "info",
        message: "robots.txt could not be checked",
        // Deliberately not the raw reason: for a skipped probe that string is
        // an internal marker ("crawl phase budget exhausted"), which is not
        // something to show a reader. Report the consequence instead.
        value: "The request did not complete, so this is unknown, not missing",
      });
      return { checks };
    }

    if (!robotsTxt.exists) {
      checks.push({
        name: "robots-txt-exists",
        status: "fail",
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

    for (const group of robotsTxt.rules) {
      if (group.crawlDelay === undefined) continue;
      const check = crawlDelayCheck(group.userAgent, group.crawlDelay);
      if (check) checks.push(check);
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
