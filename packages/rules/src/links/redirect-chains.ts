// links/redirect-chains - Redirect detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RedirectChain } from "@squirrelscan/core-contracts";

import { normalizeUrl } from "@squirrelscan/utils";

/**
 * True when the chain contains a hop that actually redirected: a NON-final hop
 * carrying a 3xx status.
 *
 * `chainLength > 0` is not that evidence. A chain whose hops are all 2xx is not
 * a redirect — it is a chain some fetcher assembled from a source URL and a
 * landing URL without observing the responses in between (#1510). Treating it
 * as a redirect made every trailing-slash-canonical site report its own pages as
 * redirecting, `(200) → (200)`, and blamed every page that linked them.
 *
 * The URL-actually-changed test in the caller is the other trigger, and it still
 * catches a redirect whose hop statuses were never observed — as long as the
 * destination differs by more than a trailing slash, since `normalizeUrl` folds
 * that away. A slash-only move with no observed 3xx is therefore reported only by
 * the fetchers that record real per-hop statuses. That is the intended trade: it
 * is the exact shape a fabricated chain takes, so accusing on it would put the
 * false positive straight back.
 */
function hasObservedRedirect(chain: RedirectChain | undefined): boolean {
  if (!chain || chain.hops.length < 2) return false;
  return chain.hops
    .slice(0, -1)
    .some((hop) => hop.statusCode >= 300 && hop.statusCode < 400);
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

      const original = normalizeUrl(page.url);
      const final = normalizeUrl(page.finalUrl);

      if (original !== final || hasObservedRedirect(page.redirectChain)) {
        const chain = page.redirectChain;
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
            const resolved = new URL(link.url, page.url);
            const normalized = normalizeUrl(resolved.href);
            if (redirectTargets.has(normalized)) {
              const sources = linksToRedirect.get(normalized) ?? new Set();
              sources.add(page.url);
              linksToRedirect.set(normalized, sources);
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
