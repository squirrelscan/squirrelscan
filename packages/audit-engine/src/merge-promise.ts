// Smart audits — Promise/Worker merge wrapper + cloud orchestrator (#195).
//
// The API runs on Cloudflare Workers (no node builtins, no Effect runtime over
// `CrawlStorage`). This module mirrors the CLI's Effect merge (`merge.ts`) +
// orchestration (`apps/cli/.../smart-audits.ts`) using plain Promises over a
// NARROW `SmartAuditStore` (6 methods, NOT the 60-method `CrawlStorage`), and
// reuses the SAME pure core (`computeMerge`) + union scorer
// (`buildScoringResultsFromMerged`) so cloud + local stay in lockstep.
//
// Worker-clean: imports only `./merge-core`, `./fingerprint`, `./scoring`
// (de-linkedom'd via `@squirrelscan/rules/categories`) and
// `@squirrelscan/utils/url`. Surfaced via the package's `./smart-audits` entry.

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
// `/types` (leaf type module) not the barrel — see scoring.ts. (#195)
import { unfoldAggregateCheck } from "@squirrelscan/rules/fold";
import type { RuleRunResult } from "@squirrelscan/rules/types";
import { normalizeUrl } from "@squirrelscan/utils/url";

import {
  computeMerge,
  flattenChecks,
  type FlatFinding,
  type MergedState,
  type MergeResolutionInput,
} from "./merge-core";
import { reconstructCompleteResults } from "./reconstruct";
import type { SkippedPassCounts } from "./stream-findings";
import { buildScoringResultsFromMerged, type CarriedFinding } from "./scoring";

/** 404/410 = page gone → stale its findings (not carry). */
const REMOVED_STATUSES = new Set([404, 410]);

/**
 * Narrow Promise port of the smart-audits store surface. A backing store
 * (Postgres, in P3) keys everything by `siteKey` — the API passes the
 * org-scoped `website_id` as the siteKey.
 */
export interface SmartAuditStore {
  /** Findings for a site, optionally restricted to lifecycle `states`. */
  getFindings(siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]>;
  getSitePages(siteKey: string): Promise<SitePageRecord[]>;
  upsertFindings(findings: PageFindingRecord[]): Promise<void>;
  upsertSitePages(pages: SitePageRecord[]): Promise<void>;
  /** Page→removed + its findings→stale in ONE transaction. */
  markPageRemoved(
    siteKey: string,
    normalizedUrl: string,
    crawlId: string,
    lastStatus: number,
  ): Promise<void>;
  /** Bulk page→removed + findings→stale for all pages in ONE transaction; empty = no-op (#288). */
  markPagesRemoved(
    siteKey: string,
    pages: Array<{ normalizedUrl: string; lastStatus: number }>,
    crawlId: string,
  ): Promise<void>;
  /** Best-effort prune of terminal rows (never open/active). Returns rows deleted. */
  compactFindings(siteKey: string): Promise<number>;
}

export interface MergeFindingsPromiseInput {
  store: SmartAuditStore;
  siteKey: string;
  crawlId: string;
  crawledUrls: Set<string>;
  freshFindings: FlatFinding[];
  removedUrls: Set<string>;
  severityByRule: Map<string, string>;
  statusByUrl: Map<string, number>;
  /** Epoch ms; defaults to Date.now(). */
  now?: number;
  /** (#1167) Truncated-check sample sets — see {@link ComputeMergeInput.sampledCheckPages}. */
  sampledCheckPages?: Map<string, Set<string>>;
  /** (#1185) Pre-indexed publish resolution signal — see {@link ComputeMergeInput.resolution}. */
  resolution?: MergeResolutionInput;
}

/**
 * Promise mirror of {@link mergeFindings}: load prior OPEN findings + site pages
 * via the store, then run the pure {@link computeMerge}.
 */
export async function mergeFindingsPromise(input: MergeFindingsPromiseInput): Promise<MergedState> {
  const { store, siteKey, now, ...rest } = input;
  const priorFindings = await store.getFindings(siteKey, ["open"]);
  const priorPages = await store.getSitePages(siteKey);
  return computeMerge({
    ...rest,
    siteKey,
    priorFindings,
    priorPages,
    now: now ?? Date.now(),
  });
}

