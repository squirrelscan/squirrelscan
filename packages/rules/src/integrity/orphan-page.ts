// integrity/orphan-page — a crawled page that is reachable but neither listed in
// any sitemap NOR linked from any other crawled page. The kit page was exactly
// this: reachable, but invisible to the site's own navigation and sitemap.
//
// Distinct from SEO's `links/orphan-pages` (which flags pages with FEWER than N
// inbound internal links for discoverability). This rule is about *hidden*
// pages — zero inbound links AND absent from the sitemap — as a compromise
// signal, and escalates when the hidden page also carries page-level integrity
// signals.

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import { detectPageSignals } from "./signals";

export const orphanPageRule: Rule = {
  meta: {
    id: "integrity/orphan-page",
    name: "Hidden Orphan Page",
    description:
      "Detects crawled pages that are absent from every sitemap AND have no inbound internal links — a hidden page is a common injected-page signal",
    solution:
      "A reachable page that is in no sitemap and linked from nowhere on your site is invisible to you but live to anyone with the URL — exactly how injected phishing/spam pages hide. Confirm you created the page; if not, treat the site as compromised: remove it, audit recently modified files, and review server logs. Legitimate hidden pages (e.g. unlisted landing pages) should at least be in your sitemap if you want them found.",
    category: "integrity",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema: z.object({
      minPages: z
        .number()
        .int()
        .min(2)
        .default(3)
        .describe("Minimum crawled pages before hidden-page analysis runs"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages ?? [];
    const minPages = ctx.options.minPages as number;

    if (pages.length < minPages) {
      checks.push({
        name: "orphan-page",
        status: "skipped",
        message: `Need >=${minPages} pages for hidden-page analysis`,
        skipReason: "Insufficient pages",
      });
      return { checks };
    }

    // Sitemap URL set (normalized).
    const sitemapUrls = new Set<string>();
    for (const sm of ctx.site?.sitemaps?.discovered ?? []) {
      for (const u of sm.urls) {
        try {
          sitemapUrls.add(normalizeUrl(u.loc));
        } catch {
          /* ignore unparsable */
        }
      }
    }
    const hasSitemap = sitemapUrls.size > 0;

    // Inbound internal link counts (normalized target → count).
    const inbound = new Map<string, number>();
    const norm = new Map<string, string>();
    for (const page of pages) {
      const n = normalizeUrl(page.url);
      norm.set(page.url, n);
      if (!inbound.has(n)) inbound.set(n, 0);
    }
    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (!link.isInternal || !link.url) continue;
        try {
          const target = normalizeUrl(new URL(link.url, page.url).href);
          if (inbound.has(target)) {
            inbound.set(target, (inbound.get(target) ?? 0) + 1);
          }
        } catch {
          /* ignore */
        }
      }
    }

    const baseUrl = ctx.site?.baseUrl ?? "";
    const normalizedBase = baseUrl ? normalizeUrl(baseUrl) : "";

    // Per-page integrity-signal count for escalation. Streaming (#1021): read the
    // signals captured at page-time; v1: detect them on demand for each hidden page.
    const signalCountByUrl = ctx.collectedSignals
      ? new Map(ctx.collectedSignals.pages.map((r) => [r.url, r.signals.length]))
      : null;

    const hidden: { url: string; escalated: boolean }[] = [];
    for (const page of pages) {
      // Non-null: `norm` was populated from this same `pages` array just above.
      const n = norm.get(page.url)!;

      // Never flag the homepage.
      if (n === normalizedBase || getPathname(page.url) === "/") continue;
      // Only consider successfully fetched pages.
      if (page.statusCode < 200 || page.statusCode >= 300) continue;

      const inSitemap = sitemapUrls.has(n);
      const inboundCount = inbound.get(n) ?? 0;

      // Hidden = no inbound links AND (not in sitemap, when a sitemap exists).
      // If the site has NO sitemap at all, absence from sitemap is meaningless,
      // so we require zero inbound links alone — but that's a weaker signal, so
      // we still gate severity via correlation below.
      const isHidden = hasSitemap
        ? inboundCount === 0 && !inSitemap
        : inboundCount === 0;
      if (!isHidden) continue;

      // Correlate with page-level integrity signals.
      let signalCount: number;
      if (signalCountByUrl) {
        signalCount = signalCountByUrl.get(page.url) ?? 0;
      } else {
        // `html: ""` is intentional: every page signal detector reads
        // ctx.parsed.document / ctx.parsed.content, never ctx.page.html, so the raw
        // HTML isn't needed here (and re-stringifying it would be wasteful). A future
        // detector that needs page.html must source it from the stored page instead.
        const pageCtx: RuleContext = {
          page: {
            url: page.url,
            finalUrl: page.finalUrl,
            html: "",
            statusCode: page.statusCode,
            loadTime: 0,
            headers: page.headers ?? {},
            parsed: page.parsed,
          },
          parsed: page.parsed,
          site: ctx.site,
          siteMetadata: ctx.siteMetadata,
          options: {},
        };
        signalCount = detectPageSignals(pageCtx).size;
      }
      hidden.push({ url: page.url, escalated: signalCount >= 1 });
    }

    if (hidden.length === 0) {
      checks.push({
        name: "orphan-page",
        status: "pass",
        message: "No hidden pages (all crawled pages are linked or in a sitemap)",
      });
      return { checks };
    }

    // Split hidden pages that also carry page-level compromise signals (→ `fail`)
    // from review-only hidden pages (→ `info`). Never fold a non-escalated hidden
    // page into a high-severity finding (correlation gating).
    const escalated = hidden.filter((h) => h.escalated);
    const reviewOnly = hidden.filter((h) => !h.escalated);
    const listOf = (items: typeof hidden) =>
      items.slice(0, 5).map((h) => getPathname(h.url)).join("\n") +
      (items.length > 5 ? `\n+${items.length - 5} more` : "");

    if (escalated.length > 0) {
      checks.push({
        name: "orphan-page",
        status: "fail",
        message: `${escalated.length} hidden page(s) carrying compromise signals — likely injected`,
        value: listOf(escalated),
        items: escalated.map((h) => ({ id: h.url })),
        details: { total: escalated.length, hasSitemap, escalated: true },
      });
    }

    if (reviewOnly.length > 0) {
      checks.push({
        name: "orphan-page-review",
        status: "info",
        message: `${reviewOnly.length} hidden page(s): in no sitemap and linked from nowhere (review)`,
        value: listOf(reviewOnly),
        items: reviewOnly.map((h) => ({ id: h.url })),
        details: { total: reviewOnly.length, hasSitemap, escalated: false },
      });
    }

    return { checks };
  },
};
