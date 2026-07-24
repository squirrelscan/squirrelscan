// crawl/redirect-chain - Multi-hop redirect chain detection

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

export const redirectChainRule: Rule = {
  meta: {
    id: "crawl/redirect-chain",
    name: "Redirect Chains",
    description: "Detects multi-hop redirect chains that waste crawl budget",
    solution:
      "Each redirect hop adds latency and consumes crawl budget. Search engines may stop following after 5+ hops. Consolidate redirect chains to a single hop by updating the source URL to point directly to the final destination. Common causes: HTTP→HTTPS→www→trailing slash combinations, or legacy domain migrations.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 5,
    optionsSchema: z.object({
      maxHops: z
        .number()
        .int()
        .min(1)
        .default(2)
        .describe("Flag redirect chains exceeding this many hops"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;
    const baseUrl = ctx.site?.baseUrl;
    const maxHops = (ctx.options.maxHops as number) ?? 2;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "redirect-chain",
        status: "skipped",
        message: "No pages available for redirect chain analysis",
      });
      return { checks };
    }

    // Find pages with redirect chains exceeding maxHops
    const longChains: Array<{
      url: string;
      hops: number;
      chain: string;
      isEntryUrl?: boolean;
    }> = [];

    // Check all crawled pages
    for (const page of pages) {
      const chain = page.redirectChain;
      if (!chain || chain.hops.length <= maxHops) continue;

      // Build readable chain representation: url1 (301) → url2 (301) → url3 (200)
      const chainParts = chain.hops.map(
        (hop) => `${getPathname(hop.url)} (${hop.statusCode})`
      );
      // Add final URL if different from last hop
      if (chain.finalUrl && chain.hops.length > 0) {
        const lastHop = chain.hops[chain.hops.length - 1];
        if (lastHop.url !== chain.finalUrl) {
          chainParts.push(getPathname(chain.finalUrl) + " (200)");
        }
      }

      longChains.push({
        url: page.url,
        hops: chain.hops.length,
        chain: chainParts.join(" → "),
        isEntryUrl: page.url === baseUrl,
      });
    }

    // Also check if the entry URL itself has redirects (even if not in pages list)
    // This catches cases where the entry URL redirects before being added to pages
    if (baseUrl) {
      const entryPage = pages.find((p) => p.url === baseUrl);
      if (entryPage?.finalUrl && entryPage.finalUrl !== baseUrl) {
        // Entry URL redirected - check if already captured
        const alreadyCaptured = longChains.some((c) => c.url === baseUrl);
        if (!alreadyCaptured) {
          // Single redirect not exceeding maxHops, but worth noting for entry URL
          // This is more of an informational check - entry URL should ideally not redirect
          const chain = entryPage.redirectChain;
          if (chain && chain.hops.length > 0) {
            const chainParts = chain.hops.map(
              (hop) => `${getPathname(hop.url)} (${hop.statusCode})`
            );
            if (chain.finalUrl) {
              chainParts.push(getPathname(chain.finalUrl) + " (200)");
            }
            // Only add if it has at least 1 redirect (even if under maxHops)
            // to highlight entry URL redirects specifically
            if (chain.hops.length >= 1) {
              longChains.push({
                url: baseUrl,
                hops: chain.hops.length,
                chain: chainParts.join(" → "),
                isEntryUrl: true,
              });
            }
          }
        }
      }
    }

    // Separate entry URL redirects from other chains
    const entryUrlChains = longChains.filter((c) => c.isEntryUrl);
    const otherChains = longChains.filter(
      (c) => !c.isEntryUrl && c.hops > maxHops
    );

    // Report entry URL redirects (special case - even 1 hop is notable)
    if (entryUrlChains.length > 0) {
      for (const entry of entryUrlChains) {
        checks.push({
          name: "entry-url-redirect",
          status: entry.hops > maxHops ? "warn" : "info",
          message:
            entry.hops > maxHops
              ? `Entry URL has ${entry.hops}-hop redirect chain`
              : `Entry URL redirects (${entry.hops} hop${entry.hops > 1 ? "s" : ""})`,
          items: [
            {
              id: entry.url,
              label: `${entry.hops} hop${entry.hops > 1 ? "s" : ""}`,
              meta: { chain: entry.chain },
            },
          ],
          details: { chain: entry.chain },
        });
      }
    }

    // Report other long chains
    if (otherChains.length > 0) {
      const pathList = otherChains
        .slice(0, 5)
        .map((item) => `${getPathname(item.url)} (${item.hops} hops)`)
        .join("\n");

      const suffix =
        otherChains.length > 5 ? `\n+${otherChains.length - 5} more` : "";

      checks.push({
        name: "redirect-chain",
        status: "warn",
        message: `${otherChains.length} page(s) have redirect chains >${maxHops} hops`,
        items: otherChains.map((item) => ({
          id: item.url,
          label: `${item.hops} hops`,
          meta: {
            hops: item.hops,
            chain: item.chain,
          },
        })),
        details: { total: otherChains.length, maxHops },
        value: pathList + suffix,
      });
    }

    // Pass if no issues found
    if (entryUrlChains.length === 0 && otherChains.length === 0) {
      checks.push({
        name: "redirect-chain",
        status: "pass",
        message: `No redirect chains exceed ${maxHops} hops`,
      });
    }

    return { checks };
  },
};
