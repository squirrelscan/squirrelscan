// integrity/chrome-outlier - pages left on an outdated or broken site template.
//
// Site-scope. Clusters pages by template fingerprint and flags the small
// clusters and singletons on an otherwise uniform site that lack part of the
// dominant chrome: its nav, its footer, all of its stylesheets or all of its
// CSS and script hosts.
// A page that only adds to that chrome (a route CSS chunk, a body class) is not
// reported. The framing is design drift and staleness, not intent.
// `integrity/template-discontinuity` is the intent-minded sibling (is this a
// planted standalone page?), so a page it reports is left out here and the two
// never describe one page twice.
//
// Reads only the stored template fingerprint (page_features.template_fp on the
// streaming path); no schema change. The streaming path scans the scalar column
// through `pagesMatching` rather than `templateClusters()`, because that rollup
// leaves out singletons (count > 1 only) and caps its URL lists, and singletons
// are exactly the pages this rule is for. Both paths cluster on the same
// equivalence (the six chrome markers of the fingerprint) and build the result
// through one function, so output is byte-identical.

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import { getPathname } from "@squirrelscan/utils";

import {
  buildBaseline,
  fingerprintPage,
  similarityToBaseline,
  type PageFingerprint,
} from "./fingerprint";

const CHECK_NAME = "chrome-outlier";

/** Pages needed before a site has a template norm at all. */
export const CHROME_OUTLIER_MIN_PAGES = 10;
/** Share of fingerprinted pages the dominant template must cover. */
export const CHROME_OUTLIER_MIN_AGREEMENT = 0.7;
/** A non-dominant cluster this small (pages) counts as stragglers. */
export const CHROME_OUTLIER_MAX_CLUSTER_PAGES = 3;
/** Straggler share of pages at which the rule fails instead of warning. */
export const CHROME_OUTLIER_FAIL_SHARE = 0.1;

// Mirrors template-discontinuity's defaults, used only to suppress its pages.
const DISCONTINUITY_MIN_PAGES = 4;
const DISCONTINUITY_THRESHOLD = 0.2;

interface Entry {
  url: string;
  /** Equality key of the page's chrome. Never surfaces in output. */
  key: string;
  /**
   * The page's decomposed chrome, to say what it lacks against the dominant
   * template. Absent on the streaming path when no page-time fingerprint was
   * captured; such a page is never reported, since nothing proves it lacks anything.
   */
  fp?: PageFingerprint;
}

interface Options {
  minPages: number;
  minAgreement: number;
  maxClusterPages: number;
  failShare: number;
}

/** Same six chrome markers the stored key hashes; order-insensitive. */
function chromeKey(fp: PageFingerprint): string {
  return JSON.stringify([
    [...fp.assetHosts].sort(),
    [...fp.bodyClasses].sort(),
    [...fp.cssVars].sort(),
    [...fp.stylesheetHrefs].sort(),
    fp.hasNav,
    fp.hasFooter,
  ]);
}

/**
 * What `fp` lacks that the dominant template has: its nav, its footer, every
 * one of its stylesheets, or every one of its CSS and script hosts. Empty when
 * the page keeps the template's chrome.
 *
 * Only absences count. A page that adds a route-level CSS chunk, a body class
 * or a CSS variable on top of the dominant chrome is a page with its own
 * styling, not one left behind, so a different cluster key alone never reports
 * a page (#1367). Body classes and CSS variables vary per route on most
 * frameworks, so they are not compared at all.
 *
 * Stylesheets and hosts are a straggler signal only when the page shares none
 * of the template's. The dominant template routinely carries assets that are
 * not site chrome: a post stylesheet, an image CDN every post embeds from, a
 * preconnect link. An about or contact page that keeps the site stylesheet but
 * lacks those is still on the current template. Hosts are the code hosts (a
 * stylesheet or a script), never image or bare `<link>` hosts, because content
 * images and resource hints say nothing about which template rendered a page.
 */
