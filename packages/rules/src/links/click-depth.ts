// links/click-depth - Indexable pages more than N clicks from the homepage
//
// Depth is the shortest path over internal dofollow links found in the crawl,
// computed here by a breadth-first search from the front door. It is NOT the
// crawler's own `depth` column: that records the order the crawler happened to
// reach a page, and a page linked from the homepage must be depth 1 whichever
// way it was queued.
//
// Choices that keep it from accusing a page falsely:
//   * Only pages the search REACHES get a depth. A page found only through the
//     sitemap has no link path and is left to links/orphan-pages.
//   * Noindex pages and error responses are never listed (they may still carry
//     links that shorten another page's path). Redirects are not in the page
//     universe, so a path through one is unseen: a page reached only through a
//     redirect gets no depth rather than a long one.
//   * The edges come from one of two sources with the same filters. Legacy: `site.pages[].parsed.links`,
//     which both engines carry (the streaming engine drops only the DOM). Streaming (#1022): when
//     `ctx.siteQuery.clickDepths` exists the search runs there over the stored page links, bounded
//     by SEARCH_MAX_DEPTH and SEARCH_MAX_NODES, and a search cut short by either bound is labelled
//     a lower bound like the crawl cap. One shared function builds the finding for both paths.
//   * A crawl stopped at its page cap still reports, labelled as a lower bound.

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import { frontDoorTest } from "../shared/front-door";
import { noindexSource } from "../shared/noindex";

const NAME = "click-depth";

/** Sampled paths shown in `value`; `details.total` and `items` carry them all. */
const MAX_SAMPLE = 5;

export interface DepthEntry {
  url: string;
  depth: number;
}

/**
 * Shortest click depth of every page reachable from `roots` (depth 0), over the
 * `edges` map (source url to the urls it links to). Pure and deterministic: the
 * result depends on the graph, not on the order the pages were visited.
 */
