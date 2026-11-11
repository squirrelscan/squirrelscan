// links/redirect-chains - Redirect detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { formatRedirectHop, type RedirectChain } from "@squirrelscan/core-contracts";

import { didRedirect, requestTarget, targetKey } from "../shared/redirect-evidence";
import {
  regionsField,
  sectionMeta,
  tallyFields,
  tallySource,
  withSection,
  type SourceTally,
} from "./link-section-label";

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
    // Check names by outcome class (#1741).
    checks: [
      { name: "redirect-pages", outcome: "problem" },
      { name: "links-to-redirect", outcome: "problem" },
      { name: "redirect-chain-multi-hop", outcome: "problem" },
      { name: "canonical-redirects", outcome: "problem" },
      { name: "redirect-chains", outcome: "clean", clears: ["redirect-pages", "links-to-redirect", "redirect-chain-multi-hop", "canonical-redirects"] },
      { name: "redirect-chains", outcome: "skipped" },
    ],
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
        hopCount: number;
        chain?: RedirectChain;
      }
    >();

    for (const page of pages) {
      if (!page.finalUrl) continue;

      const chain = page.redirectChain;
      const original = targetKey(page.url);

      if (didRedirect(page.url, page.finalUrl, chain)) {
        // Redirect responses followed before the landing page: the last hop is the
        // destination, so a chain of N hops holds N-1 redirects. Unobserved chains
        // (no hop list) still count as one (#1750).
        const hopCount = chain && chain.hops.length > 1 ? chain.hops.length - 1 : 1;
        const path =
          chain && chain.hops.length > 1
            ? chain.hops.map((hop) => formatRedirectHop(hop)).join(" → ")
            : `${page.url} → ${page.finalUrl}`;
        const chainLabel = hopCount > 1 ? `${hopCount} hops: ${path}` : path;
        redirectTargets.set(original, {
          originalUrl: page.url,
          finalUrl: page.finalUrl,
          chainLabel,
          hopCount,
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
            hopCount: target.hopCount,
            chain: target.chain,
          },
        })),
        details: { total: redirectTargets.size },
      });

      // A chain of two or more redirects costs a round trip per hop and is the
      // one to collapse first, so it gets its own failing check (#1750).
      const chained = [...redirectTargets.values()].filter((t) => t.hopCount > 1);
      if (chained.length > 0) {
        const longest = Math.max(...chained.map((t) => t.hopCount));
        checks.push({
          name: "redirect-chain-multi-hop",
          // `warn`, like the rule's declared severity: a rule that declares warning must not emit fail (#1746).
          status: "warn",
          message: `${chained.length} redirect chain(s) of 2 or more hops (longest: ${longest} hops). Point links and the first URL straight at the final destination`,
          items: chained.map((target) => ({
            id: target.originalUrl,
            label: target.chainLabel,
            meta: {
              targetUrl: target.finalUrl,
              hopCount: target.hopCount,
              chain: target.chain,
            },
          })),
          details: { total: chained.length, longestHops: longest },
        });
      }
    }

    // The pages linking each redirecting target: each page once, with its links there and where
    // on the page they sit (#2307, pub#837).
    const linksToRedirect = new Map<string, SourceTally>();

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
              let tally = linksToRedirect.get(target);
              if (!tally) linksToRedirect.set(target, (tally = new Map()));
              tallySource(tally, page.url, link.section);
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
        items: [...linksToRedirect.entries()].map(([target, tally]) => {
          const redirect = redirectTargets.get(target);
          const label = redirect ? redirect.chainLabel : target;
          const { sourcePages, sources, sections, regions } = tallyFields(tally);
          return {
            id: redirect?.originalUrl ?? target,
            label: withSection(label, sections),
            sourcePages,
            sources,
            ...regionsField(regions),
            meta: {
              targetUrl: redirect?.finalUrl ?? target,
              chain: redirect?.chain,
              ...sectionMeta(sections),
            },
          };
        }),
        details: { total: linksToRedirect.size },
      });
    }

    // A page whose canonical names a URL that redirected to it (#1762). The redirecting URL is not
    // a page of its own, so this is where the canonical-names-a-redirect finding lives now.
    if (redirectTargets.size > 0) {
      const byRequest = new Map<string, (typeof redirectTargets extends Map<string, infer V> ? V : never)>();
      for (const target of redirectTargets.values()) byRequest.set(requestTarget(target.originalUrl), target);
      const canonicalToRedirect: Array<{ page: string; canonical: string; label: string; chain?: RedirectChain }> = [];
      for (const page of pages) {
        const canonical = page.parsed?.meta?.canonical;
        if (!canonical || page.redirectSource) continue;
        try {
          const absolute = new URL(canonical, page.url).href;
          const redirect = byRequest.get(requestTarget(absolute));
          if (redirect && requestTarget(redirect.finalUrl) === requestTarget(page.url)) {
            canonicalToRedirect.push({ page: page.url, canonical: absolute, label: redirect.chainLabel, chain: redirect.chain });
          }
        } catch {
          continue;
        }
      }
      if (canonicalToRedirect.length > 0) {
        checks.push({
          name: "canonical-redirects",
          status: "warn",
          message: `${canonicalToRedirect.length} page(s) declare a canonical URL that redirects to them`,
          items: canonicalToRedirect.map((c) => ({
            id: c.canonical,
            label: c.label,
            sourcePages: [c.page],
            meta: { chain: c.chain, finalUrl: c.page },
          })),
          details: { total: canonicalToRedirect.length },
        });
      }
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
