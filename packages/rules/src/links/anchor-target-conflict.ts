// links/anchor-target-conflict - the same anchor text pointing at different pages (#1372)
//
// `links/anchor-text` judges one page's links and cannot see two things that need the whole
// corpus: one anchor text ("Pricing") that points at several different URLs, and one URL that is
// linked with several unrelated anchor texts. Both are ambiguous for readers, split the ranking
// signal a link carries, and leave an agent that navigates by link label guessing.
//
// The input is the anchor graph `links/anchor-mismatch` already builds on both paths (the same
// `AnchorGraphBuilder`, fed the same links), so the legacy `ctx.site.pages` path and the streaming
// `SiteQuery` path cannot diverge: both hand `evaluateAnchorConflicts` an identical graph. The
// graph is bounded (pair cap, 8 texts per pair kept in link order, overflow counted in
// `details.droppedPairs`), so a large crawl never grows it without limit.
//
// FALSE-POSITIVE TRAPS, and how each is handled:
//
//   * CHROME. Nav, header, footer and sidebar links are not in the graph (contextual links only).
//   * GENERIC ANCHORS. "read more", "learn more", "click here" and the per-language equivalents
//     point everywhere by design; they never count, and neither do conventional account and legal
//     labels ("Log in", "Privacy").
//   * NORM GUARD. Fewer than MIN_PAGES crawled pages skips the rule. An anchor is only reported
//     when one destination takes at least NORM_SHARE of the pages using that anchor, and then only
//     the deviating destinations are listed. An even split has no norm to deviate from.
//   * ONE-OFF ANCHORS. A URL is reported for divergent anchors only when MIN_VARIANTS unrelated
//     anchor texts each come from at least MIN_VARIANT_SOURCES source pages.
//   * TARGETS. Only pages that answered 2xx with HTML are judged; the homepage is linked as
//     "Home", the brand and the logo, so it is never judged for divergent anchors.

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { AnchorGraph } from "@squirrelscan/core-contracts";
import { getPathname } from "@squirrelscan/utils";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { frontDoorTest } from "../shared/front-door";
import { isConventionalLinkLabel, normalizeLinkLabel } from "../shared/conventional-link-labels";
import { isGenericInPageLanguage } from "../shared/generic-link-phrases";
import { AnchorGraphBuilder, meaningfulTokens } from "./anchor-mismatch";

const CHECK_NAME = "anchor-target-conflict";

const SKIP_CHECK: CheckResult = {
  name: CHECK_NAME,
  status: "skipped",
  message: "Too few pages to compare anchor text across the site",
};

/** Fewer crawled pages than this and the rule is skipped. */
export const MIN_PAGES = 10;
/** The share of an anchor's source pages the leading destination must take to count as the norm. */
export const NORM_SHARE = 0.7;
/** Unrelated anchor texts a URL needs before it is reported as divergent. */
export const MIN_VARIANTS = 4;
/** Source pages each of those anchor texts must come from. */
export const MIN_VARIANT_SOURCES = 2;
/** Findings at or above this count fail the check; below it the check warns. */
export const FAIL_AT = 10;
// Items listed on the finding; `details.total` carries the real count.
const MAX_ITEMS = 100;
const MAX_EXAMPLES = 5;

// English generic anchors, folded like `normalizeLinkLabel`. Other languages come from the shared
// per-language phrase lists.
const GENERIC_ENGLISH: ReadonlySet<string> = new Set(
  [
    "click here", "here", "read more", "learn more", "more", "link", "this", "this link", "go",
    "continue", "more info", "more information", "see more", "view more", "view all", "see all",
    "details", "view details", "see details", "find out more", "read on", "read the article",
    "read article", "read full article", "read the full story", "get started", "next", "previous",
    "prev", "back",
  ].map(normalizeLinkLabel),
);
const GENERIC_LANGS = ["es", "fr", "de", "pt", "it", "nl", "ru", "ja", "zh", "ko"] as const;

function isGenericAnchor(text: string): boolean {
  const folded = normalizeLinkLabel(text);
  if (folded === "" || !/\p{L}/u.test(folded)) return true;
  if (GENERIC_ENGLISH.has(folded) || isConventionalLinkLabel(folded)) return true;
  return GENERIC_LANGS.some((lang) => isGenericInPageLanguage(text, lang));
}

