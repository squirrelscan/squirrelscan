// The sentence, and the arithmetic that lets it REPLACE output rather than add
// to it.
//
// Same contract as `component-presentation`: one builder, called by llm,
// markdown, html, text, console and json, so the six surfaces cannot drift and
// no renderer decides any wording of its own. Adding a line above the existing
// dozens would have made the report longer, which is the opposite of the bug —
// the unit only earns its place by taking the per-page lines' place.

import type { CheckResult, SiteResourceOccurrence } from "@squirrelscan/core-contracts";
import { checkAffectedPages, ruleAffectedPages } from "./affected-pages";
import { formatPageSample, type FixCoverage } from "./component-presentation";
import type { GroupedRule } from "./grouping";
import type { SiteResourceFixGroup } from "./site-resource-fix-groups";
import { siteResourceFixGroups } from "./site-resource-fix-groups";

/** Resource names to print before the rest become a count. */
export const SITE_RESOURCE_MAX_KEYS = 3;

/**
 * Whether a unit earns a line of its own.
 *
 * A one-page unit is not a site-level defect. "Fix once in the build, 1 page"
 * says nothing the per-page check line did not already say, and the issue is
 * explicit that a map seen on one page stays page-scoped. JSON keeps them.
 */
export function isRenderableSiteResourceGroup(group: SiteResourceFixGroup): boolean {
  return group.affectedPageCount >= 2;
}

export interface SiteResourceCoverage {
  /** Units that will be printed, widest reach first. */
  groups: SiteResourceFixGroup[];
  /** All units, single-page ones included; JSON's view. */
  allGroups: SiteResourceFixGroup[];
  /** Pages every printed unit accounts for, across the rule's checks. */
  coveredPages: Set<string>;
}

/**
 * The units for a rule, and which of its pages they account for.
 *
 * A page counts as covered only when EVERY check of the rule that names it is
 * covered by that check's own units. `perf/source-maps` emits `source-maps-
 * exposed` and `source-maps-inline`, and a page carrying both would otherwise
 * have its inline finding silently swallowed by the exposed finding's unit —
 * suppressing a defect nothing else states is strictly worse than repeating one.
 */
export function ruleSiteResourceCoverage(rule: GroupedRule): SiteResourceCoverage {
  const allGroups = siteResourceFixGroups(rule);
  const groups = allGroups.filter(isRenderableSiteResourceGroup);
  if (groups.length === 0) return { groups: [], allGroups, coveredPages: new Set() };

  // Every resource a PRINTED unit speaks for. Coverage is decided per
  // OCCURRENCE, not per page: a page can carry the site-wide bundle and a
  // one-off map of its own, and the site-wide unit says nothing about the
  // one-off. Claiming the page there would delete the only line that mentions
  // it, which is worse than the duplication this feature removes.
  const spokenFor = new Set<string>();
  for (const group of groups) {
    for (const key of group.resourceKeys) {
      spokenFor.add(`${group.checkName}\u0000${group.siteOrigin}\u0000${group.kind}\u0000${key}`);
    }
  }

  // A page is covered for a check when every occurrence that check recorded on
  // it belongs to a printed unit.
  const coveredByCheck = new Map<string, Set<string>>();
  for (const check of rule.checks) {
    const occurrences = (check as { siteResourceOccurrences?: SiteResourceOccurrence[] })
      .siteResourceOccurrences;
    if (!occurrences?.length) continue;
    const unresolved = new Set<string>();
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
      seen.add(occurrence.pageUrl);
      const id = `${check.name}\u0000${occurrence.siteOrigin}\u0000${occurrence.kind}\u0000${occurrence.key}`;
      if (!spokenFor.has(id)) unresolved.add(occurrence.pageUrl);
    }
    const covered = new Set<string>();
    for (const page of seen) if (!unresolved.has(page)) covered.add(page);
    coveredByCheck.set(check.name, covered);
  }

  const coveredPages = new Set<string>();
  for (const page of ruleAffectedPages(rule.checks as unknown as CheckResult[])) {
    let claimedByEveryCheck = true;
    for (const check of rule.checks) {
      if (!checkAffectedPages(check as unknown as CheckResult).has(page)) continue;
      if (!coveredByCheck.get(check.name)?.has(page)) {
        claimedByEveryCheck = false;
        break;
      }
    }
    if (claimedByEveryCheck) coveredPages.add(page);
  }
  return { groups, allGroups, coveredPages };
}

