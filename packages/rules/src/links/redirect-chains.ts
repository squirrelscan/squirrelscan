// links/redirect-chains - Redirect detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RedirectChain } from "@squirrelscan/core-contracts";

import { normalizeUrl } from "@squirrelscan/utils";

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

      if (original !== final || (page.redirectChain?.chainLength ?? 0) > 0) {
        const chain = page.redirectChain;
        const chainLabel =
          chain && chain.hops.length > 1
            ? chain.hops
                .map((hop) => `${hop.url} (${hop.statusCode})`)
                .join(" → ")
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
