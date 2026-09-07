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
  createMergeSession,
  flattenChecks,
  type FlatFinding,
  type MergedFinding,
  type MergedState,
  type MergeResolutionInput,
} from "./merge-core";
import {
  createCompleteStoreTallyFold,
  foldCompleteStoreTallies,
  type FindingPageSource,
} from "./complete-store-fold";
import type { SkippedPassCounts } from "./stream-findings";
import {
  buildScoringResultsFromMerged,
  type CarriedFinding,
  type CarriedUnionSource,
  type RuleTally,
} from "./scoring";


/** 404/410 = page gone → stale its findings (not carry). */
const REMOVED_STATUSES = new Set([404, 410]);

/**
 * Rows buffered before a merge flush (#1876).
 *
 * MEASURED, and smaller than it looks like it should be. The flush's cost is not
 * the rows it holds but the transient graph the driver builds around them — an
 * insert of 500 findings is 8,500 bound parameters plus a dictionary insert — and
 * that spike lands on top of whatever the page loop is holding. Halving the batch
 * took ~15 MiB off the finalize's peak at 60,000 carried findings, for round trips
 * that cost single-digit milliseconds each.
 */
const MERGE_PERSIST_BATCH = 200;

/**
 * One page's OPEN findings, split by which audit last saw them (#1876).
 *
 * Both halves come from ONE cursor over `page_findings`, which is what makes the
 * fold's page-boundary contract structural: a page's fresh evidence and the
 * findings earlier audits left on it are handed over together, so they cannot land
 * in two different `addChecksToTally` calls. Two independent cursors could not
 * promise that without comparing URLs across them in JS, and JS string order is not
 * the database's collation.
 */
export interface OpenFindingPage {
  normalizedUrl: string;
  /** Ingested by THIS audit (`lastSeenCrawlId === crawlId`). */
  fresh: readonly PageFindingRecord[];
  /** Left open by an EARLIER audit — the merge decides carry/resolve/stale. */
  prior: readonly PageFindingRecord[];
}

/** Pages in `normalizedUrl` order, each yielded exactly once and never split. */
export type OpenFindingPageSource = AsyncIterable<OpenFindingPage>;

/** Prior findings a page at a time; a page must never be split across two items. */
export type PriorFindingPageSource = AsyncIterable<readonly PageFindingRecord[]>;

/**
 * Narrow Promise port of the smart-audits store surface. A backing store
 * (Postgres, in P3) keys everything by `siteKey` — the API passes the
 * org-scoped `website_id` as the siteKey.
 */
export interface SmartAuditStore {
  /** Findings for a site, optionally restricted to lifecycle `states`. */
  getFindings(siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]>;
  /**
   * (#1876) OPTIONAL page-at-a-time cursor over the same rows {@link getFindings}
   * returns. When a store offers it, the merge decides carry/resolve/stale in
   * bounded batches instead of over one array — which is the difference between a
   * partial re-audit of a site with 60,000 open findings costing hundreds of MB and
   * costing tens. A page's findings must never be split across two yields.
   *
   * Optional so an in-memory store (tests, fixtures) needs only `getFindings`.
   */
  streamFindingPages?(
    siteKey: string,
    states?: FindingState[],
  ): PriorFindingPageSource;
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
  /**
   * (#1873) Prior OPEN findings, already loaded by the caller — skips the
   * `store.getFindings(siteKey, ["open"])` read. The complete-store finalize uses
   * it to pass the findings this audit did NOT re-observe: the chunk ingest has
   * already upserted every re-observed finding under this run's crawlId, so the
   * store read would return the whole audit a second time.
   */
  priorFindings?: PageFindingRecord[];
}

/**
 * Promise mirror of {@link mergeFindings}: load prior OPEN findings + site pages
 * via the store, then run the pure {@link computeMerge}.
 */
