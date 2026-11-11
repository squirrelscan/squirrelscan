// crawl/sitemap-coverage - Check for indexable pages not in sitemap

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { normalizeUrl } from "@squirrelscan/utils";

import { excludesNoindexPage, noindexSource, skipsNoindexPages } from "../shared/noindex";
import { sampleUrlItems } from "../shared/sample-items";
import { productDiscoveryCheck } from "./product-discovery";

function normalizedOrNull(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

const coverageRule: Rule = {
  meta: {
    id: "crawl/sitemap-coverage",
    name: "Sitemap Coverage",
    description: "Checks for indexable pages that are not in the sitemap",
    solution:
      "Your sitemap should include all pages you want search engines to index. Pages that are crawlable and indexable (no noindex, not blocked by robots.txt) should generally be in your sitemap. Missing pages may not be discovered or indexed efficiently. Use a sitemap generator that automatically includes all indexable pages, or manually add important pages.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;
    const pages = ctx.site?.pages;

    if (!sitemaps || sitemaps.discovered.length === 0) {
      checks.push({
        name: "sitemap-coverage",
        status: "skipped",
        message: "No sitemap to compare",
        skipReason: "No sitemap found",
      });
      return { checks };
    }

    if (!pages || pages.length === 0) {
      checks.push({
        name: "sitemap-coverage",
        status: "skipped",
        message: "No pages to compare",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const precomputedMissing = sitemaps.missingPages ?? [];
    const precomputedOrphans = sitemaps.orphanPages ?? [];

    // Get all URLs from sitemaps (normalized) for fallback calculation
    const sitemapUrls = new Set<string>();
    for (const sitemap of sitemaps.discovered) {
      for (const url of sitemap.urls) {
        try {
          sitemapUrls.add(normalizeUrl(url.loc));
        } catch {
          // Skip malformed URLs
        }
      }
    }

    // Noindex pages (meta or X-Robots-Tag) must stay out of the sitemap, so telling
    // the owner to add them contradicts the page's own directive (pub#488). Only
    // applied when the site itself is indexable (the #457 gate), so a staging host
    // that is noindex everywhere still reports. The filter lives here, not in the
    // engine: sitemap-valid reads the unfiltered coverage list.
    const skipNoindex = skipsNoindexPages(ctx.site);

    // Fallback logic explanation:
    // - precomputedMissing is populated by the sitemap processor during crawl
    // - If empty array: either no issues found OR computation not yet run
    // - Fallback computation runs when precomputedMissing is empty to handle:
    //   1. Legacy crawls without precomputed data
    //   2. Edge cases where processor didn't run
    // - This duplicates work when precomputed is truly empty (no issues) but ensures correctness
    // - Cost is acceptable since sitemap comparison is fast relative to crawl time
    // The path is chosen on the unfiltered list: a precomputed list that is empty
    // only after dropping noindex pages must not trigger the fallback.
    const missingFromSitemap: string[] = [];

    if (precomputedMissing.length > 0) {
      const noindexUrls = new Set<string>();
      if (skipNoindex) {
        for (const page of pages) {
          if (!excludesNoindexPage(ctx.site, page.parsed, page.headers)) continue;
          for (const candidate of [page.url, page.finalUrl]) {
            const normalized = candidate ? normalizedOrNull(candidate) : null;
            if (normalized) noindexUrls.add(normalized);
          }
        }
      }
      for (const url of precomputedMissing) {
        if (noindexUrls.size > 0 && noindexUrls.has(normalizedOrNull(url) ?? url)) continue;
        missingFromSitemap.push(url);
      }
    } else {
      for (const page of pages) {
        // Skip non-200 pages
        if (page.statusCode !== 200) continue;

        // Unchanged where the gate is closed: the fallback has always left out
        // meta-noindex pages, and still does (header noindex is only read when
        // the site is known to be indexable).
        const source = noindexSource(page.parsed, page.headers);
        if (skipNoindex ? source !== null : source === "robots meta tag") continue;

        // Check if page (or final URL) is in sitemap
        const candidates = [page.url, page.finalUrl].filter(
          (candidate): candidate is string => !!candidate,
        );
        let inSitemap = false;
        for (const candidate of candidates) {
          const normalizedPageUrl = normalizedOrNull(candidate);
          if (normalizedPageUrl && sitemapUrls.has(normalizedPageUrl)) {
            inSitemap = true;
            break;
          }
        }
        if (!inSitemap) {
          missingFromSitemap.push(page.url);
        }
      }
    }

    if (missingFromSitemap.length > 0) {
      const percentage = Math.round((missingFromSitemap.length / pages.length) * 100);

      checks.push({
        name: "sitemap-coverage",
        status: "warn",
        message: `${missingFromSitemap.length} indexable page(s) not in sitemap (${percentage}%)`,
        items: missingFromSitemap.map((url) => ({ id: url })),
        details: { percentage, total: missingFromSitemap.length },
      });
    } else {
      checks.push({
        name: "sitemap-coverage",
        status: "pass",
        message: "All indexable pages are in sitemap",
      });
    }

    // The engine cuts orphanPages to the report's array cap; the total is the
    // count before that cut, so the message stays exact past it (repo#2320).
    //
    // A sitemap URL the origin refused (429/430 rate limiting, a bot-wall
    // challenge) is not an orphan: the crawl never got an answer for it, so
    // whether it is linked or reachable is unknown (#1639). Those are moved to
    // their own info check, keeping the URLs and statuses as evidence, instead of
    // being dropped or reported as actionable.
    const deniedByUrl = new Map<string, { status: number; reason: "rate_limited" | "waf_challenge" }>();
    for (const target of ctx.site?.fetchedTargets ?? []) {
      if (!target.rateLimited && !target.wafChallenge) continue;
      const key = normalizedOrNull(target.url);
      if (key) {
        deniedByUrl.set(key, {
          status: target.status,
          reason: target.rateLimited ? "rate_limited" : "waf_challenge",
        });
      }
    }
    const denied: Array<{ url: string; status: number; reason: string }> = [];
    const actionableOrphans: string[] = [];
    for (const url of precomputedOrphans) {
      const hit = deniedByUrl.get(normalizedOrNull(url) ?? url);
      if (hit) denied.push({ url, ...hit });
      else actionableOrphans.push(url);
    }
    // The engine's total counts every orphan, denied ones included.
    const orphanTotal = Math.max(
      (sitemaps.orphanPagesTotal ?? 0) - denied.length,
      actionableOrphans.length
    );
    if (denied.length > 0) {
      checks.push({
        name: "sitemap-unverified",
        status: "info",
        message: `${denied.length} sitemap URL(s) were refused or rate limited when crawled, so whether they are orphans is unknown`,
        items: denied.map((entry) => ({ id: entry.url })),
        details: {
          total: denied.length,
          statuses: Array.from(new Set(denied.map((entry) => entry.status))).sort(),
          reasons: Array.from(new Set(denied.map((entry) => entry.reason))).sort(),
        },
      });
    }
    if (actionableOrphans.length > 0) {
      // #697: a crawl truncated by the coverage profile's page cap (e.g. the
      // "quick" profile stopping at 25 pages against a 54-URL sitemap) isn't
      // a coverage problem — it's a crawl-budget artifact that self-heals on
      // a deeper run. Only warn when the cap was NOT hit, i.e. the crawler
      // had budget left and still couldn't reach these sitemap URLs.
      // Also require the sitemap to actually exceed the cap: if the whole
      // site fits within maxPages, hitting the cap was coincidental, not the
      // reason these URLs are missing (codex review).
      const limits = ctx.site?.crawlLimits;
      const wasCapped =
        !!limits && limits.pagesCrawled >= limits.maxPages && sitemaps.totalUrls > limits.maxPages;

      // Count plus sample: one entry per un-crawled sitemap URL ran to
      // thousands of items on a large sitemap (repo#2320).
      const { items, truncation } = sampleUrlItems(
        actionableOrphans.map((url) => ({ id: url })),
        orphanTotal
      );
      // A crawl that stopped with URLs still queued (time limit, crawl-phase
      // backstop) may simply not have reached these: unknown, not an orphan.
      const stoppedEarly = !wasCapped && (ctx.site?.unfetchedPages ?? 0) > 0;
      checks.push({
        name: "sitemap-orphans",
        status: wasCapped || stoppedEarly ? "info" : "warn",
        message: wasCapped
          ? `${orphanTotal} sitemap URL(s) not audited this run (crawl capped at ${limits.maxPages} pages)`
          : stoppedEarly
            ? `${orphanTotal} sitemap URL(s) were not crawled before the crawl stopped (${ctx.site?.unfetchedPages} URL(s) still queued), so they may not be orphans`
            : `${orphanTotal} sitemap URL(s) were not crawled`,
        items,
        details: wasCapped
          ? { ...truncation, total: orphanTotal, cappedAt: limits.maxPages }
          : { ...truncation, total: orphanTotal },
      });
    }

    return { checks };
  },
};

export const sitemapCoverageRule: Rule = {
  ...coverageRule,
  run(ctx: RuleContext): RuleResult {
    const result = coverageRule.run(ctx) as RuleResult;
    // After the coverage verdict, on every path: a failed or absent sitemap read is exactly
    // when the provenance of a shop's product URLs is worth stating.
    const discovery = productDiscoveryCheck(ctx);
    if (discovery) result.checks.push(discovery);
    return result;
  },
};