export interface CloudSmartAuditsInput {
  store: SmartAuditStore;
  /** Org-scoped site identity (= website_id). */
  siteKey: string;
  /** This run's audit id (= page_findings.last_seen_crawl_id). */
  crawlId: string;
  /** This run's rule results (the published report's `ruleResults`). */
  ruleResults: Record<string, { meta: RuleRunResult["meta"]; checks: CheckResult[] }>;
  /**
   * Compact per-page HTTP status for THIS run (raw or normalized urls — they're
   * re-normalized here). Lets the merge stale findings on pages that 404/410'd
   * vs carry un-crawled ones. Empty → removed-detection is skipped (carry-only)
   * and crawled pages are derived from `ruleResults` check pageUrls alone.
   */
  pageStatuses: Array<{ url: string; status: number }>;
  /**
   * (#1185) Unsampled resolution signal from the publish payload
   * (`report.resolutionSignal`). Absent for old CLIs/containers → the merge
   * behaves exactly as pre-#1185.
   */
  resolutionSignal?: ResolutionSignal;
  /**
   * (#1023 R-D3) Complete-store finalize override. When set, `freshResults` and
   * the scoring `crawledUrls` are reconstructed from the COMPLETE findings the
   * chunked-publish path streamed into the store, instead of the #1167-sampled
   * `ruleResults` (the #1179 starvation fix). The #1167 sample carry-guard and
   * #1185 resolution signal are MOOT in this mode — complete findings make a
   * page's absence from the fresh set authoritative — so both are skipped.
   */
  completeStore?: {
    /** Complete per-(page,rule,check,locator) findings for this audit. */
    ingestedFindings: PageFindingRecord[];
    /** Full crawled-URL list (`resolutionSignal.crawledUrls`); normalized here. */
    crawledUrls: string[];
    /**
     * (#1305) Per-(ruleId, checkName) passing-sibling counts on dirty pages — added
     * to `syntheticPassCount` so multi-checkName rules score at the sampled path's
     * granularity. See {@link reconstructCompleteResults}.
     */
    skippedPassCounts?: SkippedPassCounts;
  };
  /** Epoch ms; defaults to Date.now(). */
  now?: number;
}

export interface CloudSmartAuditsResult {
  /** UNION rule results (fresh + carried) for authoritative scoring + report. */
  unionRuleResults: Map<string, RuleRunResult>;
  /** Coverage line data for surfacing. */
  coverage: { auditedPages: number; knownPages: number; carriedFindings: number };
  /** `${normalizedUrl}|${ruleId}|${checkName}` → lastSeenAt for tagging report checks. */
  carriedLastSeen: Map<string, number>;
  persistedFindings: number;
  removedPages: number;
  /**
   * (#1023 R-D3) True when scoring ran off the reconstructed complete store
   * (freshResults from findings + `syntheticPassCount` for fresh clean pages).
   * The caller uses it to fold `syntheticPassCount` into `report.passed`
   * (page-rule passes are counts here, not materialized checks).
   */
  completeStore: boolean;
}

/** Stable identity for a carried finding, used to tag report checks (mirror CLI). */
function carriedKey(normalizedUrl: string, ruleId: string, checkName: string): string {
  return `${normalizedUrl}|${ruleId}|${checkName}`;
}

/**
 * Cloud equivalent of the CLI's `runSmartAudits`: flatten this run's report into
 * findings, merge against the site store, persist, and return a UNION scoring
 * map + coverage. Persists findings + site pages as a side effect. Logic mirrors
 * `apps/cli/src/audit/smart-audits.ts` (keep them in sync).
 */
