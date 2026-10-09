// Bounded complete-store scoring fold (#1873, carried side #1876).
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
//   1. a page's findings MUST arrive whole (one `foldPage` call per page), never
//      half a page — a split page would clamp and count one bucket twice;
//   2. carried findings on a page that ALSO has fresh findings are folded together
//      WITH that page, not in a trailing carried pass. In complete mode a carried
//      finding normally sits on an un-crawled page (the merge resolves anything on
//      a crawled page), so the overlap only arises for a page missing from the
//      crawled set — but "normally" is not "never".
//
// (#1876) The carried side is no longer an array this module indexes. Both halves
// of a page now arrive together from ONE cursor over the site's open findings,
// split by crawl id — which is what makes consequence 2 structural rather than a
// lookup that happens to be there. What this module keeps per rule is two counters,
// never the pages or the findings behind them.
//
// (pub#497) The pages that cursor walks no longer have to include the UNTOUCHED
// ones: pages this run did not crawl, did not see removed, and holds no fresh row
// for. Every prior on such a page is carried unchanged, so what it contributes is a
// function of the stored rows alone, and the store can compute it in one pass
// ({@link UntouchedCarriedAggregate}). They still reach the report through a
// bounded sample ({@link CompleteStoreTallyFold.retainUntouchedSample}), interleaved
// with the touched pages in cursor order. {@link aggregateUntouchedCarried} is the
// reference the store's twin is measured against.

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { DEFAULT_FOLD_LIMITS, foldGroupKey, foldOverflowChecks } from "@squirrelscan/rules/fold";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import { reconstructPageRuleChecks } from "./reconstruct";
import {
  addChecksToTally,
  carriedFindingToCheck,
  emptyTally,
  type CarriedFinding,
  type CarriedUnionSource,
  type PageUrlSet,
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
  carriedPageUrls: PageUrlSet;
  /** ruleId -> meta for rules absent from `ruleResults` (carried-only rules). */
  ruleMetaIndex: Map<string, RuleRunResult["meta"]>;
}

/** Everything {@link createCompleteStoreTallyFold} needs; the findings themselves
 *  arrive through {@link CompleteStoreTallyFold.foldPage}. */
export type CompleteStoreFoldInput = Omit<
  CompleteStoreTallyInput,
  "findingPages" | "carriedFindings"
> & {
  /**
   * (#1876) Also keep a BOUNDED per-rule sample of the carried checks this fold
   * replays, so the report body can be built without a second pass over the
   * carried set — see {@link CompleteStoreTallyFold.carriedUnion}. Off by default:
   * the whole-array driver still builds the union from the carried array itself.
   */
  retainCarriedChecks?: boolean;
  /**
   * (pub#497) Set when untouched pages arrive as a non-empty aggregate: a carried
   * check outside {@link isAggregatableCarriedRow} then throws instead of folding,
   * because the aggregate's subtotal is only exact beside integer terms.
   */
  requireAggregatableCarried?: boolean;
};

/**
 * (pub#497) What the UNTOUCHED pages contribute, folded by the store instead of
 * streamed: pages this run did not crawl, did not see removed, and holds no fresh
 * row for. The merge carries every prior on such a page unchanged, so its share of
 * the score and of the report depends on the stored rows alone.
 *
 * Every number here must equal what {@link CompleteStoreTallyFold.foldPage} would
 * have accumulated from the same rows, carried. {@link aggregateUntouchedCarried}
 * is that computation in JS; a store twin is correct exactly when it agrees with it.
 * A store that cannot read some row exactly as `carriedFindingToCheck` does (a
 * malformed payload, say) streams that row's page as touched instead, which is
 * always allowed.
 *
 * EXACT ONLY IN INTEGER ARITHMETIC. The full fold adds each page into a running
 * total; this adds the untouched pages' subtotal at the end. Those agree only while
 * every term is an integer and no sum leaves the safe range, and that has to hold
 * for the touched pages' carried rows too, since the subtotal lands among them.
 * So when ANY carried row of the site is outside {@link isAggregatableCarriedRow},
 * the store streams every page and sends an empty aggregate, which is the full fold
 * itself. The merge refuses a non-empty aggregate beside such a row, and a class
 * total past `Number.MAX_SAFE_INTEGER`.
 */
export interface UntouchedCarriedAggregate {
  /** Open findings on untouched pages: each is a carry the merge would persist. */
  findings: number;
  /** Of those, the ones on pages no audit has rendered (no `site_pages` row). */
  unrenderedFindings: number;
  /** Per rule, page-scope or not: the fold drops the rules it cannot score. */
  rules: readonly UntouchedRuleTotals[];
  /** Per rule and report class, for the report sample's stamps. */
  classes: readonly UntouchedClassTotals[];
}

/**
 * One rule's untouched rows as `addChecksToTally` counts them, one call per
 * (page, rule), with the advisory flag OFF: the fold drops the warn half for a
 * severity "info" rule, as `addChecksToTally` would have.
 */
export interface UntouchedRuleTotals {
  ruleId: string;
  /** Rows whose replayed status is "fail" (the stored status is exactly "fail"). */
  failed: number;
  /**
   * Per (checkName, page) over the fail rows: the sum of max(item count, 1), plus
   * the largest positive `details.additional` floored, capped at
   * `ISSUE_PENALTY_ITEM_CAP`. Summed over those buckets.
   */
  failUnits: number;
  /** Rows replayed as "warn": every stored status other than "fail". */
  warnings: number;
  /** Distinct (checkName, page) holding a warn row. */
  warnUnits: number;
  /** Untouched pages whose `site_pages` row is ACTIVE and that hold a row for the rule. */
  activePages: number;
}

