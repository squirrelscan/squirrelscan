// links/redirect-chains - Redirect detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RedirectChain } from "@squirrelscan/core-contracts";

/**
 * Identity of the resource a URL names, for deciding whether a request LANDED
 * somewhere else and for joining links to redirect targets.
 *
 * This is `@squirrelscan/utils`' `normalizeUrl` with the trailing slash KEPT.
 * `/about` and `/about/` are different request targets, and telling them apart
 * is the entire point of this rule: folding them together both hides a genuine
 * `/about → /about/` move and lets a page that links the canonical form get
 * blamed for the other form's redirect (#1510).
 */
function targetKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * A NON-final hop we watched actually redirect: an HTTP hop carrying a 3xx, or
 * any client-side hop at all — a `javascript` / `meta-refresh` hop IS the
 * redirect, whatever status the document that performed it returned.
 */
function hasObservedRedirect(chain: RedirectChain | undefined): boolean {
  if (!chain || chain.hops.length < 2) return false;
  return chain.hops
    .slice(0, -1)
    .some((hop) => hop.type !== "http" || (hop.statusCode >= 300 && hop.statusCode < 400));
}

/**
 * True when the chain contradicts itself: an HTTP hop it says was followed by
 * another hop reports a 2xx, and an HTTP response that returned 200 did not
 * redirect.
 *
 * Such a chain was assembled from a source URL and a landing URL by something
 * that never watched the responses in between, and it is what made every
 * trailing-slash-canonical site report its own pages as redirecting,
 * `(200) → (200)`, blaming every page that linked them (#1510). The producers
 * are fixed to record an unobserved hop as `0` rather than borrowing the landing
 * status; this is the rule refusing to accuse on that shape even if one regresses.
 *
 * Client-side hops are exempt: a `javascript` / `meta-refresh` redirect is by
 * definition a document that returned 200 and then sent the visitor elsewhere,
 * so a 2xx there is the truth, not a borrowed status.
 */
function contradictsItself(chain: RedirectChain | undefined): boolean {
  if (!chain || chain.hops.length < 2) return false;
  return chain.hops
    .slice(0, -1)
    .some((hop) => hop.type === "http" && hop.statusCode >= 200 && hop.statusCode < 300);
}

/** `url (301)`, or bare `url` when no status was observed for that hop. */
function formatHop(hop: { url: string; statusCode: number }): string {
  return hop.statusCode > 0 ? `${hop.url} (${hop.statusCode})` : hop.url;
}

export const redirectChainsRule: Rule = {
  meta: {
    id: "links/redirect-chains",
    name: "Redirect Chains",
    description: "Detects URLs that redirect and links pointing to redirects",
    solution:
      "Redirects add latency and waste crawl budget, especially when chained. Make sure every internal link hits the final destination directly, not the intermediate redirect, and consult the chain context emitted by this rule to trace multi-hop paths. Consolidate redirect rules, prefer 301s for permanent moves, and audit redirects regularly to remove legacy hops.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "redirect-chains",
        status: "skipped",
        message: "No pages available for redirect analysis",
      });
      return { checks };
    }

    const redirectTargets = new Map<
      string,
      {
        originalUrl: string;
        finalUrl: string;
        chainLabel: string;
        chain?: RedirectChain;
      }
    >();

    for (const page of pages) {
      if (!page.finalUrl) continue;

      const chain = page.redirectChain;
      const original = targetKey(page.url);
      const final = targetKey(page.finalUrl);

      // Two independent kinds of evidence: the request landed on a different
      // resource, or we watched a hop return a 3xx. Either is a redirect — the
      // first covers the render path, which reports the landing page but never
      // the statuses that led to it. A self-contradicting chain is neither.
      const redirected = original !== final || hasObservedRedirect(chain);

      if (redirected && !contradictsItself(chain)) {
        const chainLabel =
          chain && chain.hops.length > 1
            ? chain.hops.map(formatHop).join(" → ")
            : `${page.url} → ${page.finalUrl}`;
        redirectTargets.set(original, {
          originalUrl: page.url,
          finalUrl: page.finalUrl,
          chainLabel,
          chain,
        });
      }
    }

    if (redirectTargets.size > 0) {
      checks.push({
        name: "redirect-pages",
        status: "warn",
        message: `${redirectTargets.size} page(s) redirect to another URL`,
        items: [...redirectTargets.values()].map((target) => ({
          id: target.originalUrl,
          label: target.chainLabel,
          meta: {
            targetUrl: target.finalUrl,
            chain: target.chain,
          },
        })),
        details: { total: redirectTargets.size },
      });
    }

    const linksToRedirect = new Map<string, Set<string>>();

    if (redirectTargets.size > 0) {
      for (const page of pages) {
        const links = page.parsed?.links ?? [];
        for (const link of links) {
          if (!link.isInternal || !link.url) continue;
          try {
            // Slash-sensitive join: a page that links `/about/` must not be
            // blamed for `/about`'s redirect. They are different hrefs and only
            // one of them is the mistake being reported.
            const target = targetKey(new URL(link.url, page.url).href);
            if (redirectTargets.has(target)) {
              const sources = linksToRedirect.get(target) ?? new Set();
              sources.add(page.url);
              linksToRedirect.set(target, sources);
            }
          } catch {
            continue;
          }
        }
      }
    }

    if (linksToRedirect.size > 0) {
      checks.push({
        name: "links-to-redirect",
        status: "warn",
        message: `${linksToRedirect.size} link target(s) point to redirecting URLs`,
        items: [...linksToRedirect.entries()].map(([target, sources]) => {
          const redirect = redirectTargets.get(target);
          const label = redirect ? redirect.chainLabel : target;
          return {
            id: redirect?.originalUrl ?? target,
            label,
            sourcePages: [...sources],
            meta: {
              targetUrl: redirect?.finalUrl ?? target,
              chain: redirect?.chain,
            },
          };
        }),
        details: { total: linksToRedirect.size },
      });
    }

    if (checks.length === 0) {
      checks.push({
        name: "redirect-chains",
        status: "pass",
        message: "No redirects detected",
      });
    }

    return { checks };
  },
};