export async function runCloudSmartAudits(
  input: CloudSmartAuditsInput,
): Promise<CloudSmartAuditsResult> {
  const { store, siteKey, crawlId } = input;
  const now = input.now ?? Date.now();
  const completeStore = input.completeStore;

  // Rule meta + severity indexes from the report's ruleResults (both modes — the
  // shell always carries every rule that ran, so this is the meta source even in
  // complete mode where page-rule CHECKS come from the store instead).
  const ruleMetaIndex = new Map<string, RuleRunResult["meta"]>();
  const severityByRule = new Map<string, string>();
  for (const [ruleId, r] of Object.entries(input.ruleResults)) {
    ruleMetaIndex.set(ruleId, r.meta);
    severityByRule.set(ruleId, r.meta.severity);
  }

  // Per-page status → removed set (404/410) + statusByUrl, keyed by normalized url.
  const statusByUrl = new Map<string, number>();
  const removedUrls = new Set<string>();
  for (const ps of input.pageStatuses) {
    const u = normalizeUrl(ps.url);
    statusByUrl.set(u, ps.status);
    if (REMOVED_STATUSES.has(ps.status)) removedUrls.add(u);
  }

  // freshResults + crawledUrls + the #1167 sampled-check sets. COMPLETE mode
  // (#1023 R-D3) reconstructs freshResults from the store's complete findings and
  // takes crawledUrls from the unsampled signal; the sampled carry-guard is moot,
  // so sampledCheckPages stays empty. SAMPLE mode derives all three from the
  // #1167-sampled ruleResults.
  let freshResults: Map<string, RuleRunResult>;
  const crawledUrls = new Set<string>();
  const sampledCheckPages = new Map<string, Set<string>>();
  if (completeStore) {
    for (const u of completeStore.crawledUrls) crawledUrls.add(normalizeUrl(u));
    for (const u of statusByUrl.keys()) crawledUrls.add(u);
    for (const u of removedUrls) crawledUrls.delete(u);
    // Reconstruct AFTER crawledUrls is final — the per-rule syntheticPassCount
    // denominator (crawled − failing pages) is measured against it.
    freshResults = reconstructCompleteResults({
      ruleResults: input.ruleResults,
      ingestedFindings: completeStore.ingestedFindings,
      crawledUrls,
      skippedPassCounts: completeStore.skippedPassCounts,
    });
  } else {
    // A published report arrives already folded (#910): an over-cap per-rule
    // check array is collapsed into per-issue-class aggregates that carry every
    // affected page in `pages` but have NO `pageUrl`. Unfold them back to
    // per-page checks so the flatten + union scoring below see real per-page
    // findings — otherwise every over-cap rule is silently dropped by the
    // `if (!c.pageUrl) continue` gate and contributes zero findings/occurrences
    // to the union store and score (#916). No-op on un-folded checks.
    freshResults = new Map<string, RuleRunResult>();
    for (const [ruleId, r] of Object.entries(input.ruleResults)) {
      const checks = r.checks.flatMap(unfoldAggregateCheck);
      freshResults.set(ruleId, { meta: r.meta, checks });
    }
    // Crawled this run = every page that produced a check (page-scope checks
    // carry a pageUrl) ∪ every page in pageStatuses, minus the removed ones.
    for (const r of freshResults.values()) {
      for (const c of r.checks) {
        if (c.pageUrl) crawledUrls.add(normalizeUrl(c.pageUrl));
      }
    }
    for (const u of statusByUrl.keys()) crawledUrls.add(u);
    for (const u of removedUrls) crawledUrls.delete(u);

    // (#1167) Build the truncated-check sample sets: a published aggregate whose
    // `pages[]` was sampled carries `details.pagesTruncated` > its retained
    // length. Record each such check's retained (sampled) urls so the merge can
    // carry — not resolve — a still-failing page clipped out of the sample. Keyed
    // `${ruleId}|${checkName}` to match computeMerge's lookup.
    for (const [ruleId, r] of Object.entries(input.ruleResults)) {
      for (const c of r.checks) {
        const truncated =
          typeof c.details?.pagesTruncated === "number" &&
          !!c.pages &&
          c.details.pagesTruncated > c.pages.length;
        if (!truncated) continue;
        const key = `${ruleId}|${c.name}`;
        let set = sampledCheckPages.get(key);
        if (!set) {
          set = new Set<string>();
          sampledCheckPages.set(key, set);
        }
        for (const p of c.pages!) set.add(normalizeUrl(p));
      }
    }
  }

  // Flatten fresh page-scope fail/warn checks into findings, grouped per page
  // (flattenChecks stamps one normalizedUrl across the checks it's given). Skip
  // pages removed this run — they're gone, not active issues.
  const freshFindings: FlatFinding[] = [];
  for (const [ruleId, r] of freshResults) {
    const byUrl = new Map<string, CheckResult[]>();
    for (const c of r.checks) {
      if (!c.pageUrl) continue; // site-scope check — not a per-page finding
      const u = normalizeUrl(c.pageUrl);
      if (removedUrls.has(u)) continue;
      let arr = byUrl.get(u);
      if (!arr) {
        arr = [];
        byUrl.set(u, arr);
      }
      arr.push(c);
    }
    for (const [u, checks] of byUrl) {
      freshFindings.push(...flattenChecks(u, ruleId, checks));
    }
  }

  // (#1185) Index the unsampled resolution signal for the merge. The signal's
  // crawled set feeds ONLY the resolve decision inside computeMerge — it is
  // deliberately NOT unioned into `crawledUrls` above: that set drives scoring
  // (carriedPageUrls → syntheticPassCount) and site_pages, and a clean page
  // clipped from every published sample must STAY a carried page so its
  // synthetic pass keeps counting in the union denominator. Skipped in complete
  // mode (#1023): the store's findings are unsampled, so the merge already sees
  // authoritative per-page evidence — the resolution override is moot.
  let resolution: MergeResolutionInput | undefined;
  if (!completeStore && input.resolutionSignal) {
    const signalCrawled = new Set<string>();
    for (const u of input.resolutionSignal.crawledUrls) signalCrawled.add(normalizeUrl(u));
    const failingByCheck = new Map<string, Set<string>>();
    for (const [key, hashes] of Object.entries(input.resolutionSignal.failing)) {
      failingByCheck.set(key, new Set(hashes));
    }
    const notEvaluatedByCheck = new Map<string, Set<string>>();
    for (const [key, hashes] of Object.entries(input.resolutionSignal.notEvaluated ?? {})) {
      notEvaluatedByCheck.set(key, new Set(hashes));
    }
    resolution = {
      crawledUrls: signalCrawled,
      failingByCheck,
      notEvaluatedByCheck,
      truncatedChecks: new Set(input.resolutionSignal.truncated ?? []),
    };
  }

  const merged = await mergeFindingsPromise({
    store,
    siteKey,
    crawlId,
    crawledUrls,
    freshFindings,
    removedUrls,
    severityByRule,
    statusByUrl,
    now,
    sampledCheckPages,
    resolution,
  });

  // Persist: removed pages (transactional stale) first, then the rest. One tx
  // for the whole removed set rather than one round-trip per url (#288).
  const removedPages = Array.from(removedUrls, (url) => ({
    normalizedUrl: url,
    lastStatus: statusByUrl.get(url) ?? 404,
  }));
  await store.markPagesRemoved(siteKey, removedPages, crawlId);
  await store.upsertFindings(merged.persisted.filter((f) => !removedUrls.has(f.normalizedUrl)));
  await store.upsertSitePages(merged.sitePages.filter((p) => !removedUrls.has(p.normalizedUrl)));
  // Best-effort hygiene — only ever prunes terminal rows, never open/carried, so
  // it can't affect the merged report. NEVER fail the audit on a prune error.
  try {
    await store.compactFindings(siteKey);
  } catch {
    // degrade to "no pruning this run"
  }

  // Carried pages = every active page NOT (re-)crawled this run (incl. clean
  // ones, so the union scorer can emit synthetic passes for them).
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
    carriedLastSeen.set(carriedKey(f.normalizedUrl, f.ruleId, f.checkName), f.lastSeenAt);
  }

  // Drop checks for removed (404/410) pages from the fresh results before union
  // scoring — removed pages are not "known non-removed" pages. Site-scope checks
  // (no pageUrl) pass through untouched.
  const freshForUnion =
    removedUrls.size === 0
      ? freshResults
      : new Map(
          Array.from(freshResults, ([ruleId, r]) => [
            ruleId,
            {
              meta: r.meta,
              checks: r.checks.filter(
                (c) => !(c.pageUrl && removedUrls.has(normalizeUrl(c.pageUrl))),
              ),
              // Preserve the complete-store fresh-clean pass count (#1023) — a
              // removed page was already excluded from crawledUrls before the
              // reconstruction measured it, so the count is still correct.
              ...(r.syntheticPassCount !== undefined
                ? { syntheticPassCount: r.syntheticPassCount }
                : {}),
            },
          ]),
        );

  const unionRuleResults = buildScoringResultsFromMerged({
    freshResults: freshForUnion,
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
    persistedFindings: merged.persisted.length,
    removedPages: removedUrls.size,
    completeStore: !!completeStore,
  };
}