/**
 * One report class of a rule's untouched rows: the `foldGroupKey` parts of the
 * replayed check, and the counters the report sample stamps from. Every counter is
 * over ALL the class's untouched rows, sampled or not.
 */
export interface UntouchedClassTotals {
  ruleId: string;
  checkName: string;
  /** The replayed status: "fail" when the stored status is "fail", else "warn". */
  status: "fail" | "warn";
  /** "unrendered" on a page with no `site_pages` row, else "carried". */
  provenance: "carried" | "unrendered";
  /** `details.foldKey` when it is a string, else "". */
  foldKey: string;
  /** Sum of each row's occurrence weight: `details.occurrences` floored when positive, else 1. */
  occurrences: number;
  /** Rows. */
  members: number;
  /** Distinct pages. */
  pages: number;
  /** Largest positive `details.pagesTruncated`, floored; 0 when none. */
  pagesFloor: number;
  /** Newest `lastSeenAt` (epoch ms) of a "carried" class; absent for "unrendered". */
  lastSeenAt?: number;
}

/**
 * (pub#497) An untouched page's REPORT-SAMPLE rows, open findings in cursor order.
 *
 * Per rule, the sample must hold AT LEAST the first
 * {@link CARRIED_REPORT_SAMPLE_PER_RULE} rows across all untouched pages and each
 * report class's first row. The full fold retains only checks from that set: the
 * first checks of a rule, touched pages' included, and the first of each class.
 * Any extra rows are fine, because retention only moves on a retained check, so a
 * row the full fold would drop is dropped here too. The rows need not be counted:
 * the aggregate counts them.
 */
export interface UntouchedSamplePage {
  normalizedUrl: string;
  untouched: true;
  sample: readonly PageFindingRecord[];
}

/**
 * The fold as an accumulator (#1876), so the caller owns the page loop.
 *
 * #1873 could own it: the carried findings were a materialized array the fold
 * indexed by page up front, and only the FRESH side streamed. Bounding the carried
 * side means it streams too, out of the same cursor as the fresh side — and the
 * merge has to decide each prior's fate as it goes past. That decision belongs to
 * `computeMerge`, not here, so the loop moves out and this becomes the thing the
 * loop feeds.
 */
export interface CompleteStoreTallyFold {
  /**
   * Fold ONE page: the findings this audit ingested for it, plus the findings the
   * merge is carrying forward on it. BOTH halves in a single `addChecksToTally`
   * call per rule, which is the whole point — see the module header's invariant.
   *
   * Call at most ONCE per normalized URL. A second call for the same page would
   * split its (checkName, pageUrl) buckets across two folds (double-clamping the
   * per-key unit cap) and double-count it in the dirty-page denominators.
   */
  foldPage(
    normalizedUrl: string,
    fresh: readonly PageFindingRecord[],
    carried: readonly CarriedFinding[]
  ): void;
  /**
   * (pub#497) Report-sample rows of ONE untouched page, the carried findings the
   * caller picked for the report rather than every one the page holds. Call in
   * cursor order relative to {@link foldPage}: the report keeps the first
   * {@link CARRIED_REPORT_SAMPLE_PER_RULE} carried checks per rule in that order,
   * whichever kind of page they came from.
   *
   * Scores nothing and counts nothing: the page's contribution arrives whole
   * through {@link addUntouched}. It only claims the rule's tally slot and report
   * class in the position the page would have, so map order matches the full fold.
   */
  retainUntouchedSample(normalizedUrl: string, carried: readonly CarriedFinding[]): void;
  /**
   * (pub#497) The untouched pages' contribution, computed by the store. Call ONCE,
   * after the last page and sample, before {@link foldShellRules}.
   */
  addUntouched(aggregate: UntouchedCarriedAggregate): void;
  /**
   * Trailing pass over every rule the shell carries: site-scope checks verbatim,
   * page-scope clean-page counts. Call ONCE, after every page has been folded — it
   * reads the dirty-page counts the page pass accumulates.
   */
  foldShellRules(): void;
  /** Carried-only rules (page-scope, absent from the shell), then the tallies. */
  finish(): Map<string, RuleTally>;
  /**
   * The carried half of the union, bounded (#1876). Only meaningful with
   * `retainCarriedChecks`; call after the last {@link foldPage}.
   *
   * A rule whose carried checks fit under `REPORT_LIMITS.maxChecksPerRule` reaches
   * the report EXACTLY as it did before this bound existed. Past it, the rule keeps
   * that many checks and the dropped ones survive as numbers: the last retained
   * check of each (name, status) class is stamped with the class's true
   * `occurrences` and its true distinct-page count as `pagesTruncated`, which is
   * what the publish fold sums and maxes to build the aggregate. So the counts the
   * report and issue-sync read stay exact while the objects behind them do not have
   * to be resident. What IS lost above the cap is display detail only: the dropped
   * checks' `items`, their page URLs, and their `details.additional`.
   */
  carriedUnion(): CarriedUnionSource;
}

/**
 * Fold this audit's complete findings + the merge's carried findings into per-rule
 * tallies — the bounded twin of
 * `buildScoringResultsFromMerged({ freshResults: reconstructCompleteResults(…), … })`.
 *
 * MUST see a page BEFORE the merge's persistence writes touch it: `computeMerge`
 * stamps rows it RESOLVES with this run's crawlId, so a fold that read a page after
 * them would take a just-resolved finding as fresh evidence of failure. A cursor
 * that reads each page once and only writes rows behind it satisfies this.
 */
