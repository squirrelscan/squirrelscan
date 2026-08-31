// crawl/canonical-chain - Canonical redirect chain detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { formatRedirectHop } from "@squirrelscan/core-contracts";

import { didRedirect, requestTarget } from "../shared/redirect-evidence";

export const canonicalChainRule: Rule = {
  meta: {
    id: "crawl/canonical-chain",
    name: "Canonical Chain",
    description: "Checks for redirect chains on canonical URLs",
    solution:
      "Canonical URLs should point directly to the final destination, not through redirects. Redirect chains waste crawl budget and dilute link equity. If your canonical URL redirects, update it to point to the final URL. Check that canonical URLs use the preferred protocol (https) and www/non-www version. Self-referencing canonicals should match the page URL exactly.",
    category: "crawl",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const pageUrl = ctx.page.url;
    const finalUrl = ctx.page.finalUrl ?? pageUrl;
    const redirectChain = ctx.page.redirectChain;

    // If the page itself redirected, surface the chain context. A chain exists
    // whenever a fetcher recorded hops; it is evidence of a redirect only when
    // we watched one happen or the request landed on a different resource.
    if (redirectChain && didRedirect(pageUrl, finalUrl, redirectChain)) {
      const chainLabel =
        redirectChain.hops.length > 1
          ? redirectChain.hops.map((hop) => formatRedirectHop(hop)).join(" → ")
          : `${pageUrl} → ${finalUrl}`;

      checks.push({
        name: "page-redirect-chain",
        status: "warn",
        message: "Page redirects before content is served",
        items: [
          {
            id: pageUrl,
            label: chainLabel,
            meta: { finalUrl: redirectChain.finalUrl, chain: redirectChain },
          },
        ],
      });
    }

    const canonical = doc.querySelector('link[rel="canonical"]');
    const canonicalUrl = canonical?.getAttribute("href");

    if (!canonicalUrl) {
      checks.push({
        name: "canonical-chain",
        status: "skipped",
        message: "No canonical tag found",
      });
      return { checks };
    }

    // Resolve relative canonical to absolute
    let absoluteCanonical: string;
    try {
      absoluteCanonical = new URL(canonicalUrl, ctx.page.url).href;
    } catch {
      checks.push({
        name: "canonical-chain",
        status: "warn",
        message: "Invalid canonical URL",
        value: canonicalUrl,
      });
      return { checks };
    }

    const pageUrlObj = new URL(ctx.page.url);
    const canonicalParsed = new URL(absoluteCanonical);

    // Check protocol mismatch
    if (
      pageUrlObj.protocol === "https:" &&
      canonicalParsed.protocol === "http:"
    ) {
      checks.push({
        name: "canonical-protocol",
        status: "warn",
        message: "Canonical points to HTTP instead of HTTPS",
        value: absoluteCanonical,
      });
    }

    // Check for common chain indicators
    // (In a full implementation, you'd actually fetch and check redirects)
    const suspiciousPatterns = [
      /\/\?.*redirect/i,
      /\/go\//,
      /\/out\//,
      /\/link\//,
      /\/r\//,
    ];

    const hasSuspiciousPattern = suspiciousPatterns.some((pattern) =>
      pattern.test(absoluteCanonical)
    );

    if (hasSuspiciousPattern) {
      checks.push({
        name: "canonical-chain",
        status: "warn",
        message: "Canonical URL may be a redirect",
        value: absoluteCanonical,
      });
    } else {
      checks.push({
        name: "canonical-chain",
        status: "pass",
        message: "Canonical URL appears direct",
      });
    }

    // Check self-referencing canonical matches exactly
    if (absoluteCanonical !== ctx.page.url) {
      // Normalize for comparison (remove trailing slash difference)
      const normalizedPage = ctx.page.url.replace(/\/$/, "");
      const normalizedCanonical = absoluteCanonical.replace(/\/$/, "");

      if (normalizedPage !== normalizedCanonical) {
        // It's a cross-page canonical - this is intentional
        checks.push({
          name: "canonical-target",
          status: "info",
          message: "Page canonicalizes to different URL",
          value: absoluteCanonical,
        });
      }
    }

    // If the canonical names the very URL we watched redirect, flag it. Identity
    // is the request target, not a normalized form: `/page`, `/page/` and
    // `/page?x=1` are different requests, and only the one we actually fetched
    // is the one whose chain we hold. Folding them together hands this page's
    // chain to a canonical that never redirected (#1510).
    const canonicalTarget = requestTarget(absoluteCanonical);
    if (
      canonicalTarget === requestTarget(pageUrl) &&
      requestTarget(finalUrl) !== canonicalTarget &&
      redirectChain &&
      didRedirect(pageUrl, finalUrl, redirectChain)
    ) {
      checks.push({
        name: "canonical-redirects",
        status: "warn",
        message: "Canonical URL resolves through a redirect chain",
        items: [
          {
            id: absoluteCanonical,
            label: redirectChain.hops.map((hop) => formatRedirectHop(hop)).join(" → "),
            meta: { chain: redirectChain, finalUrl },
          },
        ],
      });
    }

    return { checks };
  },
};