function missingChrome(fp: PageFingerprint, dominant: PageFingerprint): string[] {
  const missing: string[] = [];
  if (dominant.hasNav && !fp.hasNav) missing.push("navigation");
  if (dominant.hasFooter && !fp.hasFooter) missing.push("footer");
  const sharesNone = (want: Set<string>, have: Set<string>): boolean =>
    want.size > 0 && ![...want].some((v) => have.has(v));
  if (sharesNone(dominant.stylesheetHrefs, fp.stylesheetHrefs)) missing.push("site stylesheets");
  if (sharesNone(dominant.codeHosts, fp.codeHosts)) missing.push("site CSS and script hosts");
  return missing;
}

const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * URLs `integrity/template-discontinuity` would report as off-template. That
 * rule owns them; this one leaves them out. Empty when the rule would itself be
 * skipped (too few pages, or no shared theme markers).
 */
function discontinuityUrls(fps: { url: string; fp: PageFingerprint }[]): Set<string> {
  const out = new Set<string>();
  if (fps.length < DISCONTINUITY_MIN_PAGES) return out;
  const baseline = buildBaseline(fps.map((e) => e.fp));
  if (baseline.stylesheetHrefs.size === 0 && baseline.assetHosts.size === 0) return out;
  for (const { url, fp } of fps) {
    if (similarityToBaseline(fp, baseline) < DISCONTINUITY_THRESHOLD) out.add(url);
  }
  return out;
}

const skipped = (message: string, skipReason: string): RuleResult => ({
  checks: [{ name: CHECK_NAME, status: "skipped", message, skipReason }],
});

// Shared by both paths: identical entries in, identical result out.
function evaluate(entries: Entry[], suppressed: Set<string>, opts: Options): RuleResult {
  if (entries.length < opts.minPages) {
    return skipped(
      `Need >=${opts.minPages} pages to establish a site template`,
      "Insufficient pages for a template norm",
    );
  }

  const clusters = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = clusters.get(e.key);
    if (list) list.push(e);
    else clusters.set(e.key, [e]);
  }

  let dominantKey = "";
  let dominantSize = 0;
  for (const [key, list] of clusters) {
    // Tie-break on the key so the choice is order-independent.
    if (list.length > dominantSize || (list.length === dominantSize && key < dominantKey)) {
      dominantKey = key;
      dominantSize = list.length;
    }
  }

  const agreement = dominantSize / entries.length;
  if (agreement < opts.minAgreement) {
    return skipped(
      "No dominant site template: the pages use several distinct templates",
      "No dominant template cluster",
    );
  }

  // Every page in the dominant cluster shares one key, so any member's
  // fingerprint is the template's. Take the lowest URL that has one, so the
  // choice does not depend on page order.
  let dominantFp: PageFingerprint | undefined;
  let dominantFpUrl = "";
  for (const e of clusters.get(dominantKey) ?? []) {
    if (e.fp && (!dominantFp || e.url < dominantFpUrl)) {
      dominantFp = e.fp;
      dominantFpUrl = e.url;
    }
  }

  const stragglers: { url: string; missing: string[] }[] = [];
  if (dominantFp) {
    for (const [key, list] of clusters) {
      if (key === dominantKey || list.length > opts.maxClusterPages) continue;
      for (const e of list) {
        if (!e.fp || suppressed.has(e.url)) continue;
        const missing = missingChrome(e.fp, dominantFp);
        if (missing.length > 0) stragglers.push({ url: e.url, missing });
      }
    }
  }
  stragglers.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  if (stragglers.length === 0) {
    return {
      checks: [
        {
          name: CHECK_NAME,
          status: "pass",
          message:
            "All pages share the site's dominant template or a sizeable template of their own",
        },
      ],
    };
  }

  const share = stragglers.length / entries.length;
  const preview =
    stragglers
      .slice(0, 5)
      .map((e) => getPathname(e.url))
      .join("\n") + (stragglers.length > 5 ? `\n+${stragglers.length - 5} more` : "");
  const check: CheckResult = {
    name: CHECK_NAME,
    status: share >= opts.failShare && stragglers.length >= 3 ? "fail" : "warn",
    message: `${stragglers.length} page(s) look left on an outdated or broken site template`,
    value: preview,
    items: stragglers.map((e) => ({ id: e.url, label: `Missing ${e.missing.join(", ")}` })),
    details: {
      total: stragglers.length,
      pagesCompared: entries.length,
      dominantTemplatePages: dominantSize,
      sharePct: Math.round(share * 1000) / 10,
    },
  };
  return { checks: [check] };
}

