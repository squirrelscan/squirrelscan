// Bounded complete-store scoring fold (#1873).
//
// #1023 R-D3 made the chunked publish score off the COMPLETE per-page findings,
// but by MATERIALIZING them: load every page_findings row → reconstruct every
// per-page CheckResult → build the union map → score it. Every one of those steps
// holds the whole audit at once, so a 43,470-finding publish killed the 128 MB API
// isolate (`exceededMemory`, #1873) after the audit had already been paid for.
//
// This module computes the SAME score from the SAME evidence with memory bounded
// by (rules × checks) instead of by finding count: findings arrive ONE PAGE at a
// time, are folded into per-rule `IssueTally` (the #1021 streaming machinery), and
// are dropped. `calculateHealthScoreFromTallies` over the result is the
// byte-identical twin of `calculateHealthScore` over the materialized union — see
// complete-store-parity.test.ts, which asserts exactly that on every fixture.
//
// THE INVARIANT THAT MAKES IT BYTE-IDENTICAL: `addChecksToTally`'s item-aware keys
// are `${checkName}\u0000${pageUrl}`, and its per-key state (the fail-unit sum, its
// ISSUE_PENALTY_ITEM_CAP clamp, the `details.additional` max, the distinct warn-key
// count) is LOCAL TO ONE CALL. Folding incrementally therefore matches folding the
// concatenated array if and only if no (checkName, pageUrl) bucket is ever split
// across two calls. Two consequences, both load-bearing:
//   1. `findingPages` MUST yield a page's findings whole (one page per item), never
//      half a page — a split page would clamp and count one bucket twice;
//   2. carried findings on a page that ALSO has fresh findings are folded together
//      WITH that page, not in the trailing carried pass. In complete mode a carried
//      finding normally sits on an un-crawled page (the merge resolves anything on
//      a crawled page), so the overlap only arises for a page missing from the
//      crawled set — but "normally" is not "never", and the cost of handling it is
//      one map lookup.

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import { reconstructPageRuleChecks } from "./reconstruct";
import {
  addChecksToTally,
  carriedFindingToCheck,
  emptyTally,
  type CarriedFinding,
  type RuleTally,
} from "./scoring";
import type { SkippedPassCounts } from "./stream-findings";

/**
 * This audit's complete findings, delivered a page at a time. A yielded array may
 * hold several WHOLE pages, but a single page must never be SPLIT across two
 * items — that is what the fold's byte-identity rests on (see the module header).
 * The API implements this as a keyset cursor over page_findings that buffers to
 * page boundaries, so no more than one page's rows are resident at a time.
 */
export type FindingPageSource = AsyncIterable<readonly PageFindingRecord[]>;

export interface CompleteStoreTallyInput {
  /**
   * The published (sampled/slimmed) shell's `ruleResults` — the source of rule
   * META, the set of rules that ran, and SITE-scope rules' checks (which are
   * scored verbatim; findings never carry them). Page-scope rules' checks are
   * ignored here: they are superseded by the complete findings.
   */
  ruleResults: Record<string, { meta: RuleRunResult["meta"]; checks: CheckResult[] }>;
  /** Complete per-(page,rule,check,locator) findings, page at a time. */
  findingPages: FindingPageSource;
  /**
   * Full crawled-URL set (NORMALIZED) for this run — the `syntheticPassCount`
   * denominator, and the set a finding's page must be in to count as DIRTY.
   */
  crawledUrls: Set<string>;
  /** (#1305) Passing sibling checks on dirty pages; see reconstructCompleteResults. */
  skippedPassCounts?: SkippedPassCounts;
  /**
   * Normalized URLs that returned 404/410 this run. Their fresh checks are NOT
   * scored: the page is gone, so it is not one of the "known non-removed" pages
   * the union covers. This mirrors the materialized path's `freshForUnion` filter
   * in runCloudSmartAudits — a removed page can still carry ingested findings (the
   * crawl rendered it before the status was known), and folding those would count
   * a deleted page against the score.
   */
  removedUrls?: Set<string>;
  /** Issues on un-crawled, still-active pages carried forward by the merge. */
  carriedFindings: readonly CarriedFinding[];
  /** Normalized URLs of pages carried forward (un-crawled but still active). */
  carriedPageUrls: Set<string>;
  /** ruleId -> meta for rules absent from `ruleResults` (carried-only rules). */
  ruleMetaIndex: Map<string, RuleRunResult["meta"]>;
}

/**
 * Fold this audit's complete findings + the merge's carried findings into per-rule
 * tallies — the bounded twin of
 * `buildScoringResultsFromMerged({ freshResults: reconstructCompleteResults(…), … })`.
 *
 * MUST run BEFORE the merge's persistence writes: `computeMerge` stamps RESOLVED
 * rows with this run's crawlId, so a fold that ran after them would read a
 * just-resolved finding back as fresh evidence of failure.
 */