export function shortestDepths(
  roots: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const depths = new Map<string, number>();
  let frontier: string[] = [];
  for (const root of roots) {
    if (!depths.has(root)) {
      depths.set(root, 0);
      frontier.push(root);
    }
  }
  let depth = 0;
  while (frontier.length > 0) {
    depth++;
    const next: string[] = [];
    for (const url of frontier) {
      for (const target of edges.get(url) ?? []) {
        if (!depths.has(target)) {
          depths.set(target, depth);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return depths;
}

/**
 * Streaming path bounds (#1022). The search makes one targeted read of the frontier pages per click level, so
 * it stops at SEARCH_MAX_DEPTH levels (or one past the rule's maxDepth when that is larger), and
 * its depth map never holds more than SEARCH_MAX_NODES pages. A site that hits either is reported
 * as a lower bound, never silently shortened.
 */
export const SEARCH_MAX_DEPTH = 50;
export const SEARCH_MAX_NODES = 250_000;

function skipped(message: string, skipReason: string): RuleResult {
  return { checks: [{ name: NAME, status: "skipped", message, skipReason }] };
}

export const clickDepthRule: Rule = {
  meta: {
    id: "links/click-depth",
    name: "Click Depth",
    description: "Detects indexable pages that take many clicks to reach from the homepage",
    solution:
      "Pages many clicks from the homepage are crawled less often and receive little internal link weight. Link important deep pages from the homepage, a hub or category page, or the main navigation. Add paginated or archive shortcuts, related-content links and breadcrumbs so the shortest path gets shorter. Pages that are deep on purpose can be left alone, or raise the threshold with the maxDepth rule option.",
    category: "links",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    // Advisory: a deep page is a structure hint, not a defect, so it costs a
    // site the smallest share of the links score.
    weight: 1,
    optionsSchema: z.object({
      maxDepth: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe("Pages more than this many clicks from the homepage are listed"),
    }),
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery?.clickDepths) return runSiteQuery(ctx);
    return runLegacy(ctx);
  },
};

function noPages(): RuleResult {
  return skipped(
    "Insufficient pages for click depth analysis",
    "Needs at least two pages: a single page audit has no link path to measure",
  );
}

function noHomepage(): RuleResult {
  return skipped(
    "The homepage was not among the crawled pages",
    "No homepage to measure click depth from",
  );
}

/**
 * The finding, shared by both paths so their output is identical by construction. `deep` is
 * unsorted; `searchTruncated` is set only when the streaming search stopped at a bound.
 */
function buildResult(
  ctx: RuleContext,
  maxDepth: number,
  deep: DepthEntry[],
  searchTruncated: "maxDepth" | "maxNodes" | null,
  searchLimit: number,
): RuleResult {
  // Deepest first, then by url so the order never depends on the crawl.
  deep.sort((a, b) => b.depth - a.depth || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const limits = ctx.site?.crawlLimits;
  const capped = limits !== undefined && limits.pagesCrawled >= limits.maxPages;
  let cappedNote = capped
    ? ` The crawl stopped at its ${limits.maxPages}-page cap, so depths are a lower bound.`
    : "";
  if (searchTruncated === "maxDepth") {
    cappedNote += ` The click-depth search stopped at its ${searchLimit}-click limit, so deeper pages are not listed.`;
  } else if (searchTruncated === "maxNodes") {
    cappedNote += ` The click-depth search stopped at its ${searchLimit}-page limit, so deeper pages are not listed.`;
  }
  const lowerBound = capped || searchTruncated !== null;
  const extra = {
    ...(lowerBound ? { lowerBound: true } : {}),
    ...(searchTruncated !== null ? { searchTruncated } : {}),
  };

  let check: CheckResult;
  if (deep.length === 0) {
    check = {
      name: NAME,
      status: "pass",
      message: `No indexable page is more than ${maxDepth} clicks from the homepage.${cappedNote}`,
      details: { total: 0, threshold: maxDepth, ...extra },
    };
  } else {
    const deepest = deep[0]!.depth;
    const sample = deep
      .slice(0, MAX_SAMPLE)
      .map((e) => `${getPathname(e.url)} (${e.depth} clicks)`)
      .join("\n");
    const suffix = deep.length > MAX_SAMPLE ? `\n+${deep.length - MAX_SAMPLE} more` : "";
    check = {
      name: NAME,
      status: "warn",
      message: `${deep.length} indexable page(s) are more than ${maxDepth} clicks from the homepage, deepest at ${deepest}.${cappedNote}`,
      items: deep.map((e) => ({
        id: e.url,
        label: `${e.url} (${e.depth} clicks)`,
        meta: { depth: e.depth },
      })),
      details: {
        total: deep.length,
        threshold: maxDepth,
        deepest,
        ...extra,
      },
      value: sample + suffix,
    };
  }
  return { checks: [check] };
}

function runLegacy(ctx: RuleContext): RuleResult {
  const maxDepth = ctx.options.maxDepth as number;
  const pages = ctx.site?.pages ?? [];

  if (pages.length < 2) return noPages();

  const isFrontDoor = frontDoorTest(ctx.site?.baseUrl || "", ctx.site?.entryUrls ?? []);

  // Page universe keyed by normalized url, plus the dofollow internal edges
  // between pages of that universe. First page wins a duplicate key, in the
  // crawl's stable order.
  const byUrl = new Map<string, (typeof pages)[number]>();
  for (const page of pages) {
    const key = normalizeUrl(page.url);
    if (!byUrl.has(key)) byUrl.set(key, page);
  }
  const roots: string[] = [];
  const edges = new Map<string, string[]>();
  for (const [key, page] of byUrl) {
    if (isFrontDoor(page.url)) roots.push(key);
    const targets: string[] = [];
    for (const link of page.parsed?.links ?? []) {
      if (!link.isInternal || !link.url || link.isNofollow) continue;
      try {
        const target = normalizeUrl(new URL(link.url, page.url).href);
        if (target !== key && byUrl.has(target)) targets.push(target);
      } catch {
        // An unparsable href is links/invalid-links' business.
      }
    }
    edges.set(key, targets);
  }

  if (roots.length === 0) return noHomepage();

  const depths = shortestDepths(roots, edges);
  const deep: DepthEntry[] = [];
  for (const [url, depth] of depths) {
    if (depth <= maxDepth) continue;
    const page = byUrl.get(url)!;
    if (page.statusCode < 200 || page.statusCode >= 300) continue;
    if (noindexSource(page.parsed, page.headers) !== null) continue;
    deep.push({ url: page.url, depth });
  }
  return buildResult(ctx, maxDepth, deep, null, 0);
}

/** Streaming path (#1022): the search runs over the stored page links, bounded, no adjacency map. */
async function runSiteQuery(ctx: RuleContext): Promise<RuleResult> {
  const query = ctx.siteQuery!;
  const maxDepth = ctx.options.maxDepth as number;

  // Universe in order; the first stored url per graph key is the page the legacy rule keeps.
  const winners = new Map<string, string>();
  const universe = [...query.incomingLinkCounts().keys()];
  for (const url of universe) {
    const key = normalizeUrl(url);
    if (!winners.has(key)) winners.set(key, url);
  }
  if (universe.length < 2) return noPages();

  const isFrontDoor = frontDoorTest(ctx.site?.baseUrl || "", ctx.site?.entryUrls ?? []);
  const roots: string[] = [];
  for (const url of winners.values()) {
    if (isFrontDoor(url)) roots.push(url);
  }
  if (roots.length === 0) return noHomepage();

  const searchDepth = Math.max(SEARCH_MAX_DEPTH, maxDepth + 1);
  const result = await query.clickDepths!(roots, {
    maxDepth: searchDepth,
    maxNodes: SEARCH_MAX_NODES,
  });

  // The same test as noindexSource: page_features carries it as indexableReasons.
  const noindex = new Set<string>();
  for await (const row of query.pagesMatching(
    (r) => r.indexableReasons.includes("meta:noindex") || r.indexableReasons.includes("header:noindex"),
  )) {
    noindex.add(row.normalizedUrl);
  }

  const deep: DepthEntry[] = [];
  for (const [url, node] of result.depths) {
    if (node.depth <= maxDepth) continue;
    if (node.status === null || node.status < 200 || node.status >= 300) continue;
    if (noindex.has(url)) continue;
    deep.push({ url, depth: node.depth });
  }
  const limit = result.truncated === "maxNodes" ? SEARCH_MAX_NODES : searchDepth;
  return buildResult(ctx, maxDepth, deep, result.truncated, limit);
}
