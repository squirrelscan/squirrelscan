// integrity/template-discontinuity — flag pages whose template fingerprint
// diverges hard from the site's dominant theme cluster (the kit page had ZERO
// theme markup on an otherwise themed WP site).
//
// Site-scope. Builds a baseline from the majority theme cluster, then scores each
// page's similarity. Pages far below threshold are flagged. A page that ALSO
// carries page-level integrity signals (brand/obfuscation/overlay/doorway) is
// escalated; a lone template outlier is `info` (could be a legitimate off-theme
// landing page).
//
// Two things bound the escalation (#2233). A page that loads the site's OWN
// assets is never escalated however far its markup diverges: an injected
// standalone page is standalone, and a signed-out account view or an empty
// state that pulls the site's stylesheets is the site's own page rendering a
// different shell. And the escalated check warns rather than fails, because
// the evidence is a similarity score plus a heuristic signal, which is enough
// to ask someone to look and not enough to zero a category or to tell them
// their site is compromised.

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

import {
  buildBaseline,
  fingerprintPage,
  similarityToBaseline,
  type PageFingerprint,
} from "./fingerprint";
import { detectPageSignals } from "./signals";

/**
 * Hosts that serve the same files to everybody.
 *
 * The veto below asks "does this page load something the rest of the site
 * loads", as evidence that the site itself rendered it. A font or library CDN
 * cannot answer that: a standalone page pulling Google Fonts shares a host with
 * every other site on the web that pulls Google Fonts, including the one it was
 * injected into. Matched on the host and any subdomain of it, so the jsDelivr
 * and unpkg mirrors are covered without listing each one (#2233).
 */
const SHARED_PUBLIC_ASSET_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "ajax.googleapis.com",
  "cdnjs.cloudflare.com",
  "jsdelivr.net",
  "unpkg.com",
];

const isSharedPublicAssetHost = (host: string): boolean =>
  SHARED_PUBLIC_ASSET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Host of an absolute or protocol-relative href, lowercased, port and userinfo
 * stripped. `null` for a relative href, which is same-origin by definition and
 * therefore never one of the shared hosts above.
 */
const hrefHost = (href: string): string | null => {
  const m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(href);
  if (!m) return null;
  const authority = m[1].split("@").pop() ?? "";
  return authority.replace(/:\d+$/, "").toLowerCase() || null;
};

