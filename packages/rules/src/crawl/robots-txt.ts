// crawl/robots-txt - robots.txt validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";
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

/**
 * The search crawlers whose being let in makes "robots.txt blocks all crawling" untrue enough to downgrade (#1783):
 * the ones that decide whether a site is found. A named re-allow of an AI crawler or a niche bot (a
 * `User-agent: GPTBot` / `Allow: /` beside the wildcard block) leaves Google and Bing out, so the site is still
 * effectively blocked and the finding stays a failure.
 */
export const MAJOR_SEARCH_CRAWLERS: readonly string[] = [
  "Googlebot",
  "Bingbot",
  "DuckDuckBot",
  "YandexBot",
  "Applebot",
];

/**
 * Two paths no real rule names, probed beside the root (#1783): a rule that blocks only the homepage
 * (`Disallow: /$`) or re-permits only the homepage (`Allow: /$`) says nothing about the rest of the site, and the
 * matcher asked about "/" alone cannot tell the difference. A pattern that blocks the whole site (`/`, `/*`) blocks
 * both paths. Two, with unlike first characters, so a real prefix rule (`Disallow: /s`) cannot take both: it would
 * have to be a rule for the whole site to match `/~` and `/z` alike.
 */
const ROBOTS_PROBE_PATHS = ["/~sq-probe-0/x", "/zz-sq-probe-1/y"] as const;

function rootAndProbes(robotsTxt: RobotsTxtData): { root: string; probes: string[] } {
  try {
    return {
      root: new URL("/", robotsTxt.url).toString(),
      probes: ROBOTS_PROBE_PATHS.map((p) => new URL(p, robotsTxt.url).toString()),
    };
  } catch {
    // an unparseable robots.txt URL: nothing can be judged by the matcher
    return { root: "/", probes: ["/", "/"] };
  }
}

/** The distinct named user-agent tokens of the file, as written (the wildcard excluded). */
function namedTokens(groups: RobotsTxtData["rules"]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    const key = g.userAgent.toLowerCase();
    if (g.userAgent === "*" || seen.has(key)) continue;
    seen.add(key);
    out.push(g.userAgent);
  }
  return out;
}

/**
 * What a `User-agent: *` / `Disallow: /` still lets in because a group of its own re-allows it (#1783), decided with
 * the matcher the crawl uses (longest match, `Allow` wins a tie, stacked agents), so `Disallow: /*` blocks the root
 * and `Allow: /$` re-allows it. `major` are the {@link MAJOR_SEARCH_CRAWLERS} let in (matched by their own group:
 * with none the wildcard governs them and they are blocked); `other` is every other named token let in.
 */
function crawlersAllowedByName(robotsTxt: RobotsTxtData): { major: string[]; other: string[] } {
  const { probes } = rootAndProbes(robotsTxt);
  // "Let in" means let in beyond the homepage: the DEEP probes are judged, not the root, so a group that only
  // re-permits the homepage (`Disallow: /` with `Allow: /$`) is not a re-allow of the site.
  // Let in when either deep path is: a group that blocks both is blocking the site.
  const allowed = (token: string) => probes.some((p) => !isRobotsTxtDisallowed(p, robotsTxt, token));
  const named = namedTokens(robotsTxt.rules);
  const lower = new Set(named.map((t) => t.toLowerCase()));
  const major = MAJOR_SEARCH_CRAWLERS.filter((t) => lower.has(t.toLowerCase()) && allowed(t));
  const majorLower = new Set(MAJOR_SEARCH_CRAWLERS.map((t) => t.toLowerCase()));
  const other = named.filter((t) => !majorLower.has(t.toLowerCase()) && allowed(t));
  return { major, other };
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
    // A site moves between "every crawler is blocked" and "blocked except the ones a named group re-allows" when
    // such a group is added or removed (#1783). The two checks are peers: a finding tracked under one continues
    // under the other and is not reported fixed. The empty locator is the whole-check finding's.
    // The rule stays on the undeclared-`checks` baseline (#1741): its checks mix unrelated outcomes (exists, syntax,
    // crawl delay, sitemap, the disallow pair), and declaring them is the migration's job, not this change's. The
    // tracking key that moves is covered by the peers below.
    supersededChecks: {
      "robots-txt-disallow": ["robots-txt-disallow-wildcard@"],
      "robots-txt-disallow-wildcard": ["robots-txt-disallow@"],
    },
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

    // Check for full disallow: a literal `Disallow: /` under `*`, or a pattern that blocks the whole site the way
    // the crawl matches it (`Disallow: /*`, #1783). Whole site means the root AND a deep path no rule names: a
    // homepage-only rule (`Disallow: /$`) is not "blocks all crawling".
    const { root: rootUrl, probes } = rootAndProbes(robotsTxt);
    const hasFullDisallow =
      robotsTxt.rules.some(
        (rule) =>
          rule.userAgent === "*" &&
          rule.rules.some((r) => r.type === "disallow" && r.path === "/")
      ) ||
      (isRobotsTxtDisallowed(rootUrl, robotsTxt, "*") &&
        probes.every((p) => isRobotsTxtDisallowed(p, robotsTxt, "*")));

    if (hasFullDisallow) {
      // Check if there are allow rules that might permit some crawling
      const hasAllowRules = robotsTxt.rules.some(
        (rule) =>
          rule.userAgent === "*" && rule.rules.some((r) => r.type === "allow")
      );

      if (!hasAllowRules) {
        // A named group can re-allow a crawler the wildcard blocks (#1783). Only when a MAJOR search crawler is
        // let in is "blocks all crawling" untrue enough to downgrade: a GPTBot-only re-allow leaves Google and
        // Bing out, so the site is still effectively blocked and the finding stays a failure.
        const { major, other } = crawlersAllowedByName(robotsTxt);
        if (major.length > 0) {
          checks.push({
            name: "robots-txt-disallow",
            status: "pass",
            message: "robots.txt does not block every crawler",
          });
          checks.push({
            name: "robots-txt-disallow-wildcard",
            status: "warn",
            message: `robots.txt blocks every crawler without a group of its own (User-agent: * with Disallow: /); still allowed by name: ${major.join(", ")}`,
            value: "Disallow: / under User-agent: *, re-allowed for named crawlers",
            details: { allowed: major, ...(other.length > 0 ? { otherAllowed: other } : {}) },
          });
        } else {
          checks.push({
            name: "robots-txt-disallow",
            status: "fail",
            message: "robots.txt blocks all crawling",
            value: "Disallow: / with no Allow rules",
            // Crawlers a group of their own lets in that are not a major search engine (an AI crawler, say).
            ...(other.length > 0 ? { details: { allowedByName: other } } : {}),
          });
        }
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