export function createCompleteStoreTallyFold(
  input: CompleteStoreFoldInput
): CompleteStoreTallyFold {
  const {
    ruleResults,
    crawledUrls,
    skippedPassCounts,
    carriedPageUrls,
    ruleMetaIndex,
    removedUrls,
    retainCarriedChecks,
    requireAggregatableCarried,
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

  // Pages this run has a finding on, per rule — the fresh-clean denominator's
  // subtrahend. Counted (not collected) so it stays O(rules), and counted only for
  // CRAWLED pages, matching reconstructCompleteResults' `crawledUrls \ failingPages`.
  const dirtyPagesByRule = new Map<string, number>();

  // The carried half of the same bookkeeping, and the same reason for counting
  // rather than collecting (#1876): a partial re-audit of a large site carries tens
  // of thousands of findings, so neither the findings nor their pages can be held.
  //  - carriedRuleIds: page-scope rules with ANY carried finding, so a rule absent
  //    from the shell still gets its carried-clean passes. O(rules).
  //  - carriedDirtyPagesByRule: how many CARRIED PAGES (⊆ carriedPageUrls) have a
  //    finding for the rule. `carriedPageUrls.size` minus this is exactly the
  //    set-difference count the materialized path computes, because every page is
  //    folded exactly once. O(rules).
  const carriedRuleIds = new Set<string>();
  const carriedDirtyPagesByRule = new Map<string, number>();

  // (#1876) The report's carried sample, taken from the SAME replayed checks the
  // tally consumes — building it here rather than in a second pass is what stops a
  // carried finding's stored payload being JSON-parsed twice.
  const carriedReport = retainCarriedChecks ? new Map<string, CarriedRuleReport>() : undefined;

  const foldPage: CompleteStoreTallyFold["foldPage"] = (normalizedUrl, fresh, carried) => {
    const freshByRule = fresh.length > 0 ? reconstructPageRuleChecks(fresh) : undefined;
    // Carried findings for this page, grouped per rule. Bounded by ONE page.
    let carriedByRule: Map<string, CarriedFinding[]> | undefined;
    for (const f of carried) {
      // Unknown rule — cannot be scored (no meta); site-scope rules never carry
      // per-page findings. Both mirror buildScoringResultsFromMerged's guards.
      if (metaOf(f.ruleId)?.scope !== "page") continue;
      if (!carriedByRule) carriedByRule = new Map();
      const list = carriedByRule.get(f.ruleId);
      if (list) list.push(f);
      else carriedByRule.set(f.ruleId, [f]);
    }
    if (carriedByRule) {
      const isCarriedPage = carriedPageUrls.has(normalizedUrl);
      for (const ruleId of carriedByRule.keys()) {
        carriedRuleIds.add(ruleId);
        if (isCarriedPage) {
          carriedDirtyPagesByRule.set(ruleId, (carriedDirtyPagesByRule.get(ruleId) ?? 0) + 1);
        }
      }
    }
    if (!freshByRule && !carriedByRule) return;

    const isCrawled = crawledUrls.has(normalizedUrl);
    // 404/410 this run: the page is gone, so its fresh checks leave the union
    // (mirroring freshForUnion). Carried findings are folded regardless — the
    // merge stales anything on a removed page, so in practice there are none, but
    // the shape then matches the materialized path rather than relying on that.
    const isRemoved = removedUrls?.has(normalizedUrl) ?? false;

    const ruleIds = new Set<string>(freshByRule?.keys() ?? []);
    if (carriedByRule) for (const ruleId of carriedByRule.keys()) ruleIds.add(ruleId);

    for (const ruleId of ruleIds) {
      const meta = metaOf(ruleId);
      // A finding whose rule is absent from the shell cannot be scored (no meta);
      // a site-scope rule never has per-page findings. Mirrors the unknown-rule
      // guards in reconstructCompleteResults / buildScoringResultsFromMerged.
      if (meta?.scope !== "page") continue;
      const freshChecks = isRemoved ? undefined : freshByRule?.get(ruleId);
      const carriedForRule = carriedByRule?.get(ruleId);
      const carriedChecks = carriedForRule?.map((f) => carriedFindingToCheck(f, normalizedUrl));
      if (requireAggregatableCarried && carriedChecks && carriedForRule) {
        carriedForRule.forEach((f, i) => assertAggregatable(f.payload, carriedChecks[i]!, normalizedUrl));
      }
      if (carriedReport && carriedChecks) retainCarried(carriedReport, ruleId, carriedChecks);
      const checks: CheckResult[] = carriedChecks
        ? [...(freshChecks ?? []), ...carriedChecks]
        : (freshChecks ?? []);
      if (checks.length === 0) continue;
      addChecksToTally(entryFor(ruleId, meta).tally, checks, advisory(meta), 0);
      if (freshChecks && freshChecks.length > 0 && isCrawled) {
        dirtyPagesByRule.set(ruleId, (dirtyPagesByRule.get(ruleId) ?? 0) + 1);
      }
    }
  };

  const retainUntouchedSample: CompleteStoreTallyFold["retainUntouchedSample"] = (
    normalizedUrl,
    carried
  ) => {
    // The same rule filter and grouping as `foldPage`, so the rules the page
    // claims, and the order it claims them in, are the ones a full fold of the
    // page would have.
    const byRule = new Map<string, CarriedFinding[]>();
    for (const f of carried) {
      if (metaOf(f.ruleId)?.scope !== "page") continue;
      const list = byRule.get(f.ruleId);
      if (list) list.push(f);
      else byRule.set(f.ruleId, [f]);
    }
    for (const [ruleId, findings] of byRule) {
      carriedRuleIds.add(ruleId);
      // Claims the tally's slot where the page's first carried check would have:
      // the tally map's order is the order the scorer walks it in.
      entryFor(ruleId, metaOf(ruleId)!);
      const checks = findings.map((f) => carriedFindingToCheck(f, normalizedUrl));
      findings.forEach((f, i) => assertAggregatable(f.payload, checks[i]!, normalizedUrl));
      if (carriedReport) retainCarried(carriedReport, ruleId, checks, false);
    }
  };

  const addUntouched: CompleteStoreTallyFold["addUntouched"] = (aggregate) => {
    for (const r of aggregate.rules) {
      const meta = metaOf(r.ruleId);
      if (meta?.scope !== "page") continue;
      carriedRuleIds.add(r.ruleId);
      const { tally } = entryFor(r.ruleId, meta);
      tally.failed += r.failed;
      tally.failUnits += r.failUnits;
      if (!advisory(meta)) {
        tally.warnings += r.warnings;
        tally.warnUnits += r.warnUnits;
      }
      if (r.activePages > 0) {
        carriedDirtyPagesByRule.set(
          r.ruleId,
          (carriedDirtyPagesByRule.get(r.ruleId) ?? 0) + r.activePages
        );
      }
    }
    if (!carriedReport) return;
    for (const c of aggregate.classes) {
      if (metaOf(c.ruleId)?.scope !== "page") continue;
      const key = foldGroupKey({
        name: c.checkName,
        status: c.status,
        message: "",
        provenance: c.provenance,
        details: { foldKey: c.foldKey },
      });
      const counts = carriedReport.get(c.ruleId)?.classes.get(key);
      // A class's first untouched row is always in the sample, so the class
      // exists by now. Without it there is no check to stamp the counts on, and
      // the class would leave the report while its findings stay open.
      if (!counts) {
        throw new Error(
          `untouched carried class ${c.ruleId} ${c.checkName} (${c.status}, ${c.provenance}) has no sampled row`
        );
      }
      // Every term is a non-negative integer, so the two orders of addition agree
      // exactly while the total stays safe. Past that they need not, and nine
      // million rows of one class would be the only way there.
      if (counts.total + c.occurrences > Number.MAX_SAFE_INTEGER) {
        throw new Error(`untouched carried class ${c.ruleId} ${c.checkName} totals past the safe integer range`);
      }
      counts.total += c.occurrences;
      counts.members += c.members;
      counts.pages += c.pages;
      if (c.pagesFloor > counts.pagesFloor) counts.pagesFloor = c.pagesFloor;
      if (c.provenance !== "carried") counts.allCarried = false;
      if (c.provenance !== "unrendered") counts.allUnrendered = false;
      if (c.lastSeenAt !== undefined) {
        counts.lastSeenAt = Math.max(counts.lastSeenAt ?? 0, c.lastSeenAt);
      }
    }
    // The reverse check: a sampled row the totals do not count would make its
    // class look complete, so the stamp would be skipped and its dropped rows lost.
    for (const [ruleId, entry] of carriedReport) {
      for (const counts of entry.classes.values()) {
        if (counts.members < counts.retainedMembers) {
          throw new Error(`untouched carried totals for ${ruleId} miss rows the sample holds`);
        }
      }
    }
  };

  /** Carried pages with NO finding for this rule — the carried half of the
   *  pass-ratio denominator (#918). Folded to a count, never to synthetic "pass"
   *  CheckResults, so a partial re-audit of a large site cannot materialize
   *  (page-scope rules × carried pages) objects. */
  const cleanCarriedPasses = (ruleId: string): number =>
    carriedPageUrls.size - (carriedDirtyPagesByRule.get(ruleId) ?? 0);

  const foldShellRules: CompleteStoreTallyFold["foldShellRules"] = () => {
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
        clean + skippedPasses + cleanCarriedPasses(ruleId)
      );
    }
  };

  const finish: CompleteStoreTallyFold["finish"] = () => {
    // Carried-only rules (page-scope, absent from the shell) get no fresh-clean
    // count — reconstructCompleteResults never runs for them — but they DO get the
    // carried-clean passes buildScoringResultsFromMerged gives them.
    for (const ruleId of carriedRuleIds) {
      if (ruleResults[ruleId]) continue; // already handled by foldShellRules
      const meta = metaOf(ruleId);
      if (meta?.scope !== "page") continue;
      addChecksToTally(entryFor(ruleId, meta).tally, [], advisory(meta), cleanCarriedPasses(ruleId));
    }
    return tallies;
  };

  // Collapsing stamps the dropped counts ONTO a retained check, so it must happen
  // exactly once however many times the caller asks for the union.
  let collapsed: Map<string, readonly CheckResult[]> | undefined;
  const carriedUnion: CompleteStoreTallyFold["carriedUnion"] = () => {
    const checksByRule = (collapsed ??= collapseCarriedReport(
      carriedReport ?? new Map<string, CarriedRuleReport>(),
    ));
    return {
      ruleIds: () => carriedRuleIds,
      checksFor: (ruleId) => checksByRule.get(ruleId) ?? EMPTY_CHECKS,
      dirtyCarriedPageCount: (ruleId) => carriedDirtyPagesByRule.get(ruleId) ?? 0,
    };
  };

  return { foldPage, retainUntouchedSample, addUntouched, foldShellRules, finish, carriedUnion };
}