function readOptions(ctx: RuleContext): Options {
  return {
    minPages: ctx.options.minPages as number,
    minAgreement: ctx.options.minAgreement as number,
    maxClusterPages: ctx.options.maxClusterPages as number,
    failShare: ctx.options.failShare as number,
  };
}

async function runViaSiteQuery(
  siteQuery: SiteQuery,
  ctx: RuleContext,
  opts: Options,
): Promise<RuleResult> {
  if (siteQuery.pageCount() < opts.minPages) {
    return skipped(
      `Need >=${opts.minPages} pages to establish a site template`,
      "Insufficient pages for a template norm",
    );
  }
  const collected = ctx.collectedSignals;
  const fps: { url: string; fp: PageFingerprint }[] = [];
  if (collected) {
    for (const rec of collected.pages)
      if (rec.fingerprint) fps.push({ url: rec.url, fp: rec.fingerprint });
  }
  const fpByUrl = new Map(fps.map((e) => [e.url, e.fp]));
  const entries: Entry[] = [];
  for await (const row of siteQuery.pagesMatching((r: PageFeatureRow) => isOk(r.status))) {
    if (!row.templateFp) continue;
    const fp = fpByUrl.get(row.normalizedUrl);
    entries.push({ url: row.normalizedUrl, key: row.templateFp, ...(fp ? { fp } : {}) });
  }
  return evaluate(entries, discontinuityUrls(fps), opts);
}

export const chromeOutlierRule: Rule = {
  meta: {
    id: "integrity/chrome-outlier",
    name: "Chrome Outlier",
    description:
      "Finds pages left on an outdated or broken site template: a few pages missing the navigation, footer, stylesheets or CSS and script hosts of a site that is otherwise uniform",
    solution:
      "These pages do not share the template the rest of your site uses. After a redesign that usually means pages still on the old layout, or pages that lost their navigation, footer or stylesheets. Open each page and compare it with a page that looks right. If it is a deliberate one-off (a campaign page, a standalone tool), leave it. Otherwise move it onto the current template or republish it from the current theme.",
    category: "integrity",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 4,
    // Every integrity rule is locked against [[ignore]] (#1262), as the docs and
    // the agent skill promise; switch it off with [rules] disable instead.
    ignorable: false,
    optionsSchema: z.object({
      minPages: z
        .number()
        .int()
        .min(3)
        .default(CHROME_OUTLIER_MIN_PAGES)
        .describe("Minimum pages needed to establish a site template norm"),
      minAgreement: z
        .number()
        .min(0.5)
        .max(1)
        .default(CHROME_OUTLIER_MIN_AGREEMENT)
        .describe("Share of pages the dominant template must cover before outliers are flagged"),
      maxClusterPages: z
        .number()
        .int()
        .min(1)
        .default(CHROME_OUTLIER_MAX_CLUSTER_PAGES)
        .describe("A non-dominant template used by at most this many pages counts as stragglers"),
      failShare: z
        .number()
        .min(0)
        .max(1)
        .default(CHROME_OUTLIER_FAIL_SHARE)
        .describe("Straggler share of all pages at which the rule fails instead of warning"),
    }),
    checks: [
      { name: CHECK_NAME, outcome: "problem" },
      { name: CHECK_NAME, outcome: "clean", clears: [CHECK_NAME] },
      { name: CHECK_NAME, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const opts = readOptions(ctx);
    if (ctx.siteQuery) return runViaSiteQuery(ctx.siteQuery, ctx, opts);

    const pages = ctx.site?.pages ?? [];
    if (pages.length < opts.minPages) {
      return skipped(
        `Need >=${opts.minPages} pages to establish a site template`,
        "Insufficient pages for a template norm",
      );
    }
    const entries: Entry[] = [];
    const fps: { url: string; fp: PageFingerprint }[] = [];
    for (const page of pages) {
      const fp = fingerprintPage(page.parsed, page.url);
      if (!fp) continue;
      fps.push({ url: page.url, fp });
      if (isOk(page.statusCode)) entries.push({ url: page.url, key: chromeKey(fp), fp });
    }
    return evaluate(entries, discontinuityUrls(fps), opts);
  },
};
