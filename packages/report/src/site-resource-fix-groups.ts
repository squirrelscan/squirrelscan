// One build defect, one line — for resources rather than DOM components.
//
// `perf/source-maps` is page-scope, so a template site with one shared bundle
// emits the identical "4 potential source map(s) detected" warn on every page
// it crawls. A customer report (#2341) carried dozens of them for what is one
// fact: the build ships maps. The rule is right about every page; the REPORT
// was wrong about how many problems that is.
//
// The grouping question for a resource is not the one `component-fix-groups`
// asks. A component is identified by DOM shape and located by a region and a
// locator; a source map has none of those. What it has is an identity (its URL)
// and the set of pages that reference it, so this groups on exactly that: map
// URLs whose PAGE SETS are identical are one shipped artifact and one repair.
//
// Grouping by the page set, rather than by "appears on most pages", is what
// keeps a section bundle honest. A map on 12 of 87 pages has a different page
// set from the site-wide four, so it lands in its own unit with its own exact
// count instead of being absorbed into a claim about 87 pages.

import type { SiteResourceOccurrence } from "@squirrelscan/core-contracts";
import type { GroupedCheck, GroupedRule } from "./grouping";

/**
 * A set of shared resources that every one of `affectedPages` references, and
 * that no other page does.
 */
export interface SiteResourceFixGroup {
  /** Stable within a report: rule, check and the group's position under it. */
  id: string;
  ruleId: string;
  checkName: string;
  checkStatus: GroupedCheck["status"];
  kind: SiteResourceOccurrence["kind"];
  siteOrigin: string;
  /** Every distinct resource key in the group, sorted. Never sampled. */
  resourceKeys: string[];
  /** Pages referencing exactly this key set, sorted. Never sampled. */
  affectedPages: string[];
  affectedPageCount: number;
}

/** Codepoint order, so two machines serialize one report identically. */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Group one check's occurrences into units of "same resources, same pages".
 *
 * Origin is part of the bucket key before anything else: two origins in one
 * crawl are two builds, and a unit spanning both would promise a single fix
 * that only reaches one of them.
 */
function groupsForCheck(
  ruleId: string,
  check: GroupedCheck,
  occurrences: readonly SiteResourceOccurrence[],
): SiteResourceFixGroup[] {
  // (origin, kind) -> key -> pages. The page set is what decides the grouping,
  // so it is built first and completely; nothing is emitted until every
  // occurrence has been seen, which is what makes the result order-invariant.
  const pagesByResource = new Map<string, Map<string, Set<string>>>();
  for (const occurrence of occurrences) {
    const scope = `${occurrence.siteOrigin}\u0000${occurrence.kind}`;
    let byKey = pagesByResource.get(scope);
    if (!byKey) {
      byKey = new Map<string, Set<string>>();
      pagesByResource.set(scope, byKey);
    }
    const pages = byKey.get(occurrence.key);
    if (pages) pages.add(occurrence.pageUrl);
    else byKey.set(occurrence.key, new Set([occurrence.pageUrl]));
  }

  const groups: SiteResourceFixGroup[] = [];
  // Scopes in sorted order rather than insertion order: insertion order is the
  // crawl's, which is concurrency-dependent, and a report that reorders itself
  // between two runs of the same site churns every diff (#150).
  for (const scope of [...pagesByResource.keys()].sort(byCodepoint)) {
    const byKey = pagesByResource.get(scope)!;
    const [siteOrigin, kind] = scope.split("\u0000") as [string, SiteResourceOccurrence["kind"]];
    // Page-set signature -> the resource keys sharing it.
    const buckets = new Map<string, { pages: string[]; keys: string[] }>();
    for (const key of [...byKey.keys()].sort(byCodepoint)) {
      const pages = [...byKey.get(key)!].sort(byCodepoint);
      const signature = pages.join("\u0000");
      const bucket = buckets.get(signature);
      if (bucket) bucket.keys.push(key);
      else buckets.set(signature, { pages, keys: [key] });
    }
    // Widest reach first: the site-wide bundle is the headline, and a section
    // bundle reads as the exception to it rather than the other way round.
    // Ties break on the signature so the order is total, never insertion-order.
    const ordered = [...buckets.entries()].sort(
      ([leftSig, left], [rightSig, right]) =>
        right.pages.length - left.pages.length || byCodepoint(leftSig, rightSig),
    );
    for (const [, bucket] of ordered) {
      groups.push({
        id: `${ruleId}\u0000${check.name}\u0000${siteOrigin}\u0000${bucket.keys.join(",")}`,
        ruleId,
        checkName: check.name,
        checkStatus: check.status,
        kind,
        siteOrigin,
        resourceKeys: bucket.keys,
        affectedPages: bucket.pages,
        affectedPageCount: bucket.pages.length,
      });
    }
  }
  return groups;
}

/**
 * Every site-resource unit under a rule, across its checks.
 *
 * Returns ALL units, single-page ones included. Deciding which earn a line is
 * the presentation layer's job (`isRenderableSiteResourceGroup`), and JSON keeps
 * the rest as evidence — the same split `component-fix-groups` draws.
 */
export function siteResourceFixGroups(rule: GroupedRule): SiteResourceFixGroup[] {
  const groups: SiteResourceFixGroup[] = [];
  for (const check of rule.checks) {
    const occurrences = (check as { siteResourceOccurrences?: SiteResourceOccurrence[] })
      .siteResourceOccurrences;
    if (!occurrences?.length) continue;
    groups.push(...groupsForCheck(rule.id, check, occurrences));
  }
  return groups;
}