const EMPTY_CHECKS: readonly CheckResult[] = [];

/**
 * Carried checks retained per rule for the report body (#1876).
 *
 * A rule under it reaches the report byte-for-byte as it did before this bound
 * existed. Past it the rule's carried side is ONE aggregate per issue class,
 * carrying the true occurrence and affected-page counts — which is the shape the
 * complete-store report already uses for page-scope rules, since the staged shell
 * ships aggregates rather than per-page checks.
 *
 * MEASURED, and low for a reason that is not the obvious one. The retained checks
 * are small; what costs is that a larger live set raises the heap the runtime
 * grows to under this path's churn, so the price is a multiple of their own size.
 * Whole-handler peak at 60,000 carried findings over 40 rules, everything else
 * equal: 500 per rule cost ~180 MiB, 100 cost ~123, 25 costs ~78, and retaining
 * nothing at all costs ~77. Past about 25 the sample buys report detail with
 * isolate the 128 MB budget does not have.
 *
 * (pub#497) Exported for the store's untouched-page sample read, which must take
 * the same number of rows per rule.
 */
export const CARRIED_REPORT_SAMPLE_PER_RULE = 25;

/**
 * Per-(name, status) issue class: what was seen versus what was kept.
 *
 * Everything a dropped check would have contributed to its aggregate is counted
 * here, because the aggregate is built from the RETAINED sample and would
 * otherwise report only that sample's share. Four things travel that way, and
 * each was a real loss before it did.
 */