export async function foldCompleteStoreTallies(
  input: CompleteStoreTallyInput
): Promise<Map<string, RuleTally>> {
  const {
    ruleResults,
    findingPages,
    crawledUrls,
    skippedPassCounts,
    carriedFindings,
    carriedPageUrls,
    ruleMetaIndex,
    removedUrls,
  } = input;

  const tallies = new Map<string, RuleTally>();
  const metaOf = (ruleId: string): RuleRunResult["meta"] | undefined =>
    ruleResults[ruleId]?.meta ?? ruleMetaIndex.get(ruleId);
  const entryFor = (ruleId: string, meta: RuleRunResult["meta"]): RuleTally => {
    let entry = tallies.get(ruleId);
    if (!entry) {
      entry = { meta, tally: emptyTally() };
      tallies.set(ruleId, entry);
    }
    return entry;
  };
  const advisory = (meta: RuleRunResult["meta"]): boolean => meta.severity === "info";

  // Carried findings indexed two ways, both bounded by the carried set (the
  // findings a previous audit left open on pages this run did not re-crawl):
  //  - byPage: to fold a page's carried checks in the SAME call as its fresh ones;
  //  - pagesByRule: the clean-carried-pass denominator, which must survive the
  //    page pass (it counts every carried page a rule has NO finding on).
  const carriedByPage = new Map<string, Map<string, CarriedFinding[]>>();
  const carriedPagesByRule = new Map<string, Set<string>>();
  for (const f of carriedFindings) {
    const meta = metaOf(f.ruleId);
    // Unknown rule — cannot be scored (no meta); site-scope rules never carry
    // per-page findings. Both mirror buildScoringResultsFromMerged's guards.
    if (meta?.scope !== "page") continue;
    let byRule = carriedByPage.get(f.normalizedUrl);
    if (!byRule) {
      byRule = new Map();
      carriedByPage.set(f.normalizedUrl, byRule);
    }
    const list = byRule.get(f.ruleId);
    if (list) list.push(f);
    else byRule.set(f.ruleId, [f]);
    let pages = carriedPagesByRule.get(f.ruleId);
    if (!pages) {
      pages = new Set();
      carriedPagesByRule.set(f.ruleId, pages);
    }
    pages.add(f.normalizedUrl);
  }

  // Pages this run has a finding on, per rule — the fresh-clean denominator's
  // subtrahend. Counted (not collected) so it stays O(rules), and counted only for
  // CRAWLED pages, matching reconstructCompleteResults' `crawledUrls \ failingPages`.
  const dirtyPagesByRule = new Map<string, number>();

  /** Fold ONE page: its reconstructed fresh checks plus any carried findings that
   * sit on the same page, in a single addChecksToTally call per rule so no
   * (checkName, pageUrl) bucket is ever split. */
  const foldPage = (normalizedUrl: string, page: readonly PageFindingRecord[]): void => {
    const freshByRule = reconstructPageRuleChecks(page);
    const carriedForPage = carriedByPage.get(normalizedUrl);
    // Consumed: this page's carried findings are folded here, so the trailing
    // carried pass must not fold them a second time.
    if (carriedForPage) carriedByPage.delete(normalizedUrl);
    const isCrawled = crawledUrls.has(normalizedUrl);
    // 404/410 this run: the page is gone, so its fresh checks leave the union
    // (mirroring freshForUnion). Carried findings are folded regardless — the
    // merge stales anything on a removed page, so in practice there are none, but
    // the shape then matches the materialized path rather than relying on that.
    const isRemoved = removedUrls?.has(normalizedUrl) ?? false;

    const ruleIds = new Set<string>(freshByRule.keys());
    if (carriedForPage) for (const ruleId of carriedForPage.keys()) ruleIds.add(ruleId);

    for (const ruleId of ruleIds) {
      const meta = metaOf(ruleId);
      // A finding whose rule is absent from the shell cannot be scored (no meta);
      // a site-scope rule never has per-page findings. Mirrors the unknown-rule
      // guards in reconstructCompleteResults / buildScoringResultsFromMerged.
      if (meta?.scope !== "page") continue;
      const fresh = isRemoved ? undefined : freshByRule.get(ruleId);
      const carried = carriedForPage?.get(ruleId);
      const checks: CheckResult[] = carried
        ? [...(fresh ?? []), ...carried.map((f) => carriedFindingToCheck(f, normalizedUrl))]
        : (fresh ?? []);
      if (checks.length === 0) continue;
      addChecksToTally(entryFor(ruleId, meta).tally, checks, advisory(meta), 0);
      if (fresh && fresh.length > 0 && isCrawled) {
        dirtyPagesByRule.set(ruleId, (dirtyPagesByRule.get(ruleId) ?? 0) + 1);
      }
    }
  };

  for await (const batch of findingPages) {
    if (batch.length === 0) continue;
    // Re-group by page rather than trusting a batch to hold exactly one. What the
    // invariant needs is that a page is never SPLIT across two items; a batch
    // carrying several WHOLE pages is harmless, and grouping here means such a
    // producer cannot silently attribute one page's findings to another page's
    // crawled/removed state.
    for (const [normalizedUrl, page] of groupByPage(batch)) foldPage(normalizedUrl, page);
  }

  // Trailing pass 1 — every rule the shell carries.
  for (const [ruleId, r] of Object.entries(ruleResults)) {
    if (r.meta.scope !== "page") {
      // Site-scope rule: findings never carry these (flattenChecks skips
      // no-pageUrl checks), so it is scored from the shell's checks verbatim —
      // the same ones reconstructCompleteResults passes through.
      addChecksToTally(entryFor(ruleId, r.meta).tally, r.checks, advisory(r.meta), 0);
      continue;
    }
    const entry = entryFor(ruleId, r.meta);
    // Fresh clean pages: crawled pages with NO finding for this rule. See the
    // SKIP-AS-PASS approximation documented on reconstructCompleteResults — a page
    // the rule skipped has no finding and is counted here as a pass, exactly as
    // the #918 carried-clean model already does.
    const clean = crawledUrls.size - (dirtyPagesByRule.get(ruleId) ?? 0);
    // (#1305) Passing SIBLING checks on dirty pages, with the round-5 SECURITY
    // CLAMP: skippedPassCounts is untrusted finalize-body input, and an inflated
    // count added straight into the pass numerator would drive a genuinely-failing
    // rule's passRate toward 1.0 — the exact #1179 integrity class this feature
    // fixes. A check cannot pass on more pages than were crawled, so bounding the
    // per-rule sum to the crawl universe only ever reduces an over-count.
    let skippedPasses = 0;
    const perCheck = skippedPassCounts?.[ruleId];
    if (perCheck) for (const n of Object.values(perCheck)) skippedPasses += n;
    skippedPasses = Math.min(skippedPasses, crawledUrls.size);
    addChecksToTally(
      entry.tally,
      [],
      advisory(r.meta),
      clean + skippedPasses + cleanCarriedPasses(ruleId, carriedPageUrls, carriedPagesByRule)
    );
  }

  // Trailing pass 2 — carried findings whose page was never streamed (the normal
  // case: an un-crawled page), plus carried-only rules absent from the shell.
  for (const [normalizedUrl, byRule] of carriedByPage) {
    for (const [ruleId, findings] of byRule) {
      const meta = metaOf(ruleId)!; // indexed above only when page-scope meta exists
      addChecksToTally(
        entryFor(ruleId, meta).tally,
        findings.map((f) => carriedFindingToCheck(f, normalizedUrl)),
        advisory(meta),
        0
      );
    }
  }
  // Carried-only rules (page-scope, absent from the shell) get no fresh-clean
  // count — reconstructCompleteResults never runs for them — but they DO get the
  // carried-clean passes buildScoringResultsFromMerged gives them.
  for (const ruleId of carriedPagesByRule.keys()) {
    if (ruleResults[ruleId]) continue; // already handled in trailing pass 1
    const meta = metaOf(ruleId);
    if (meta?.scope !== "page") continue;
    addChecksToTally(
      entryFor(ruleId, meta).tally,
      [],
      advisory(meta),
      cleanCarriedPasses(ruleId, carriedPageUrls, carriedPagesByRule)
    );
  }

  return tallies;
}

/** Split a batch of findings into per-page groups, preserving arrival order. */
function groupByPage(
  batch: readonly PageFindingRecord[]
): Map<string, PageFindingRecord[]> {
  const byPage = new Map<string, PageFindingRecord[]>();
  for (const f of batch) {
    const rows = byPage.get(f.normalizedUrl);
    if (rows) rows.push(f);
    else byPage.set(f.normalizedUrl, [f]);
  }
  return byPage;
}

/**
 * Carried pages with NO finding for this rule — the carried half of the pass-ratio
 * denominator (#918). Folded to a count, never to synthetic "pass" CheckResults,
 * so a partial re-audit of a large site cannot materialize
 * (page-scope rules × carried pages) objects.
 */
function cleanCarriedPasses(
  ruleId: string,
  carriedPageUrls: Set<string>,
  carriedPagesByRule: Map<string, Set<string>>
): number {
  const dirty = carriedPagesByRule.get(ruleId);
  if (!dirty || dirty.size === 0) return carriedPageUrls.size;
  let clean = 0;
  for (const url of carriedPageUrls) if (!dirty.has(url)) clean++;
  return clean;
}