interface AnchorUse {
  text: string;
  // target -> source pages (insertion order is graph order: sorted by target, then source)
  targets: Map<string, Set<string>>;
  sources: Set<string>;
}

interface TargetUse {
  // anchor key -> display text and source pages
  anchors: Map<string, { text: string; sources: Set<string> }>;
}

interface Conflict {
  kind: "anchor" | "target";
  id: string;
  label: string;
  sourcePages: string[];
  meta: Record<string, unknown>;
}

function isJudgeableTarget(graph: AnchorGraph, target: string): boolean {
  const page = graph.pages.get(target);
  if (!page || page.status === null || page.status < 200 || page.status > 299) return false;
  return !page.contentType || /html/i.test(page.contentType);
}

function clipPath(url: string): string {
  const path = getPathname(url);
  return path === "" ? url : path;
}

/** Group texts that share a word; returns the clusters as lists of anchor keys. */
function clusterByWord(texts: readonly { key: string; text: string }[]): string[][] {
  const parent = new Map<string, string>(texts.map((t) => [t.key, t.key]));
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const byWord = new Map<string, string>();
  for (const { key, text } of texts) {
    for (const word of meaningfulTokens(text)) {
      const seen = byWord.get(word);
      if (seen === undefined) byWord.set(word, key);
      else parent.set(find(key), find(seen));
    }
  }
  const clusters = new Map<string, string[]>();
  for (const { key } of texts) {
    const root = find(key);
    const list = clusters.get(root);
    if (list) list.push(key);
    else clusters.set(root, [key]);
  }
  return [...clusters.values()];
}

/** Judge the graph; shared by both paths so their output is byte-identical. */
export function evaluateAnchorConflicts(
  graph: AnchorGraph,
  baseUrl: string,
  entryUrls: readonly string[],
): CheckResult {
  if (graph.pages.size < MIN_PAGES) return SKIP_CHECK;
  const isFrontDoor = frontDoorTest(baseUrl, entryUrls);

  const byAnchor = new Map<string, AnchorUse>();
  const byTarget = new Map<string, TargetUse>();
  let judgedAnchors = 0;
  for (const pair of graph.pairs) {
    if (!isJudgeableTarget(graph, pair.target)) continue;
    for (let i = 0; i < pair.texts.length; i++) {
      const text = pair.texts[i]!;
      if (isGenericAnchor(text)) continue;
      const key = pair.textKeys[i]!;
      let use = byAnchor.get(key);
      if (!use) {
        byAnchor.set(key, (use = { text, targets: new Map(), sources: new Set() }));
        judgedAnchors += 1;
      }
      let srcs = use.targets.get(pair.target);
      if (!srcs) use.targets.set(pair.target, (srcs = new Set()));
      srcs.add(pair.source);
      use.sources.add(pair.source);

      let tuse = byTarget.get(pair.target);
      if (!tuse) byTarget.set(pair.target, (tuse = { anchors: new Map() }));
      let a = tuse.anchors.get(key);
      if (!a) tuse.anchors.set(key, (a = { text, sources: new Set() }));
      a.sources.add(pair.source);
    }
  }

  if (judgedAnchors === 0) {
    return {
      name: CHECK_NAME,
      status: "skipped",
      message: "No non-generic contextual anchor text to compare",
      details: { droppedPairs: graph.droppedPairs },
    };
  }

  const conflicts: Conflict[] = [];

  // One anchor text, several destinations: the leading destination is the norm, the rest deviate.
  for (const use of byAnchor.values()) {
    if (use.targets.size < 2) continue;
    const ranked = [...use.targets.entries()].sort(
      (a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1),
    );
    const [norm, normSources] = ranked[0]!;
    if (normSources.size / use.sources.size < NORM_SHARE) continue;
    const deviants = ranked.slice(1);
    const examples = [...new Set(deviants.flatMap(([, s]) => [...s]))].slice(0, MAX_EXAMPLES);
    conflicts.push({
      kind: "anchor",
      id: `anchor: ${use.text}`,
      label: `"${use.text}" points at ${use.targets.size} URLs: ${clipPath(norm)} (${normSources.size} of ${use.sources.size} pages) but also ${deviants
        .map(([t, s]) => `${clipPath(t)} (${s.size})`)
        .join(", ")}`,
      sourcePages: examples,
      meta: { anchor: use.text, norm, deviants: deviants.map(([t]) => t) },
    });
  }

  // One URL, several unrelated anchor texts.
  for (const [target, tuse] of byTarget) {
    if (isFrontDoor(target)) continue;
    const supported = [...tuse.anchors.entries()]
      .filter(([, a]) => a.sources.size >= MIN_VARIANT_SOURCES)
      .map(([key, a]) => ({ key, text: a.text }));
    if (supported.length < MIN_VARIANTS) continue;
    const clusters = clusterByWord(supported);
    if (clusters.length < MIN_VARIANTS) continue;
    // One representative per cluster: the text with the most source pages.
    const reps = clusters.map((keys) => {
      const best = keys
        .map((k) => tuse.anchors.get(k)!)
        .sort((a, b) => b.sources.size - a.sources.size || (a.text < b.text ? -1 : 1))[0]!;
      return best;
    });
    const examples = [...new Set(reps.flatMap((r) => [...r.sources]))].slice(0, MAX_EXAMPLES);
    conflicts.push({
      kind: "target",
      id: `target: ${target}`,
      label: `${clipPath(target)} is linked with ${reps.length} unrelated anchor texts: ${reps
        .slice(0, 6)
        .map((r) => `"${r.text}"`)
        .join(", ")}`,
      sourcePages: examples,
      meta: { target, anchors: reps.map((r) => r.text) },
    });
  }

  const details = {
    judgedAnchors,
    droppedPairs: graph.droppedPairs,
    total: conflicts.length,
    anchorConflicts: conflicts.filter((c) => c.kind === "anchor").length,
    targetConflicts: conflicts.filter((c) => c.kind === "target").length,
  };

  if (conflicts.length === 0) {
    return {
      name: CHECK_NAME,
      status: "pass",
      message: "Each anchor text points at one page and each page keeps a consistent anchor",
      details,
    };
  }

  return {
    name: CHECK_NAME,
    status: conflicts.length >= FAIL_AT ? "fail" : "warn",
    message: `${details.anchorConflicts} anchor text(s) point at different pages and ${details.targetConflicts} page(s) are linked with unrelated anchor texts`,
    items: conflicts.slice(0, MAX_ITEMS).map((c) => ({
      id: c.id,
      label: c.label,
      sourcePages: c.sourcePages,
      meta: c.meta,
    })),
    details,
    value: conflicts
      .slice(0, 5)
      .map((c) => c.label)
      .join("\n"),
  };
}

