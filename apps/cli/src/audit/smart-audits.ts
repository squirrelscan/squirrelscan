// Smart audits (#110) — CLI orchestration of the per-page finding store.
//
// Invoked ONLY when `config.smart_audits` is true. The command resolves the
// default (signed-in → on, anonymous → off; #684) unless config sets it
// explicitly. Off → this module never runs and the audit path is unchanged.
//
// After the rules phase, this:
//   1. flattens this run's fail/warn checks into per-page findings,
//   2. merges them against the site-scoped store (supersede crawled, carry
//      un-crawled, stale 404/410), persisting the merged state,
//   3. builds a UNION `Map<ruleId, RuleRunResult>` for scoring + report so a
//      partial re-audit does not inflate the score.

import type {
  CheckResult,
  CrawlStorage,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";

import {
  buildScoringResultsFromMerged,
  mergeFindings,
  type CarriedFinding,
  type FlatFinding,
  type RuleTally,
} from "@squirrelscan/audit-engine";
import { loadAllRules, type RuleRunResult } from "@squirrelscan/rules";
import { Effect } from "effect";

/**
 * Statuses that mean the page is GONE, so its checks are not active findings.
 * Exported because the audit controller has to know them before the rules
 * stream: the fresh findings are now flattened inside the stream, which is the
 * last point a removed page's checks exist to be skipped (#2343).
 */
export const REMOVED_STATUSES = new Set([404, 410]);

/** Stable identity for a carried finding, used to tag report checks. */
function carriedKey(
  pageUrl: string,
  ruleId: string,
  checkName: string
): string {
  return `${pageUrl}|${ruleId}|${checkName}`;
}

export interface SmartAuditResult {
  /**
   * The CARRIED half of the union, per rule: replayed carried checks plus the
   * `syntheticPassCount` that keeps clean carried pages in the pass-ratio
   * denominator. Rules with neither are still present (empty checks, count 0) so
   * the consumer sees the full rule set the union covered.
   *
   * It was the whole union until #2343. The fresh half is every check this run
   * produced, which is exactly what `reconstructReport` already reads back out of
   * `rule_results` — holding a second in-memory copy of it from the rules phase
   * to the report was the largest single term in the audit's peak heap. The
   * consumer now joins the two; see {@link SmartAuditResult.removedUrls} for the
   * one filter the fresh half needs.
   */
  carriedRuleResults: Map<string, RuleRunResult>;
  /**
   * Normalized URLs that returned 404/410 this run. Their fresh checks must be
   * dropped before the join: the page is gone, so it is not one of the "known
   * non-removed" pages the union scores over.
   */
  removedUrls: Set<string>;
  /** Coverage line data for surfacing. */
  coverage: {
    auditedPages: number;
    knownPages: number;
    /** Findings a PREVIOUS audit observed. 0 on a first run (#1652). */
    carriedFindings: number;
    /**
     * Findings on pages no audit has ever rendered (#1652). OMITTED when zero so
     * a site without any is byte-identical to a pre-#1652 report — this object is
     * copied straight into `report.coverage`.
     */
    unrenderedFindings?: number;
  };
  /**
   * carriedKey → lastSeenAt (epoch ms) for tagging report checks as carried.
   * (#1652) Never-rendered findings are excluded — {@link tagCarriedCheck}
   * preserves the `provenance: "unrendered"` the union scorer already stamped.
   */
  carriedLastSeen: Map<string, number>;
}

export interface RunSmartAuditsInput {
  storage: CrawlStorage;
  crawlId: string;
  /** Site-scoped key = normalized base-site origin (same as getCrawlByUrl). */
  siteKey: string;
  /**
   * This run's fail/warn checks, already flattened per (page, rule, item) by the
   * rules-phase sink (#2343) in crawl order, with removed pages excluded. Same
   * findings, same order, as the old `flattenChecks` walk over `pageRuleResults`
   * — produced a page at a time instead of over a map held for the whole run.
   */
  freshFindings: FlatFinding[];
  /** Normalized URLs page rules actually ran on, in crawl order. */
  scoredPageUrls: readonly string[];
  /** ruleId -> folded tally; read for `meta` only (the bounded rule index). */
  ruleMeta: ReadonlyMap<string, RuleTally>;
  /** All page records for this crawl (status used to detect 404/410). */
  pages: Array<{ normalizedUrl: string; status: number }>;
}

/**
 * Merge this run into the site store and return a UNION scoring map + coverage.
 * Persists findings + site pages as a side effect.
 */
export function runSmartAudits(
  input: RunSmartAuditsInput
): Effect.Effect<SmartAuditResult, Error, never> {
  const {
    storage,
    crawlId,
    siteKey,
    freshFindings,
    scoredPageUrls,
    ruleMeta,
    pages,
  } = input;

  return Effect.gen(function* () {
    // Crawled this run = pages that produced page-rule results (keyed by
    // normalizedUrl). Include all stored pages too (some may be cache-fresh
    // with no fresh checks but still re-observed — they count as crawled).
    const crawledUrls = new Set<string>();
    for (const url of scoredPageUrls) crawledUrls.add(url);
    for (const p of pages) crawledUrls.add(p.normalizedUrl);

    const removedUrls = new Set<string>();
    const statusByUrl = new Map<string, number>();
    for (const p of pages) {
      statusByUrl.set(p.normalizedUrl, p.status);
      if (REMOVED_STATUSES.has(p.status)) {
        removedUrls.add(p.normalizedUrl);
        crawledUrls.delete(p.normalizedUrl);
      }
    }

    // Severity per rule (for surfacing carried findings).
    const severityByRule = new Map<string, string>();
    for (const [ruleId, t] of ruleMeta) {
      severityByRule.set(ruleId, t.meta.severity);
    }

    const merged = yield* mergeFindings({
      store: storage,
      siteKey,
      crawlId,
      crawledUrls,
      freshFindings,
      removedUrls,
      severityByRule,
      statusByUrl,
    });

    // Persist: removed pages (transactional stale) first, then the rest.
    for (const url of removedUrls) {
      const status = pages.find((p) => p.normalizedUrl === url)?.status ?? 404;
      yield* storage.markPageRemoved(siteKey, url, crawlId, status);
    }
    // upsert non-removed findings + site pages (removed already handled).
    const findingsToPersist: PageFindingRecord[] = merged.persisted.filter(
      (f) => !removedUrls.has(f.normalizedUrl)
    );
    yield* storage.upsertFindings(findingsToPersist);
    const sitePagesToPersist: SitePageRecord[] = merged.sitePages.filter(
      (p) => !removedUrls.has(p.normalizedUrl)
    );
    yield* storage.upsertSitePages(sitePagesToPersist);

    // Best-effort hygiene: prune this site's stale terminal rows (#197). Only
    // ever touches resolved/stale findings + removed pages (never open/carried),
    // so it cannot affect the merged report. Wrapped to NEVER fail the audit —
    // a compaction error degrades to "no pruning this run", same as the
    // controller's degrade-on-error path around runSmartAudits.
    yield* Effect.catchAll(storage.compactFindings(siteKey), () => Effect.void);

    // Carried pages = every active page NOT (re-)crawled this run. This MUST
    // include clean carried pages (no open findings) so the union scorer can
    // emit synthetic passes for them — otherwise the pass-ratio denominator
    // would drop those pages and a partial re-audit could inflate the score.
    const carriedPageUrls = new Set<string>();
    for (const url of merged.activePageUrls) {
      if (!crawledUrls.has(url)) carriedPageUrls.add(url);
    }

    // Carried findings = active (open) findings on those carried pages, SPLIT by
    // whether any audit has ever rendered the page (#1652): a never-rendered
    // page's finding was not inherited from a previous run, so it must not be
    // counted as carried nor given a last-seen date implying an earlier look.
    const carriedFindings: CarriedFinding[] = [];
    const carriedLastSeen = new Map<string, number>();
    let unrenderedCount = 0;
    for (const f of merged.findings) {
      if (f.provenance !== "carried") continue;
      carriedFindings.push({
        normalizedUrl: f.normalizedUrl,
        ruleId: f.ruleId,
        checkName: f.checkName,
        status: f.status,
        message: f.message,
        value: f.value,
        expected: f.expected,
        payload: f.payload,
        neverRendered: f.neverRendered,
      });
      if (f.neverRendered) {
        unrenderedCount++;
        continue;
      }
      carriedLastSeen.set(
        carriedKey(f.normalizedUrl, f.ruleId, f.checkName),
        f.lastSeenAt
      );
    }

    // Rule meta index for carried-only rules absent from this run.
    const ruleMetaIndex = new Map<string, RuleRunResult["meta"]>();
    for (const [ruleId, t] of ruleMeta) {
      ruleMetaIndex.set(ruleId, t.meta);
    }
    if (carriedFindings.length > 0) {
      const registry = loadAllRules();
      for (const f of carriedFindings) {
        if (ruleMetaIndex.has(f.ruleId)) continue;
        const rule = registry.get(f.ruleId);
        if (rule) ruleMetaIndex.set(f.ruleId, rule.meta);
      }
    }

    // The fresh half of the union is supplied EMPTY (#2343): every rule that ran,
    // with its meta and no checks. `buildScoringResultsFromMerged` reads
    // freshResults for exactly two things — the meta and which rules are
    // page-scope (to decide which rules the carried pages count against) — and
    // otherwise only appends to the checks array, so handing it empty arrays
    // yields precisely the carried half. The consumer joins this with the fresh
    // checks it reads back from `rule_results`, dropping the ones on
    // `removedUrls` (a removed page is not one of the "known non-removed" pages
    // the union covers), which is the filter this used to apply here.
    const freshShell = new Map<string, RuleRunResult>();
    for (const [ruleId, t] of ruleMeta)
      freshShell.set(ruleId, { meta: t.meta, checks: [] });

    const carriedRuleResults = buildScoringResultsFromMerged({
      freshResults: freshShell,
      carriedFindings,
      carriedPageUrls,
      ruleMetaIndex,
    });

    return {
      carriedRuleResults,
      removedUrls,
      coverage: {
        auditedPages: crawledUrls.size,
        knownPages: merged.activePageUrls.size,
        carriedFindings: carriedFindings.length - unrenderedCount,
        ...(unrenderedCount > 0 ? { unrenderedFindings: unrenderedCount } : {}),
      },
      carriedLastSeen,
    };
  });
}

/**
 * Tag a report check as carried (with lastSeenAt) if it matches a carried key.
 *
 * (#1652) The `?? "fresh"` fallback is load-bearing, not defensive: the union
 * scorer already stamped `provenance: "unrendered"` on findings whose page no
 * audit has rendered, and those keys are absent from `carriedLastSeen`, so
 * preserving an existing provenance is what keeps them out of the carried label.
 */
export function tagCarriedCheck(
  pageUrl: string,
  ruleId: string,
  check: CheckResult,
  carriedLastSeen: Map<string, number>
): void {
  const lastSeen = carriedLastSeen.get(carriedKey(pageUrl, ruleId, check.name));
  if (lastSeen !== undefined) {
    check.provenance = "carried";
    check.lastSeenAt = lastSeen;
  } else {
    check.provenance = check.provenance ?? "fresh";
  }
}