interface CarriedClassCounts {
  /**
   * Occurrences of this class, kept or dropped — WEIGHTED, not an object count. A
   * constituent that is itself an aggregate stands for its own `occurrences`, the
   * same distinction `foldGroup` draws when it sums them.
   */
  total: number;
  /** Occurrences of the constituents that are in `checks`, weighted the same way. */
  retained: number;
  /**
   * Constituents seen, and of those how many are in `checks` — plain OBJECT
   * counts, tracked separately from the weights above because a weight can be
   * zero. `foldGroup` floors `details.occurrences`, so a check declaring `0.5`
   * contributes nothing to either total, and a class that lost only such checks
   * would look complete while its pages and provenance had gone missing.
   */
  members: number;
  retainedMembers: number;
  /** Distinct PAGES with at least one — exact, because a page folds exactly once. */
  pages: number;
  /**
   * Largest `details.pagesTruncated` any constituent carried. A carried finding
   * can hold one: `unfoldAggregateCheck` strips `aggregated`/`occurrences` when it
   * expands a published aggregate but leaves this, so the per-page rows the merge
   * stores inherit it. Losing a dropped check's floor would make the aggregate
   * claim fewer affected pages than a constituent already reported.
   */
  pagesFloor: number;
  /** Last retained check of the class: where the dropped counts get stamped. */
  last?: CheckResult;
  /** Newest `lastSeenAt` across every constituent, dropped ones included. */
  lastSeenAt?: number;
  /** True while EVERY constituent is provenance "carried". */
  allCarried: boolean;
  /** True while EVERY constituent is provenance "unrendered". */
  allUnrendered: boolean;
}

/** What a check contributes to an occurrence total: its own count, or itself. */
function occurrencesOf(check: CheckResult): number {
  const own = check.details?.occurrences;
  return typeof own === "number" && Number.isFinite(own) && own > 0 ? Math.floor(own) : 1;
}

interface CarriedRuleReport {
  checks: CheckResult[];
  classes: Map<string, CarriedClassCounts>;
}

function emptyClassCounts(): CarriedClassCounts {
  return {
    total: 0,
    retained: 0,
    members: 0,
    retainedMembers: 0,
    pages: 0,
    pagesFloor: 0,
    allCarried: true,
    allUnrendered: true,
  };
}

/** Count one constituent into its class: `firstOnPage` when it is the first of
 *  the class on its page, so `pages` counts pages rather than checks. */
function countClassMember(
  counts: CarriedClassCounts,
  check: CheckResult,
  firstOnPage: boolean
): void {
  counts.total += occurrencesOf(check);
  counts.members += 1;
  if (firstOnPage) counts.pages += 1;
  const ownFloor = check.details?.pagesTruncated;
  if (typeof ownFloor === "number" && Number.isFinite(ownFloor) && ownFloor > counts.pagesFloor) {
    counts.pagesFloor = Math.floor(ownFloor);
  }
  if (check.provenance !== "carried") counts.allCarried = false;
  if (check.provenance !== "unrendered") counts.allUnrendered = false;
  if (check.lastSeenAt !== undefined) {
    counts.lastSeenAt = Math.max(counts.lastSeenAt ?? 0, check.lastSeenAt);
  }
}

/**
 * One page's carried checks for one rule, retained up to the per-rule cap.
 *
 * (pub#497) `count` false for an untouched page's sample rows: their class
 * counters arrive from the store through `addUntouched`, so only the retention
 * itself happens here.
 */