export async function mergeFindingsPromise(input: MergeFindingsPromiseInput): Promise<MergedState> {
  const { store, siteKey, now, priorFindings: preloaded, ...rest } = input;
  const priorFindings = preloaded ?? (await store.getFindings(siteKey, ["open"]));
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
    /**
     * (#1873) Complete per-(page,rule,check,locator) findings for this audit,
     * delivered ONE PAGE AT A TIME and folded into per-rule tallies rather than
     * materialized — a 43k-finding audit does not fit in the 128 MB API isolate.
     * See {@link FindingPageSource} for the page-boundary contract.
     *
     * Pair with {@link priorOpenFindings}, or supply {@link openPages} instead.
     */
    findingPages?: FindingPageSource;
    /**
     * (#1873) Prior OPEN findings for the site EXCLUDING the rows this audit's
     * chunk ingest wrote. Those rows are the fresh evidence (already persisted, and
     * folded from `findingPages`), so loading them as "prior" would both double the
     * isolate's memory and make the merge reason about this run's own findings as if
     * a previous run had left them.
     *
     * MATERIALIZED, so it is bounded by the site's whole open backlog rather than by
     * this run — the #1876 OOM. Prefer {@link openPages}.
     */
    priorOpenFindings?: PageFindingRecord[];
    /**
     * (#1876) Both halves of the site's open findings from ONE cursor, a page at a
     * time — the bounded replacement for `findingPages` + `priorOpenFindings`, and
     * what the API's finalize supplies. When set, those two are ignored: the merge
     * decides each prior as it goes past, the fold folds the page's fresh and
     * carried findings together, and the rows are dropped.
     */
    openPages?: OpenFindingPageSource;
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
  /**
   * UNION rule results (fresh + carried) for authoritative scoring + report.
   *
   * (#1873) In COMPLETE-STORE mode this is the REPORT surface only: page-scope
   * rules carry the staged shell's bounded checks (the container's
   * `slimPageChecksForShell` aggregates, which keep every affected page as
   * `details.occurrences` + `pagesTruncated`) plus the carried replays — NOT one
   * check per affected page. The authoritative numbers come from
   * {@link scoringTallies} instead, which sees every page.
   */
  unionRuleResults: Map<string, RuleRunResult>;
  /**
   * (#1873) Per-rule folded tallies over the COMPLETE findings — present ONLY in
   * complete-store mode. When set, the caller MUST take the health score
   * (`calculateHealthScoreFromTallies`) and the passed/warnings/failed totals from
   * these, not from {@link unionRuleResults}: the tallies count every affected
   * page, the union map only lists the shell's sample.
   */
  scoringTallies?: Map<string, RuleTally>;
  /** Coverage line data for surfacing. */
  coverage: {
    auditedPages: number;
    knownPages: number;
    /** Findings a PREVIOUS audit observed. 0 on a first run (#1652). */
    carriedFindings: number;
    /**
     * Findings on pages no audit has ever rendered (#1652). OMITTED when zero so
     * a site without any is byte-identical to a pre-#1652 report — the published
     * report JSON feeds the publish idempotency hash and the golden fixtures.
     */
    unrenderedFindings?: number;
  };
  /**
   * `${normalizedUrl}|${ruleId}|${checkName}` → lastSeenAt for tagging report
   * checks as carried. (#1652) Never-rendered findings are DELIBERATELY absent:
   * they are stamped `provenance: "unrendered"` by the union scorer, and the
   * caller's tagging pass preserves an already-set provenance, so keeping them
   * out here is what stops them being relabelled "carried" with a bogus
   * last-seen date.
   */
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
    // (#1873) NOT reconstructed here. The complete findings are folded into
    // per-rule tallies page at a time (below, after the merge), so nothing
    // audit-sized is ever resident. `freshResults` keeps the SHELL's rules: they
    // are the report surface and the site-scope rules' checks, exactly what the
    // materialized reconstruction passed through untouched.
    freshResults = new Map<string, RuleRunResult>();
    for (const [ruleId, r] of Object.entries(input.ruleResults)) {
      freshResults.set(ruleId, { meta: r.meta, checks: r.checks });
    }
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
  // (#1873) Complete mode flattens NOTHING: the chunk ingest already persisted
  // this run's findings (same rows, same PK, and the store's LEAST(first_seen)
  // conflict rule already preserved the earliest first-seen), so re-deriving them
  // from the shell would both re-materialize the audit and re-write rows that are
  // already correct. The merge below therefore sees an empty fresh set and treats
  // the prior OPEN findings the caller passed — which EXCLUDE this run's ingest —
  // as the only rows needing a resolve/carry/stale decision.
  const freshFindings: FlatFinding[] = [];
  if (!completeStore) {
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

  // ── merge ────────────────────────────────────────────────────────────────
  //
  // (#1876) Prior findings stream past the merge rather than being loaded into an
  // array. The session settles the site's page set up front (it reads `priorPages`,
  // never a prior FINDING), which is what lets `carriedPageUrls` — and with it the
  // carried scoring fold — exist before the first prior arrives.
  const priorPages = await store.getSitePages(siteKey);
  let onPersist: (record: PageFindingRecord) => void = () => {};
  let onActive: (finding: MergedFinding) => void = () => {};
  const session = createMergeSession(
    {
      siteKey,
      crawlId,
      crawledUrls,
      freshFindings,
      removedUrls,
      severityByRule,
      statusByUrl,
      priorPages,
      now,
      sampledCheckPages,
      resolution,
    },
    {
      persist: (record) => onPersist(record),
      active: (finding) => onActive(finding),
    },
  );

  // Carried pages = every active page NOT (re-)crawled this run (incl. clean
  // ones, so the union scorer can emit synthetic passes for them).
  const carriedPageUrls = new Set<string>();
  for (const url of session.activePageUrls) {
    if (!crawledUrls.has(url)) carriedPageUrls.add(url);
  }

  const streamedComplete = completeStore?.openPages;
  // Writing as the merge streams is safe ONLY when the reader is a cursor that has
  // already passed the rows being written (it reads each page once, and the merge
  // only ever writes rows behind it). The materialized complete path reads its
  // fresh side from a SECOND source after the merge, so there it must still be
  // "fold first, then persist" — `computeMerge` stamps resolved rows with this
  // run's crawl id, and a fold that ran after them would read one back as fresh
  // evidence that the page still fails.
  const persistWhileStreaming = !completeStore || !!streamedComplete;

  let persistedFindings = 0;
  const pendingWrites: PageFindingRecord[] = [];
  const deferredWrites: PageFindingRecord[] = [];
  const flushWrites = async (): Promise<void> => {
    if (pendingWrites.length > 0) await store.upsertFindings(pendingWrites.splice(0));
  };
  onPersist = (record) => {
    persistedFindings += 1;
    // Findings on a page that 404/410'd are staled transactionally by
    // `markPagesRemoved` below, so the row written here would be overwritten.
    if (removedUrls.has(record.normalizedUrl)) return;
    (persistWhileStreaming ? pendingWrites : deferredWrites).push(record);
  };

  // Carried findings, SPLIT by whether any audit has ever rendered the page
  // (#1652): a never-rendered page's finding was not inherited from a previous run,
  // so it must not be counted as carried nor given a last-seen date implying an
  // earlier observation.
  let carriedCount = 0;
  let unrenderedCount = 0;
  const carriedLastSeen = new Map<string, number>();
  // Materialized only off the streaming path: there the union IS the score, and it
  // is bounded by the run rather than by the site's backlog.
  const carriedFindings: CarriedFinding[] = [];
  const pageCarried: CarriedFinding[] = [];

  let scoringTallies: Map<string, RuleTally> | undefined;
  let carriedSource: CarriedUnionSource | undefined;

  if (streamedComplete) {
    const fold = createCompleteStoreTallyFold({
      ruleResults: input.ruleResults,
      crawledUrls,
      skippedPassCounts: completeStore.skippedPassCounts,
      carriedPageUrls,
      ruleMetaIndex,
      // Same exclusion the union scoring applies below via `freshForUnion`: a
      // page that 404/410'd this run is not one of the known non-removed pages.
      removedUrls,
      // The report body's carried side comes out of the same replay, bounded.
      retainCarriedChecks: true,
    });
    onActive = (finding) => {
      if (finding.provenance !== "carried") return;
      carriedCount += 1;
      if (finding.neverRendered) unrenderedCount += 1;
      // No copy: `MergedFinding` already carries every field `CarriedFinding`
      // reads, `lastSeenAt` included — which is what stamps the replayed check
      // (#1876). One fewer object per carried finding, on the path where that
      // multiplies by the whole backlog.
      pageCarried.push(finding);
    };
    for await (const page of streamedComplete) {
      pageCarried.length = 0;
      session.addPriorFindings(page.prior);
      fold.foldPage(page.normalizedUrl, page.fresh, pageCarried);
      if (pendingWrites.length >= MERGE_PERSIST_BATCH) await flushWrites();
    }
    // Complete mode passes no fresh findings (the ingest already persisted them),
    // so this is normally empty — driven anyway so the contract holds either way.
    for (const record of session.finish().persisted) onPersist(record);
    await flushWrites();
    fold.foldShellRules();
    scoringTallies = fold.finish();
    carriedSource = fold.carriedUnion();
  } else {
    onActive = (finding) => {
      if (finding.provenance !== "carried") return;
      carriedCount += 1;
      const carried = toCarriedFinding(finding);
      carriedFindings.push(carried);
      if (finding.neverRendered) {
        unrenderedCount += 1;
        return;
      }
      carriedLastSeen.set(
        carriedKey(finding.normalizedUrl, finding.ruleId, finding.checkName),
        finding.lastSeenAt,
      );
    };
    for await (const batch of priorFindingPages(store, siteKey, completeStore?.priorOpenFindings)) {
      session.addPriorFindings(batch);
      if (persistWhileStreaming && pendingWrites.length >= MERGE_PERSIST_BATCH) {
        await flushWrites();
      }
    }
    for (const record of session.finish().persisted) onPersist(record);
    if (persistWhileStreaming) await flushWrites();

    // (#1873) COMPLETE mode, materialized inputs: fold this audit's findings into
    // per-rule tallies, page at a time, off the caller's fresh source.
    //
    // ORDER IS LOAD-BEARING — this MUST run before the deferred writes below.
    if (completeStore) {
      scoringTallies = await foldCompleteStoreTallies({
        ruleResults: input.ruleResults,
        findingPages: completeStore.findingPages ?? emptyPageSource(),
        crawledUrls,
        skippedPassCounts: completeStore.skippedPassCounts,
        carriedFindings,
        carriedPageUrls,
        ruleMetaIndex,
        removedUrls,
      });
      // Pushed one at a time: a spread of a whole site's backlog is an argument
      // list, and an argument list has a limit an array does not.
      for (const record of deferredWrites) pendingWrites.push(record);
      deferredWrites.length = 0;
      await flushWrites();
    }
  }

  // Persist: removed pages (transactional stale) first, then the rest. One tx
  // for the whole removed set rather than one round-trip per url (#288).
  const removedPages = Array.from(removedUrls, (url) => ({
    normalizedUrl: url,
    lastStatus: statusByUrl.get(url) ?? 404,
  }));
  await store.markPagesRemoved(siteKey, removedPages, crawlId);
  await store.upsertSitePages(
    session.sitePages.filter((p) => !removedUrls.has(p.normalizedUrl)),
  );
  // Best-effort hygiene — only ever prunes terminal rows, never open/carried, so
  // it can't affect the merged report. NEVER fail the audit on a prune error.
  try {
    await store.compactFindings(siteKey);
  } catch {
    // degrade to "no pruning this run"
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
    ...(carriedSource ? { carriedSource } : {}),
  });

  return {
    unionRuleResults,
    ...(scoringTallies ? { scoringTallies } : {}),
    coverage: {
      auditedPages: crawledUrls.size,
      knownPages: session.activePageUrls.size,
      carriedFindings: carriedCount - unrenderedCount,
      ...(unrenderedCount > 0 ? { unrenderedFindings: unrenderedCount } : {}),
    },
    carriedLastSeen,
    persistedFindings,
    removedPages: removedUrls.size,
    completeStore: !!completeStore,
  };
}