/**
 * Narrow an existing component `FixCoverage` by what the resource units account
 * for.
 *
 * The two features answer the same question about different evidence, and a
 * renderer must not print a page as "not attributed to a shared component" when
 * a resource unit has just named it. Composing here rather than in each renderer
 * is what keeps the six surfaces' page arithmetic identical.
 */
export function withSiteResourceCoverage(
  coverage: FixCoverage,
  resources: SiteResourceCoverage,
  rule: GroupedRule,
): FixCoverage {
  if (resources.groups.length === 0) return coverage;
  // `mode: "none"` carries no page list of its own, so the remainder has to be
  // recomputed from the rule rather than filtered from an empty array.
  const base =
    coverage.mode === "none"
      ? [...ruleAffectedPages(rule.checks as unknown as CheckResult[])]
      : coverage.uncoveredPages;
  const uncoveredPages = base
    .filter((page) => !resources.coveredPages.has(page))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // A rule whose pages are unknown stays partial rather than claiming that
  // units accounted for a page set nobody could enumerate — the same guard
  // `ruleFixCoverage` applies.
  const known = ruleAffectedPages(rule.checks as unknown as CheckResult[]).size > 0;
  return {
    mode: known && uncoveredPages.length === 0 ? "full" : "partial",
    groups: coverage.groups,
    uncoveredPages,
  };
}

/** `https://x.com/assets/app.9f3.js.map` -> `app.9f3.js.map`. */
export function resourceName(key: string): string {
  try {
    const path = new URL(key).pathname;
    return path.split("/").filter(Boolean).pop() ?? key;
  } catch {
    return key.split("/").filter(Boolean).pop() ?? key;
  }
}

/** "source map" / "source maps", by kind and count. */
function resourceNoun(kind: SiteResourceFixGroup["kind"], count: number): string {
  if (kind === "source-map") return count === 1 ? "source map" : "source maps";
  return count === 1 ? "resource" : "resources";
}

/**
 * "4 source maps exposed by shared bundles (app.js.map, vendor.js.map, +2 more)".
 *
 * The count is every distinct key in the unit, not the bounded name list, and
 * the remainder is stated rather than dropped — the truncation this feature
 * exists to remove was an unlabelled one.
 */
export function describeSiteResourceDefect(group: SiteResourceFixGroup): string {
  const total = group.resourceKeys.length;
  const shown = group.resourceKeys.slice(0, SITE_RESOURCE_MAX_KEYS).map(resourceName);
  const remainder = total - shown.length;
  const names = remainder > 0 ? `${shown.join(", ")}, +${remainder} more` : shown.join(", ");
  if (group.kind === "source-map") {
    return `${total} ${resourceNoun(group.kind, total)} exposed by shared bundles (${names})`;
  }
  return `${total} shared ${resourceNoun(group.kind, total)} (${names})`;
}

/**
 * The single actionable line a resource unit exists to produce.
 *
 * "in the build" rather than a DOM region: nothing here is located on a page,
 * and the repair is in whatever produced the bundle. The page sample is bounded
 * and explicitly labelled by the shared `formatPageSample`, so a reader never
 * mistakes the sample size for the affected-page count.
 */
export function siteResourceFixLine(
  group: SiteResourceFixGroup,
  limit: number,
  format: (page: string) => string,
): string {
  const shown = group.affectedPages.slice(0, limit).map(format);
  const pages = formatPageSample({
    shown,
    total: group.affectedPageCount,
    hasMore: group.affectedPageCount > shown.length,
  });
  return `Fix once in the build: ${describeSiteResourceDefect(group)}, ${pages}`;
}