function retainCarried(
  report: Map<string, CarriedRuleReport>,
  ruleId: string,
  checks: readonly CheckResult[],
  count = true
): void {
  let entry = report.get(ruleId);
  if (!entry) {
    entry = { checks: [], classes: new Map() };
    report.set(ruleId, entry);
  }
  // Classes already counted for THIS page, so `pages` counts pages, not checks.
  const pageClasses = new Set<string>();
  for (const check of checks) {
    // The key the publish fold groups on, so a stamp lands on the class it will
    // actually be summed into — provenance included (#2063), or a class that
    // splits into a carried and a fresh aggregate would be counted once, capped
    // as one, and reconciled against whichever of the two happened to match.
    const key = foldGroupKey(check);
    let counts = entry.classes.get(key);
    if (!counts) {
      counts = emptyClassCounts();
      entry.classes.set(key, counts);
    }
    if (count) {
      countClassMember(counts, check, !pageClasses.has(key));
      pageClasses.add(key);
    }
    // The rule's budget never costs a class its EXISTENCE. A class first seen
    // after the budget is spent still keeps its first check, because that check is
    // where its dropped occurrences and affected pages are stamped — without one
    // the whole class would vanish from the report while its findings stayed open
    // in the store. The bound becomes max(budget, distinct issue classes), and the
    // classes of one rule are its distinct check names.
    if (counts.retainedMembers > 0 && entry.checks.length >= CARRIED_REPORT_SAMPLE_PER_RULE) {
      continue;
    }
    entry.checks.push(check);
    counts.retained += occurrencesOf(check);
    counts.retainedMembers += 1;
    counts.last = check;
  }
}

/**
 * Turn the retained sample into the checks the report body gets.
 *
 * A rule that lost nothing passes through UNTOUCHED, so its report is byte-for-byte
 * what the materialized path builds — `applyUnionToReport` folds it downstream
 * exactly as before.
 *
 * A rule that DID lose carried findings is folded here instead. Two reasons, and
 * the second is why this is not merely an optimization:
 *  1. the dropped findings survive as numbers, and numbers only reach the report
 *     through an aggregate — `foldGroup` sums each constituent's
 *     `details.occurrences` (defaulting to 1) and takes the MAX of their
 *     `details.pagesTruncated`, so stamping one retained member of a class with the
 *     class totals makes the aggregate report the true occurrence count and the
 *     true affected-page count, which issue-sync and `affectedPages()` read;
 *  2. a rule over the cap folded to a handful of aggregates BEFORE this bound
 *     existed (its carried checks were far past `maxChecksPerRule`, so the publish
 *     fold always collapsed them). Handing the report a retained sample that sits
 *     exactly AT the cap would sail under that fold and publish thousands of
 *     per-page checks where there used to be three — a bigger report, not a
 *     smaller one. Measured: 40 rules × 500 retained checks = a 5.4 MB payload,
 *     over the pre-warm budget.
 */
function collapseCarriedReport(
  report: Map<string, CarriedRuleReport>,
): Map<string, readonly CheckResult[]> {
  const out = new Map<string, readonly CheckResult[]>();
  for (const [ruleId, entry] of report) {
    let anyDropped = false;
    for (const counts of entry.classes.values()) {
      const last = counts.last;
      // Keyed on MEMBERS, not on weight: a dropped check whose declared
      // occurrence count floors to zero still took its pages and its provenance
      // with it.
      if (counts.members <= counts.retainedMembers || !last) continue;
      anyDropped = true;
      const stamped = occurrencesOf(last) + (counts.total - counts.retained);
      // Replaced, never mutated in place: `details` can be the object parsed out of
      // the finding's stored payload, which other readers of that payload share.
      //
      // A stamp of ZERO is never written. `foldGroup` reads a non-positive
      // `occurrences` as "no count declared" and substitutes 1, so writing the 0
      // this class genuinely weighs would ADD an occurrence the materialized fold
      // does not have. Leaving the field as the retained check declared it lets
      // the fold reach the same total by the same route it always did.
      last.details = {
        ...(last.details ?? {}),
        ...(stamped > 0 ? { occurrences: stamped } : {}),
        pagesTruncated: Math.max(counts.pages, counts.pagesFloor),
      };
    }
    if (!anyDropped) {
      out.set(ruleId, entry.checks);
      continue;
    }
    // `maxChecks` = the class count, which is the largest value that still folds
    // every class (the fold is a no-op at or under it) and keeps all of them (it
    // slices only past it).
    const folded = foldOverflowChecks(entry.checks, {
      ...DEFAULT_FOLD_LIMITS,
      maxChecks: entry.classes.size,
    });
    for (const aggregate of folded) reconcileCarriedAggregate(aggregate, entry.classes);
    out.set(ruleId, folded);
  }
  return out;
}

/**
 * Repair the two things `foldGroup` can only read off the constituents in front of
 * it, and which the RETAINED sample therefore answers for the whole class.
 *
 * `provenance` is all-or-nothing there: it stamps "carried" when every constituent
 * is carried, "unrendered" when every one is. A sample can be uniform when the
 * class is not — the first 25 findings all on pages an earlier audit rendered, the
 * rest on pages nothing ever has — and the aggregate would then claim an audit saw
 * findings that no audit has. `lastSeenAt` has the mirror-image problem: it is the
 * MAX over the group, so a dropped constituent with a newer date makes the badge
 * read stale.
 *
 * Both are corrected from counters kept over every constituent. A mixed class ends
 * up with neither marker, which is what a mixed group of real checks would have
 * produced.
 */
