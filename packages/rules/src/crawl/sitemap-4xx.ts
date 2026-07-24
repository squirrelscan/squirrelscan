// crawl/sitemap-4xx - Detect 4XX URLs listed in sitemap

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

function toStatusLabel(status: number | null): string {
  return status === null ? "unknown" : String(status);
}

export const sitemap4xxRule: Rule = {
  meta: {
    id: "crawl/sitemap-4xx",
    name: "4XX Pages in Sitemap",
    description: "Checks for sitemap URLs returning 4XX status codes",
    solution:
      "Sitemaps should only list URLs that return 200 and are intended for indexing. Remove 4XX URLs from the sitemap or fix them by restoring the content or redirecting to a valid page. Keep sitemap entries clean to avoid wasting crawl budget.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;

    if (!sitemaps || sitemaps.discovered.length === 0) {
      checks.push({
        name: "sitemap-4xx",
        status: "skipped",
        message: "No sitemap to compare",
        skipReason: "No sitemap found",
      });
      return { checks };
    }

    const statuses = ctx.site?.sitemapUrlStatuses ?? [];
    if (statuses.length === 0) {
      checks.push({
        name: "sitemap-4xx",
        status: "pass",
        message: "No sitemap URL checks available",
      });
      return { checks };
    }

    const badUrls = statuses.filter(
      (entry) =>
        entry.status !== null && entry.status >= 400 && entry.status < 500
    );

    if (badUrls.length > 0) {
      checks.push({
        name: "sitemap-4xx",
        status: "warn",
        message: `${badUrls.length} sitemap URL(s) return 4XX`,
        items: badUrls.map((entry) => ({
          id: entry.url,
          meta: {
            status: toStatusLabel(entry.status),
            error: entry.error ?? undefined,
          },
        })),
        details: {
          total: badUrls.length,
        },
      });
    } else {
      checks.push({
        name: "sitemap-4xx",
        status: "pass",
        message: "No 4XX pages found in sitemap URLs checked",
      });
    }

    return { checks };
  },
};