export const anchorTargetConflictRule: Rule = {
  meta: {
    id: "links/anchor-target-conflict",
    name: "Anchor Target Conflict",
    description:
      "Detects one anchor text that points at several different pages, and one page linked with several unrelated anchor texts",
    solution:
      "When 'Pricing' goes to /pricing from most pages and to /plans from a few, readers, search engines and agents cannot tell which page the label means, and the ranking signal the link carries is split. Point every link with the same text at one page, or change the text so it names the page it really goes to. A page linked with many unrelated anchor texts has no clear topic to rank for: pick the label that describes it and use it consistently. Generic text such as 'read more' is ignored here, and so are navigation, header, footer and sidebar links.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 3,
    optionsSchema: z.object({}),
  },

  run(ctx: RuleContext): RuleResult {
    const baseUrl = ctx.site?.baseUrl || "";
    const entryUrls = ctx.site?.entryUrls ?? [];

    if (ctx.siteQuery) {
      const graph = ctx.siteQuery.anchorGraph?.();
      if (!graph) return { checks: [SKIP_CHECK] };
      return { checks: [evaluateAnchorConflicts(graph, baseUrl, entryUrls)] };
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length < MIN_PAGES) return { checks: [SKIP_CHECK] };

    const builder = new AnchorGraphBuilder(
      undefined,
      undefined,
      new Set(pages.map((page) => normalizePageUrl(page.url))),
    );
    for (const page of pages) {
      builder.addPage(page.url, {
        title: page.parsed.meta?.title,
        h1: page.parsed.h1?.texts,
        links: page.parsed.links,
        status: page.statusCode,
        contentType: page.headers?.["content-type"] ?? page.headers?.["Content-Type"],
      });
    }
    return { checks: [evaluateAnchorConflicts(builder.build(), baseUrl, entryUrls)] };
  },
};