function reconcileCarriedAggregate(
  aggregate: CheckResult,
  classes: Map<string, CarriedClassCounts>
): void {
  const counts = classes.get(foldGroupKey(aggregate));
  // Untouched unless this class actually lost members; a fully-present class was
  // folded from every constituent and is already right.
  if (!counts || counts.members <= counts.retainedMembers) return;

  // A class whose sample is a SINGLE check was not folded at all — `foldGroup`
  // short-circuits a one-member group and returns the check itself — so it still
  // reads as one page's finding while its stamped counts speak for many, and a
  // reader would attribute every occurrence to that page. Give it the shape the
  // fold would have produced from the same constituents.
  if (aggregate.details?.aggregated !== true) {
    if (aggregate.pageUrl) {
      aggregate.pages = [aggregate.pageUrl];
      delete aggregate.pageUrl;
    }
    aggregate.details = { ...(aggregate.details ?? {}), aggregated: true };
    const occurrences = occurrencesOf(aggregate);
    if (occurrences > 1) {
      aggregate.message = `${aggregate.message} (+${occurrences - 1} more pages)`.slice(
        0,
        REPORT_LIMITS.maxMediumString
      );
    }
  }

  if (counts.allUnrendered) {
    aggregate.provenance = "unrendered";
    delete aggregate.lastSeenAt;
    return;
  }
  if (counts.allCarried) {
    aggregate.provenance = "carried";
    if (counts.lastSeenAt !== undefined) aggregate.lastSeenAt = counts.lastSeenAt;
    return;
  }
  delete aggregate.provenance;
  delete aggregate.lastSeenAt;
}

/**
 * Whole-array driver: the #1873 shape, where the carried findings are already
 * materialized and only the FRESH side streams. Kept as the entry point for the
 * CLI-shaped callers and the parity fixtures; the API's streaming finalize drives
 * {@link createCompleteStoreTallyFold} directly off one cursor instead.
 */
export async function foldCompleteStoreTallies(
  input: CompleteStoreTallyInput
): Promise<Map<string, RuleTally>> {
  const { findingPages, carriedFindings, ...rest } = input;
  const fold = createCompleteStoreTallyFold(rest);

  // Carried findings indexed by page, so a page's carried checks fold in the SAME
  // call as its fresh ones. Bounded by the carried set — which is exactly what the
  // streaming driver exists to avoid, and why this one is not the API's path.
  const carriedByPage = new Map<string, CarriedFinding[]>();
  for (const f of carriedFindings) {
    const list = carriedByPage.get(f.normalizedUrl);
    if (list) list.push(f);
    else carriedByPage.set(f.normalizedUrl, [f]);
  }

  const EMPTY: readonly CarriedFinding[] = [];
  for await (const batch of findingPages) {
    if (batch.length === 0) continue;
    // Re-group by page rather than trusting a batch to hold exactly one. What the
    // invariant needs is that a page is never SPLIT across two items; a batch
    // carrying several WHOLE pages is harmless, and grouping here means such a
    // producer cannot silently attribute one page's findings to another page's
    // crawled/removed state.
    for (const [normalizedUrl, page] of groupByPage(batch)) {
      const carried = carriedByPage.get(normalizedUrl);
      // Consumed: this page's carried findings are folded here, so the trailing
      // carried pass must not fold them a second time.
      if (carried) carriedByPage.delete(normalizedUrl);
      fold.foldPage(normalizedUrl, page, carried ?? EMPTY);
    }
  }

  // Carried findings whose page was never streamed (the normal case: an un-crawled
  // page), plus carried-only rules absent from the shell.
  for (const [normalizedUrl, carried] of carriedByPage) {
    fold.foldPage(normalizedUrl, EMPTY_ROWS, carried);
  }

  fold.foldShellRules();
  return fold.finish();
}

