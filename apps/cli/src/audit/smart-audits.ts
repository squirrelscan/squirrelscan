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
  flattenChecks,
  mergeFindings,
  type CarriedFinding,
} from "@squirrelscan/audit-engine";
import { loadAllRules, type RuleRunResult } from "@squirrelscan/rules";
import { Effect } from "effect";

import type { RuleExecutionResult } from "@/audit/adapter";

const REMOVED_STATUSES = new Set([404, 410]);

/** Stable identity for a carried finding, used to tag report checks. */
function carriedKey(
  pageUrl: string,
  ruleId: string,
  checkName: string
): string {
  return `${pageUrl}|${ruleId}|${checkName}`;
}

export interface SmartAuditResult {
  /** UNION rule results (fresh + carried) for scoring + report rebuild. */
  unionRuleResults: Map<string, RuleRunResult>;
  /** Coverage line data for surfacing. */
  coverage: {
    auditedPages: number;
    knownPages: number;
    carriedFindings: number;
  };
  /** carriedKey → lastSeenAt (epoch ms) for tagging report checks as carried. */
  carriedLastSeen: Map<string, number>;
}

export interface RunSmartAuditsInput {
  storage: CrawlStorage;
  crawlId: string;
  /** Site-scoped key = normalized base-site origin (same as getCrawlByUrl). */
  siteKey: string;
  ruleResults: RuleExecutionResult;
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
  const { storage, crawlId, siteKey, ruleResults, pages } = input;

  return Effect.gen(function* () {
    // Crawled this run = pages that produced page-rule results (keyed by
    // normalizedUrl). Include all stored pages too (some may be cache-fresh
    // with no fresh checks but still re-observed — they count as crawled).
    const crawledUrls = new Set<string>();
    for (const url of ruleResults.pageRuleResults.keys()) crawledUrls.add(url);
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
    for (const [ruleId, r] of ruleResults.ruleResultsMap) {
      severityByRule.set(ruleId, r.meta.severity);
    }

    // Flatten fresh page-scope fail/warn checks into findings. Skip pages that
    // returned 404/410 this run — they are removed, not active issues.
    const freshFindings = [];
    for (const [pageUrl, ruleChecks] of ruleResults.pageRuleResults) {
      if (removedUrls.has(pageUrl)) continue;
      for (const [ruleId, checks] of ruleChecks) {
        freshFindings.push(...flattenChecks(pageUrl, ruleId, checks));
      }
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

    // Carried findings = active (open) findings on those carried pages.
    const carriedFindings: CarriedFinding[] = [];
    const carriedLastSeen = new Map<string, number>();
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
      });
      carriedLastSeen.set(
        carriedKey(f.normalizedUrl, f.ruleId, f.checkName),
        f.lastSeenAt
      );
    }

    // Rule meta index for carried-only rules absent from this run.
    const ruleMetaIndex = new Map<string, RuleRunResult["meta"]>();
    for (const [ruleId, r] of ruleResults.ruleResultsMap) {
      ruleMetaIndex.set(ruleId, r.meta);
    }
    if (carriedFindings.length > 0) {
      const registry = loadAllRules();
      for (const f of carriedFindings) {
        if (ruleMetaIndex.has(f.ruleId)) continue;
        const rule = registry.get(f.ruleId);
        if (rule) ruleMetaIndex.set(f.ruleId, rule.meta);
      }
    }

    // Drop checks for removed (404/410) pages from the fresh results before
    // union scoring — removed pages are not "known non-removed" pages. Only
    // page-scope checks carry a pageUrl; site-scope checks (pageUrl undefined)
    // pass through untouched.
    const freshResults =
      removedUrls.size === 0
        ? ruleResults.ruleResultsMap
        : new Map(
            Array.from(ruleResults.ruleResultsMap, ([ruleId, r]) => [
              ruleId,
              {
                meta: r.meta,
                checks: r.checks.filter(
                  (c) => !(c.pageUrl && removedUrls.has(c.pageUrl))
                ),
              },
            ])
          );

    const unionRuleResults = buildScoringResultsFromMerged({
      freshResults,
      carriedFindings,
      carriedPageUrls,
      ruleMetaIndex,
    });

    return {
      unionRuleResults,
      coverage: {
        auditedPages: crawledUrls.size,
        knownPages: merged.activePageUrls.size,
        carriedFindings: carriedFindings.length,
      },
      carriedLastSeen,
    };
  });
}

/** Tag a report check as carried (with lastSeenAt) if it matches a carried key. */
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
