// integrity/orphan-page — a crawled page that is reachable but neither listed in
// any sitemap NOR linked from any other crawled page. The kit page was exactly
// this: reachable, but invisible to the site's own navigation and sitemap.
//
// Distinct from SEO's `links/orphan-pages` (which flags pages with FEWER than N
// inbound internal links for discoverability). This rule is about *hidden*
// pages — zero inbound links AND absent from the sitemap — as a compromise
// signal, and escalates when the hidden page also carries page-level integrity
// signals.
//
// Two paths share the sitemap handling, the hidden test and the finding (#1022). Legacy reads
// `site.pages[].parsed.links`. The streaming path reads `ctx.siteQuery.outgoingEdges()` and is used
// only when `ctx.collectedSignals` is set too: the v1 fallback detects signals on parsed pages,
// which the streaming path does not have, so without collected signals it stays on legacy.

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
    // Compromise detection: an ignore could hide a compromised site (#1262).
    ignorable: false,
    optionsSchema: z.object({
      minPages: z
        .number()
        .int()
        .min(2)
        .default(3)
        .describe("Minimum crawled pages before hidden-page analysis runs"),
    }),
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery?.outgoingEdges && ctx.collectedSignals) return runSiteQuery(ctx);
    return runLegacy(ctx);
  },
};

interface HiddenPage {
  url: string;
  escalated: boolean;
}

function skippedResult(minPages: number): RuleResult {
  return {
    checks: [
      {
        name: "orphan-page",
        status: "skipped",
        message: `Need >=${minPages} pages for hidden-page analysis`,
        skipReason: "Insufficient pages",
      },
    ],
  };
}

/** Sitemap URL set (normalized) and whether the sitemap corpus is complete enough to trust. */
function readSitemaps(ctx: RuleContext) {
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
  // A truncated, partly read or unrecorded-state sitemap corpus (#1869) cannot prove a page is unlisted, so absence
  // from it is not evidence (#1760): such a page is reported for review only and is
  // never escalated toward "likely injected".
  const sm = ctx.site?.sitemaps;
  const corpusIncomplete =
    sm?.truncated === true || ((sm?.discovered.length ?? 0) > 0 && sm?.readState !== "complete");
  return { sitemapUrls, corpusIncomplete, hasSitemap: sitemapUrls.size > 0 };
}

/** Pages the rule never flags: the homepage and the page the crawl started on. */
function frontDoorSkip(ctx: RuleContext) {
  const baseUrl = ctx.site?.baseUrl ?? "";
  const normalizedBase = baseUrl ? normalizeUrl(baseUrl) : "";
  // Where the crawl started (#788). A root that redirects to `/en/` or to a
  // sign-in page lands the crawl on a page that is often linked from nowhere,
  // and it is the site's front door, not a hidden one.
  const entryPages = new Set((ctx.site?.entryUrls ?? []).map((url) => normalizeUrl(url)));
  return (key: string, url: string) =>
    key === normalizedBase || getPathname(url) === "/" || entryPages.has(key);
}

/**
 * Hidden = no inbound links AND (not in sitemap, when a sitemap exists).
 * If the site has NO sitemap at all, absence from sitemap is meaningless,
 * so we require zero inbound links alone, but that is a weaker signal, so
 * we still gate severity via correlation with page signals.
 */
function isHiddenPage(
  hasSitemap: boolean,
  inSitemap: boolean,
  inboundCount: number,
): boolean {
  return hasSitemap ? inboundCount === 0 && !inSitemap : inboundCount === 0;
}

function buildChecks(
  hidden: HiddenPage[],
  hasSitemap: boolean,
  corpusIncomplete: boolean,
): RuleResult {
  const checks: CheckResult[] = [];
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
      message: corpusIncomplete
        ? `${reviewOnly.length} hidden page(s): linked from nowhere and not in the sitemap, which was only partly read (review)`
        : `${reviewOnly.length} hidden page(s): in no sitemap and linked from nowhere (review)`,
      value: listOf(reviewOnly),
      items: reviewOnly.map((h) => ({ id: h.url })),
      details: { total: reviewOnly.length, hasSitemap, escalated: false, ...(corpusIncomplete ? { sitemapIncomplete: true } : {}) },
    });
  }

  return { checks };
}

function runLegacy(ctx: RuleContext): RuleResult {
  const pages = ctx.site?.pages ?? [];
  const minPages = ctx.options.minPages as number;

  if (pages.length < minPages) return skippedResult(minPages);

  const { sitemapUrls, corpusIncomplete, hasSitemap } = readSitemaps(ctx);

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

  const isFrontDoor = frontDoorSkip(ctx);

  // Per-page integrity-signal count for escalation. Streaming (#1021): read the
  // signals captured at page-time; v1: detect them on demand for each hidden page.
  const signalCountByUrl = ctx.collectedSignals
    ? new Map(ctx.collectedSignals.pages.map((r) => [r.url, r.signals.length]))
    : null;

  const hidden: HiddenPage[] = [];
  for (const page of pages) {
    // Non-null: `norm` was populated from this same `pages` array just above.
    const n = norm.get(page.url)!;

    // Never flag the homepage, or the page the crawl started on.
    if (isFrontDoor(n, page.url)) continue;
    // Only consider successfully fetched pages.
    if (page.statusCode < 200 || page.statusCode >= 300) continue;

    if (!isHiddenPage(hasSitemap, sitemapUrls.has(n), inbound.get(n) ?? 0)) continue;

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
    hidden.push({ url: page.url, escalated: !corpusIncomplete && signalCount >= 1 });
  }

  return buildChecks(hidden, hasSitemap, corpusIncomplete);
}

/** Streaming path (#1022): inbound counts come from one pass over `outgoingEdges()`. */
async function runSiteQuery(ctx: RuleContext): Promise<RuleResult> {
  const query = ctx.siteQuery!;
  const minPages = ctx.options.minPages as number;
  const universe = [...query.incomingLinkCounts().keys()];

  if (universe.length < minPages) return skippedResult(minPages);

  const { sitemapUrls, corpusIncomplete, hasSitemap } = readSitemaps(ctx);

  // Every edge counts, nofollow, chrome, self-links and duplicate-key sources included: the
  // legacy path iterates all pages and filters none of them.
  const inbound = new Map<string, number>();
  for (const url of universe) inbound.set(normalizeUrl(url), 0);
  const notOk = new Set<string>();
  for await (const page of query.outgoingEdges!()) {
    if (page.status === null || page.status < 200 || page.status >= 300) notOk.add(page.source);
    for (const edge of page.edges) {
      inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
    }
  }

  const isFrontDoor = frontDoorSkip(ctx);
  const signalCountByUrl = new Map(ctx.collectedSignals!.pages.map((r) => [r.url, r.signals.length]));

  const hidden: HiddenPage[] = [];
  for (const url of universe) {
    const n = normalizeUrl(url);
    if (isFrontDoor(n, url)) continue;
    if (notOk.has(url)) continue;
    if (!isHiddenPage(hasSitemap, sitemapUrls.has(n), inbound.get(n) ?? 0)) continue;
    const signalCount = signalCountByUrl.get(url) ?? 0;
    hidden.push({ url, escalated: !corpusIncomplete && signalCount >= 1 });
  }

  return buildChecks(hidden, hasSitemap, corpusIncomplete);
}