export const templateDiscontinuityRule: Rule = {
  meta: {
    id: "integrity/template-discontinuity",
    name: "Template Discontinuity",
    description:
      "Detects pages whose markup diverges hard from the site's common template — a standalone page with none of the site's theme is a classic injected-page signal",
    solution:
      "This page shares almost none of your site's theme: no stylesheets, asset hosts, nav or footer, or CSS variables in common with the rest of the crawl. That is usually deliberate: a campaign landing page, a signed-out or empty state, a checkout step, a status page. It is worth a glance only because an injected standalone page looks the same from the outside. Start by confirming the page is one you published. If it is not, and only then, treat the site as compromised: remove the page, audit recently modified files, and check server access logs.",
    category: "integrity",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema: z.object({
      minPages: z
        .number()
        .int()
        .min(3)
        .default(4)
        .describe("Minimum pages needed to establish a reliable baseline"),
      similarityThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.2)
        .describe("Pages below this similarity to the baseline are flagged"),
      minBaselinePagesWhenCapped: z
        .number()
        .int()
        .min(0)
        .default(20)
        .describe(
          "When the crawl stopped at its page limit, escalate only if the baseline was built from at least this many pages; below it, outliers are still reported for review"
        ),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    /** Do these two sets have anything at all in common? */
    const intersects = (a: Set<string>, b: Set<string>): boolean => {
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      for (const value of small) if (large.has(value)) return true;
      return false;
    };

    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages ?? [];
    const minPages = ctx.options.minPages as number;
    const threshold = ctx.options.similarityThreshold as number;
    const minBaselinePagesWhenCapped = ctx.options
      .minBaselinePagesWhenCapped as number;

    // A crawl that stopped at its page limit did not see the site; it saw the
    // first N pages of it. The baseline is then whatever those N had in common,
    // which on a capped run of a large site can be one section's template, and
    // every page outside it looks foreign. Reporting those for review is fine.
    // Telling someone their site may be compromised on that evidence is not
    // (#2233 AC4). The same `pagesCrawled >= maxPages` reading sitemap-coverage
    // uses; undefined limits mean a caller that never threaded it through, which
    // is treated as not capped.
    const limits = ctx.site?.crawlLimits;
    const crawlWasCapped = !!limits && limits.pagesCrawled >= limits.maxPages;

    if (pages.length < minPages) {
      checks.push({
        name: "template-discontinuity",
        status: "skipped",
        message: `Need >=${minPages} pages to establish a template baseline`,
        skipReason: "Insufficient pages for baseline",
      });
      return { checks };
    }

    // Fingerprint every page with a parseable document. Streaming (#1021): the
    // per-page fingerprint was captured at page-time — read it; else fingerprint
    // each live document (v1). fingerprintPage is shared, so entries match exactly.
    const collected = ctx.collectedSignals;
    const entries: { url: string; fp: PageFingerprint }[] = [];
    if (collected) {
      for (const rec of collected.pages) {
        if (rec.fingerprint) entries.push({ url: rec.url, fp: rec.fingerprint });
      }
    } else {
      for (const page of pages) {
        const fp = fingerprintPage(page.parsed, page.url);
        if (fp) entries.push({ url: page.url, fp });
      }
    }

    if (entries.length < minPages) {
      checks.push({
        name: "template-discontinuity",
        status: "skipped",
        message: "Too few parseable pages for a template baseline",
        skipReason: "Insufficient parseable pages",
      });
      return { checks };
    }

    const baseline = buildBaseline(entries.map((e) => e.fp));

    // If the baseline itself is empty (no shared theme markers — e.g. a site of
    // wholly unrelated pages), we can't reliably call anything an outlier.
    const baselineEmpty =
      baseline.stylesheetHrefs.size === 0 && baseline.assetHosts.size === 0;
    if (baselineEmpty) {
      checks.push({
        name: "template-discontinuity",
        status: "skipped",
        message: "No shared template baseline detected across the site",
        skipReason: "No shared theme markers",
      });
      return { checks };
    }

    // The veto's two reference sets, built once. Shared public CDNs are dropped
    // from both: a host everybody loads from cannot distinguish the site's own
    // page from a page injected into it.
    const siteResourceHosts = new Set(
      [...baseline.resourceHosts].filter((h) => !isSharedPublicAssetHost(h))
    );
    const siteStylesheetHrefs = new Set(
      [...baseline.stylesheetHrefs].filter((href) => {
        const host = hrefHost(href);
        return host === null || !isSharedPublicAssetHost(host);
      })
    );

    // AC4: a capped crawl with a thin baseline can report, but not accuse.
    const baselineTooSmallToEscalate =
      crawlWasCapped && baseline.pageCount < minBaselinePagesWhenCapped;

    const outliers: {
      url: string;
      similarity: number;
      /** Page-level integrity signals this page also carries. */
      signals: number;
      /** Does it load anything the rest of the site loads? */
      loadsSiteAssets: boolean;
      escalated: boolean;
    }[] = [];

    // Per-page integrity-signal count for escalation. Streaming: read the signals
    // captured at page-time; v1: detect them on demand for each outlier.
    const signalCountByUrl = collected
      ? new Map(collected.pages.map((r) => [r.url, r.signals.length]))
      : null;

    // v1 looks the outlier's page up by url to build a context for the signal
    // detectors. That lookup used to be `pages.find(...)`, a scan of the whole
    // page set PER OUTLIER: with an outlier share f that is f*n lookups over n
    // pages, so the branch was quadratic in page count and linear in the share.
    // It only ever ran on the v1 path — streaming reads the map above — and only
    // on a site that actually has outliers, which is why a corpus of uniformly
    // themed pages never showed it (#1910).
    //
    // The saving is ASYMPTOTIC, not something you can see today. At the largest
    // share the rule can be given (one page in three; at one in two the baseline
    // absorbs both groups and there are no outliers at all) 2,500 pages is
    // 833 outliers over 2,500 entries, about a million string compares, which is
    // a small part of a rule that takes ~215 ms. Measured before and after at
    // that size and share on a quiet machine: 215 ms and 225 ms, i.e. nothing.
    // The term is real and grows as f*n^2; it is simply not what dominates at a
    // size this fixture can reach.
    //
    // LAZY, so a site with no outliers pays nothing and an outlier run pays one
    // O(n) build instead of one O(n) scan per outlier, and FIRST-WINS, because
    // `find` returned the first match and `SiteData.pages` is caller-supplied
    // and not deduplicated. Building it with `new Map(pages.map(...))` would
    // keep the LAST entry for a repeated url, which flips this rule's verdict
    // from info to fail when a benign page and a compromised one share one.
    let pageByUrl: Map<string, (typeof pages)[number]> | null = null;
    const pageFor = (url: string) => {
      if (!pageByUrl) {
        pageByUrl = new Map();
        for (const p of pages) if (!pageByUrl.has(p.url)) pageByUrl.set(p.url, p);
      }
      return pageByUrl.get(url)!;
    };

    for (const { url, fp } of entries) {
      const similarity = similarityToBaseline(fp, baseline);
      if (similarity >= threshold) continue;

      let signalCount: number;
      if (signalCountByUrl) {
        signalCount = signalCountByUrl.get(url) ?? 0;
      } else {
        // Correlate: does this divergent page also carry page-level integrity
        // signals? Build a minimal page ctx for the signal detectors. `html: ""` is
        // intentional — the detectors read parsed.document/parsed.content, not
        // page.html (see orphan-page.ts for the same note).
        const page = pageFor(url);
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
      // An injected standalone page brings its own everything. A page that
      // still pulls one of the site's own stylesheets, or loads a stylesheet or
      // script from a host the rest of the site serves resources from, is the
      // site's own page however little of the theme it renders, which is what
      // the solution text has always told the reader to look for.
      //
      // Both arms are narrower than they look, deliberately. `siteResourceHosts`
      // is the majority tally of hosts that served a stylesheet, script or image,
      // so a lone `<link rel=canonical>` or favicon on the outlier no longer buys
      // it a veto, and the outlier side reads `codeHosts`, so a hotlinked logo
      // does not either. Shared public CDNs are excluded on both arms: they say
      // nothing about WHICH site rendered the page.
      const loadsSiteAssets =
        intersects(fp.stylesheetHrefs, siteStylesheetHrefs) ||
        intersects(fp.codeHosts, siteResourceHosts);

      outliers.push({
        url,
        similarity: Math.round(similarity * 100) / 100,
        signals: signalCount,
        loadsSiteAssets,
        // template-discontinuity + >=1 page signal, nothing of the site's own,
        // and a baseline we actually trust.
        escalated:
          signalCount >= 1 && !loadsSiteAssets && !baselineTooSmallToEscalate,
      });
    }

    if (outliers.length === 0) {
      checks.push({
        name: "template-discontinuity",
        status: "pass",
        message: "All pages share the site's common template",
      });
      return { checks };
    }

    // Split escalated (off-template AND carrying page-level compromise signals →
    // `fail`) from review-only outliers (off-template alone → `info`). Never mix
    // a non-escalated page into a high-severity finding (correlation gating).
    const escalated = outliers.filter((o) => o.escalated);
    const reviewOnly = outliers.filter((o) => !o.escalated);
    const fmt = (o: { url: string; similarity: number }) =>
      `${getPathname(o.url)} (sim ${o.similarity})`;
    const listOf = (items: typeof outliers) =>
      items.slice(0, 5).map(fmt).join("\n") +
      (items.length > 5 ? `\n+${items.length - 5} more` : "");

    if (escalated.length > 0) {
      checks.push({
        name: "template-discontinuity",
        status: "warn",
        message: `${escalated.length} off-template page(s) share none of the site's assets and carry a page-level integrity signal`,
        value: listOf(escalated),
        items: escalated.map((o) => ({ id: o.url })),
        details: {
          total: escalated.length,
          baselinePages: baseline.pageCount,
          threshold,
          escalated: true,
          outliers: escalated,
        },
      });
    }

    if (reviewOnly.length > 0) {
      checks.push({
        name: "template-discontinuity-review",
        status: "info",
        message: `${reviewOnly.length} page(s) diverge from the site template (review)`,
        value: listOf(reviewOnly),
        items: reviewOnly.map((o) => ({ id: o.url })),
        details: {
          total: reviewOnly.length,
          baselinePages: baseline.pageCount,
          threshold,
          escalated: false,
          // Says WHY nothing escalated when the reason was the crawl budget
          // rather than the pages: a deeper crawl may reach a different verdict.
          ...(baselineTooSmallToEscalate
            ? { escalationWithheld: "capped_crawl_small_baseline" }
            : {}),
          outliers: reviewOnly,
        },
      });
    }

    return { checks };
  },
};