/** No fresh side at all — a complete-store caller that passed only priors. */
async function* emptyPageSource(): FindingPageSource {
  // Intentionally yields nothing.
}

/**
 * Prior OPEN findings, page at a time: the caller's own set when it supplied one
 * (the complete-store finalize excludes this audit's ingest), else the store's
 * cursor, else one array from `getFindings` for stores without a cursor.
 */
async function* priorFindingPages(
  store: SmartAuditStore,
  siteKey: string,
  preloaded: PageFindingRecord[] | undefined,
): PriorFindingPageSource {
  if (preloaded) {
    if (preloaded.length > 0) yield preloaded;
    return;
  }
  if (store.streamFindingPages) {
    yield* store.streamFindingPages(siteKey, ["open"]);
    return;
  }
  const all = await store.getFindings(siteKey, ["open"]);
  if (all.length > 0) yield all;
}

/**
 * The merge's view of a carried finding, reduced to what the scorers replay.
 *
 * The SAMPLED path only, and the reduction is the point: dropping `lastSeenAt`
 * is what keeps the replayed check untagged there, so the caller's
 * `carriedLastSeen` pass still does the tagging its callers assert. The streaming
 * path passes the `MergedFinding` straight through instead — it has no such map to
 * tag from, and building one would be the allocation #1876 exists to remove.
 */
function toCarriedFinding(f: MergedFinding): CarriedFinding {
  return {
    normalizedUrl: f.normalizedUrl,
    ruleId: f.ruleId,
    checkName: f.checkName,
    status: f.status,
    message: f.message,
    value: f.value,
    expected: f.expected,
    payload: f.payload,
    neverRendered: f.neverRendered,
  };
}
