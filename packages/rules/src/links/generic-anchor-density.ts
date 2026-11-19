// links/generic-anchor-density - generic anchor text as a site-wide ratio (repo#1387)
//
// One "read more" is fine. A site where most internal anchors say "click here" or "read more" has
// a discoverability problem for readers and agents that no single page shows, so this rule
// measures the corpus: generic anchors / internal content anchors, across every crawled page.
//
// Decisions:
//   * The phrase list is the shared core (`shared/generic-anchor-phrases.ts`) that
//     `links/anchor-text` and `a11y/link-text` also use, so the three never disagree. Whole-text
//     matches only, and a conventional label ("sign in", "privacy") is never generic.
//   * Counted anchors are internal, dofollow, non-chrome and carry text. Nav and footer links repeat
//     on every page and would swamp the editorial ratio; empty anchors are `links/anchor-text`'s.
//   * Too few anchors to judge (`minAnchors`) is a skipped check, never a pass.
//   * Both paths feed the same `countGenericAnchors` the same links: the legacy path reads
//     `site.pages`, the streaming path reads `siteQuery.genericAnchorCounts()`.

import { z } from "zod";

import { countGenericAnchors, type GenericAnchorCount } from "../shared/generic-anchor-phrases";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const CHECK = "generic-anchor-density";
const MAX_WORST = 10;

function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function evaluate(
  perPage: Iterable<[string, GenericAnchorCount]>,
  minAnchors: number,
  warnRatio: number,
  failRatio: number
): CheckResult {
  let generic = 0;
  let total = 0;
  const offenders: Array<{ url: string; generic: number; total: number }> = [];
  for (const [url, counts] of perPage) {
    generic += counts.generic;
    total += counts.total;
    if (counts.generic > 0) offenders.push({ url, ...counts });
  }

  if (total < minAnchors) {
    return {
      name: CHECK,
      status: "skipped",
      message: `Only ${total} internal content anchor(s) crawled, fewer than the ${minAnchors} needed to judge generic anchor density`,
      details: { totalAnchors: total, minAnchors },
    };
  }

  const ratio = generic / total;
  const details = { genericAnchors: generic, totalAnchors: total, ratio: Math.round(ratio * 1000) / 1000 };
  if (ratio < warnRatio) {
    return {
      name: CHECK,
      status: "pass",
      message: `${percent(ratio)} of internal anchors are generic (${generic} of ${total}), below the ${percent(warnRatio)} threshold`,
      details,
    };
  }

  offenders.sort((a, b) => b.generic - a.generic || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const worst = offenders.slice(0, MAX_WORST);
  return {
    name: CHECK,
    status: ratio >= failRatio ? "fail" : "warn",
    message: `${percent(ratio)} of internal anchors are generic (${generic} of ${total}), across ${offenders.length} page(s)`,
    items: worst.map((o) => ({
      id: o.url,
      label: `${o.url}: ${o.generic} of ${o.total} anchors are generic`,
    })),
    details: { ...details, pagesAffected: offenders.length },
    value: percent(ratio),
  };
}

export const genericAnchorDensityRule: Rule = {
  meta: {
    id: "links/generic-anchor-density",
    name: "Generic Anchor Density",
    description:
      "Measures how much of the site's internal anchor text is generic (click here, read more) as a site-wide ratio",
    solution:
      "Anchor text is how readers, search engines and coding agents learn what a link leads to. When most internal anchors read 'click here' or 'read more', the site's link graph says nothing about its pages. Replace generic anchors with the name of the destination ('see the pricing plans', 'read the migration guide'), starting with the pages listed. A few generic anchors are fine; this rule only reports when the share crosses the threshold.",
    category: "links",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 3,
    // Check names by outcome class (#1741).
    checks: [
      { name: "generic-anchor-density", outcome: "problem" },
      { name: "generic-anchor-density", outcome: "clean", clears: ["generic-anchor-density"] },
      { name: "generic-anchor-density", outcome: "skipped" },
    ],
    optionsSchema: z.object({
      minAnchors: z
        .number()
        .int()
        .min(1)
        .default(30)
        .describe("Fewest internal content anchors needed to judge the ratio; below it the rule is skipped"),
      warnRatio: z
        .number()
        .min(0)
        .max(1)
        .default(0.2)
        .describe("Share of generic anchors at or above which the rule warns"),
      failRatio: z
        .number()
        .min(0)
        .max(1)
        .default(0.4)
        .describe("Share of generic anchors at or above which the rule fails"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const minAnchors = ctx.options.minAnchors as number;
    const warnRatio = ctx.options.warnRatio as number;
    const failRatio = Math.max(ctx.options.failRatio as number, warnRatio);

    if (ctx.siteQuery) {
      const counts = ctx.siteQuery.genericAnchorCounts?.();
      if (!counts) {
        return {
          checks: [
            {
              name: CHECK,
              status: "skipped",
              message: "Per-page generic anchor counts are not available for this crawl",
            },
          ],
        };
      }
      return { checks: [evaluate(counts, minAnchors, warnRatio, failRatio)] };
    }

    const perPage: Array<[string, GenericAnchorCount]> = [];
    for (const page of ctx.site?.pages ?? []) {
      perPage.push([page.url, countGenericAnchors(page.parsed?.links ?? [])]);
    }
    return { checks: [evaluate(perPage, minAnchors, warnRatio, failRatio)] };
  },
};