const EMPTY_ROWS: readonly PageFindingRecord[] = [];

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
 * (pub#497) Largest `details.occurrences` an aggregated row may declare. Class
 * totals are sums of these, and a sum taken in a different order than the full
 * fold's is the same number only while it stays an exact integer: at this bound a
 * class would need nine million rows to leave the safe range.
 */
export const UNTOUCHED_MAX_OCCURRENCES = 1e9;

/**
 * (pub#497) True when a carried row's contribution is an exact integer the
 * aggregate can add in any order. Two payload shapes break that, both malformed:
 *  - `items` an object but not an array: `addChecksToTally` counts it by its
 *    `length` property, which can be fractional, negative or not a number;
 *  - `details.occurrences` at or past {@link UNTOUCHED_MAX_OCCURRENCES}.
 * Fresh rows need no such test: their items are rebuilt as a real array.
 * One rejected carried row anywhere on the site, touched page or not, means no
 * aggregate (see {@link UntouchedCarriedAggregate}). A store's own test may be
 * stricter, never looser.
 */
export function isAggregatableCarriedRow(row: PageFindingRecord): boolean {
  const finding = untouchedCarriedFinding(row, false);
  return (
    payloadItemsAggregatable(finding.payload) &&
    aggregatableCheck(carriedFindingToCheck(finding, row.normalizedUrl))
  );
}

/**
 * The replayed check drops a non-array `items` (#504), so the exact-domain test
 * reads it from the raw payload the row was stored with.
 */
function payloadItemsAggregatable(payload: string | null | undefined): boolean {
  if (!payload) return true;
  let items: unknown;
  try {
    items = (JSON.parse(payload) as { items?: unknown } | null)?.items;
  } catch {
    return true;
  }
  return typeof items !== "object" || items === null || Array.isArray(items);
}

function aggregatableCheck(check: CheckResult): boolean {
  const occurrences = check.details?.occurrences;
  return !(typeof occurrences === "number" && occurrences >= UNTOUCHED_MAX_OCCURRENCES);
}

function assertAggregatable(payload: string | null | undefined, check: CheckResult, normalizedUrl: string): void {
  if (!payloadItemsAggregatable(payload) || !aggregatableCheck(check)) {
    throw new Error(
      `carried finding on ${normalizedUrl} is outside the untouched aggregate's exact domain; the store must stream every page`
    );
  }
}

/** (pub#497) One untouched page as {@link aggregateUntouchedCarried} reads it. */
export interface UntouchedCarriedPage {
  normalizedUrl: string;
  /** The page's OPEN findings, every one from an earlier audit, in cursor order. */
  rows: readonly PageFindingRecord[];
  /** The page has a `site_pages` row: some audit rendered it. */
  rendered: boolean;
  /** That row's state is "active", so the page is in `carriedPageUrls`. */
  active: boolean;
}

/** (pub#497) What a store hands the merge for its untouched pages. */
export interface UntouchedCarriedReference {
  aggregate: UntouchedCarriedAggregate;
  /** The report-sample rows, page by page in cursor order. */
  sample: UntouchedSamplePage[];
}

/**
 * The carried finding the merge makes of an untouched page's row: every such prior
 * is carried unchanged (`{ ...prior, provenance: "carried" }`), and a page with no
 * `site_pages` row is one no audit has rendered (#1652).
 */
export function untouchedCarriedFinding(
  row: PageFindingRecord,
  neverRendered: boolean
): CarriedFinding {
  return {
    normalizedUrl: row.normalizedUrl,
    ruleId: row.ruleId,
    checkName: row.checkName,
    status: row.status,
    message: row.message,
    value: row.value,
    expected: row.expected,
    payload: row.payload,
    neverRendered,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * (pub#497) The REFERENCE for a store's untouched-page aggregate: the totals and
 * the report sample computed from the rows themselves, with the very functions the
 * full fold uses (`carriedFindingToCheck`, `addChecksToTally` once per page and
 * rule, the report's class counter). A store twin, such as a SQL `GROUP BY`, is
 * correct exactly when it returns what this returns for the same rows.
 *
 * Pages in cursor order, each holding only rows from earlier audits. It knows no
 * rule meta, so it covers every rule; the fold drops the ones it cannot score.
 * Throws on a row outside {@link isAggregatableCarriedRow}.
 */
export function aggregateUntouchedCarried(
  pages: Iterable<UntouchedCarriedPage>
): UntouchedCarriedReference {
  const rules = new Map<string, UntouchedRuleTotals>();
  const classes = new Map<
    string,
    { totals: Omit<UntouchedClassTotals, "occurrences" | "members" | "pages" | "pagesFloor" | "lastSeenAt">; counts: CarriedClassCounts }
  >();
  /** Rows seen per rule so far: the sample takes the first CAP of them. */
  const seenPerRule = new Map<string, number>();
  const sample: UntouchedSamplePage[] = [];
  let findings = 0;
  let unrenderedFindings = 0;

  for (const page of pages) {
    const neverRendered = !page.rendered;
    findings += page.rows.length;
    if (neverRendered) unrenderedFindings += page.rows.length;

    // Row indices per rule, in cursor order: one `addChecksToTally` call each.
    const byRule = new Map<string, number[]>();
    for (let i = 0; i < page.rows.length; i++) {
      const ruleId = page.rows[i]!.ruleId;
      const list = byRule.get(ruleId);
      if (list) list.push(i);
      else byRule.set(ruleId, [i]);
    }

    const sampled = new Set<number>();
    for (const [ruleId, indices] of byRule) {
      const findings = indices.map((i) => untouchedCarriedFinding(page.rows[i]!, neverRendered));
      const checks = findings.map((f) => carriedFindingToCheck(f, page.normalizedUrl));
      findings.forEach((f, i) => assertAggregatable(f.payload, checks[i]!, page.normalizedUrl));

      const tally = emptyTally();
      addChecksToTally(tally, checks, false, 0);
      let totals = rules.get(ruleId);
      if (!totals) {
        totals = { ruleId, failed: 0, failUnits: 0, warnings: 0, warnUnits: 0, activePages: 0 };
        rules.set(ruleId, totals);
      }
      totals.failed += tally.failed;
      totals.failUnits += tally.failUnits;
      totals.warnings += tally.warnings;
      totals.warnUnits += tally.warnUnits;
      if (page.active) totals.activePages += 1;

      const pageClasses = new Set<string>();
      for (let k = 0; k < checks.length; k++) {
        const check = checks[k]!;
        const classId = `${ruleId}\u0000${foldGroupKey(check)}`;
        let entry = classes.get(classId);
        const firstOfClass = !entry;
        if (!entry) {
          const foldKey = check.details?.foldKey;
          entry = {
            totals: {
              ruleId,
              checkName: check.name,
              status: check.status === "fail" ? "fail" : "warn",
              provenance: check.provenance === "unrendered" ? "unrendered" : "carried",
              foldKey: typeof foldKey === "string" ? foldKey : "",
            },
            counts: emptyClassCounts(),
          };
          classes.set(classId, entry);
        }
        countClassMember(entry.counts, check, !pageClasses.has(classId));
        pageClasses.add(classId);

        const seen = seenPerRule.get(ruleId) ?? 0;
        seenPerRule.set(ruleId, seen + 1);
        if (seen < CARRIED_REPORT_SAMPLE_PER_RULE || firstOfClass) sampled.add(indices[k]!);
      }
    }

    if (sampled.size > 0) {
      sample.push({
        normalizedUrl: page.normalizedUrl,
        untouched: true,
        sample: page.rows.filter((_, i) => sampled.has(i)),
      });
    }
  }

  return {
    aggregate: {
      findings,
      unrenderedFindings,
      rules: [...rules.values()],
      classes: Array.from(classes.values(), ({ totals, counts }) => ({
        ...totals,
        occurrences: counts.total,
        members: counts.members,
        pages: counts.pages,
        pagesFloor: counts.pagesFloor,
        ...(counts.lastSeenAt !== undefined ? { lastSeenAt: counts.lastSeenAt } : {}),
      })),
    },
    sample,
  };
}
