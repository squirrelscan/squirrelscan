// Smart audits — pure merge core (#110/#195).
//
// Storage-agnostic, dependency-free heart of the finding merge. NO node
// builtins, NO Effect, NO store I/O — just the in-memory state machine over
// already-loaded prior state. Both the CLI's Effect wrapper (`merge.ts`, over
// `CrawlStorage`) and the API's Promise wrapper (`merge-promise.ts`, over
// `SmartAuditStore`) load prior findings/pages their own way, then call
// `computeMerge`, so the algorithm lives in EXACTLY one place (no drift).

import type {
  CheckResult,
  FindingProvenance,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";

import { findingFingerprint } from "./fingerprint";

/** A finding flattened from a CheckResult, ready to key/persist. */
export interface FlatFinding {
  normalizedUrl: string;
  ruleId: string;
  checkName: string;
  /** Within-page locator (item id) or "" for a whole-check finding. */
  locator: string;
  status: string;
  message: string;
  value: string | null;
  expected: string | null;
  /** Serialized item/details/pages so the report can be rebuilt from storage. */
  payload: string | null;
}

/** A finding carrying its identity + scoring/report metadata. */
export interface MergedFinding {
  siteKey: string;
  normalizedUrl: string;
  ruleId: string;
  checkName: string;
  locator: string;
  status: string;
  severity: string;
  message: string;
  value: string | null;
  expected: string | null;
  payload: string | null;
  fingerprint: string;
  firstSeenAt: number;
  lastSeenCrawlId: string;
  lastSeenAt: number;
  provenance: FindingProvenance;
  state: "open" | "resolved" | "stale";
}

/** Outcome of a merge — the union of active findings + the active page set. */
export interface MergedState {
  /** Active (open) findings across the union of non-removed pages. */
  findings: MergedFinding[];
  /** All records persisted this run (open + resolved + stale) for upsert. */
  persisted: PageFindingRecord[];
  /** Site pages to upsert (active + removed) this run. */
  sitePages: SitePageRecord[];
  /** Normalized URLs of pages active (non-removed) after the merge. */
  activePageUrls: Set<string>;
}

/** Inputs to {@link computeMerge}: this run's evidence + already-loaded prior state. */
export interface ComputeMergeInput {
  siteKey: string;
  crawlId: string;
  /** Normalized URLs successfully (re-)crawled this run — fresh evidence. */
  crawledUrls: Set<string>;
  /** Findings produced this run, flattened from CheckResults. */
  freshFindings: FlatFinding[];
  /** Normalized URLs that returned 404/410 this run (page gone). */
  removedUrls: Set<string>;
  /** Rule severity lookup (ruleId -> severity) for surfacing carried findings. */
  severityByRule: Map<string, string>;
  /** Real per-page HTTP status (normalizedUrl -> status) for site_pages. */
  statusByUrl: Map<string, number>;
  /** Prior OPEN findings for the site (caller loads with state ["open"]). */
  priorFindings: PageFindingRecord[];
  /** Prior site pages for the site. */
  priorPages: SitePageRecord[];
  /** Epoch ms stamped on this run's records (caller passes Date.now()). */
  now: number;
  /**
   * (#1167) Checks whose published `pages[]` was truncated to a SAMPLE — key
   * `${ruleId}|${checkName}` → the set of normalized urls that ARE in the sample
   * (authoritative-present this run). Absence of a page from a truncated check is
   * NON-authoritative: a prior open finding on such a page must CARRY forward, not
   * resolve, even though the page was crawled (it appears in another rule's checks
   * or in pageStatuses). Without this, publish-time page sampling would silently
   * mark clipped-but-still-failing pages as fixed. Empty/undefined → no truncation
   * (the CLI local merge always passes nothing; only the cloud publish merge, which
   * sees the sampled payload, populates it).
   */
  sampledCheckPages?: Map<string, Set<string>>;
  /**
   * (#1185) Unsampled publish resolution signal, pre-indexed by the caller.
   * Overrides the {@link sampledCheckPages} carry guard with authoritative
   * per-check evidence: a prior finding on a crawled page whose check RAN this
   * run (key present) and whose page hash is absent from the check's failing
   * set is RESOLVED — even if the page was clipped from the published sample.
   * Undefined (old CLIs, local merge) → behavior is byte-identical to
   * pre-#1185.
   */
  resolution?: MergeResolutionInput;
}

/** Pre-indexed form of the publish `ResolutionSignal` (#1185). */
export interface MergeResolutionInput {
  /**
   * NORMALIZED URLs crawled this run per the unsampled signal. A superset of
   * the sampled-payload-derived `crawledUrls` — used ONLY for the resolve
   * decision, never for scoring denominators or site_pages (a clean page
   * clipped from every sample must stay in `carriedPageUrls` so its synthetic
   * pass keeps counting).
   */
  crawledUrls: Set<string>;
  /** `${ruleId}|${checkName}` → failing/warning page url-hash set (unsampled). */
  failingByCheck: Map<string, Set<string>>;
  /**
   * `${ruleId}|${checkName}` → hashes of crawled pages the check did NOT
   * evaluate (skipped, or the rule emitted nothing for them). Absence from
   * `failingByCheck` is not evidence of clean for these, so they never resolve.
   */
  notEvaluatedByCheck: Map<string, Set<string>>;
  /** Keys whose hash set is incomplete → absence is non-authoritative. */
  truncatedChecks: Set<string>;
}

const KEY_SEP = "|";

/**
 * Stable cross-crawl identity for a finding.
 * `URL + rule + check + locator`. The locator is the item id when present,
 * else "" (whole-check finding) — matching the page_findings PK.
 */
export function findingKey(
  normalizedUrl: string,
  ruleId: string,
  checkName: string,
  locator: string
): string {
  return [normalizedUrl, ruleId, checkName, locator].join(KEY_SEP);
}

/**
 * Change/resolution fingerprint over the mutable parts of a finding. Portable
 * (no node:crypto) so the CLI and the API Worker produce IDENTICAL values — see
 * `fingerprint.ts` + the cross-impl parity test.
 */
export const fingerprint = findingFingerprint;

/**
 * Flatten a page's CheckResults into per-finding rows. Only failing/warning
 * checks become persisted findings — `pass`/`info`/`skipped` checks are not
 * issues to carry (the union scorer re-derives pass denominators from the
 * active-page set, so we never need to persist passes).
 *
 * A check with `items[]` yields one finding per item (locator = item.id); a
 * check without items yields a single whole-check finding (locator = "").
 *
 * Each item finding's payload carries `i` = the item's index within the check's
 * `items[]` — its EMISSION order. The page_findings PK is keyed by `locator`
 * (item id), not order, and the complete-store reconstruct reads rows back in
 * `locator` sort order (unstable vs emission for unpadded numeric ids, e.g.
 * "parse-10" < "parse-2"), so `i` is what lets `reconstructRuleChecks` restore
 * the original item order. Intrinsic to the item's position, so it's stable
 * across finalize retries and chunk boundaries.
 */
export function flattenChecks(
  normalizedUrl: string,
  ruleId: string,
  checks: CheckResult[]
): FlatFinding[] {
  const out: FlatFinding[] = [];
  for (const check of checks) {
    if (check.status !== "fail" && check.status !== "warn") continue;
    const value = check.value != null ? String(check.value) : null;
    const expected = check.expected != null ? String(check.expected) : null;
    const items = check.items ?? [];
    if (items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        out.push({
          normalizedUrl,
          ruleId,
          checkName: check.name,
          locator: item.id,
          status: check.status,
          message: check.message,
          value,
          expected,
          payload: JSON.stringify({
            items: [item],
            details: check.details,
            pages: check.pages,
            i,
          }),
        });
      }
    } else {
      out.push({
        normalizedUrl,
        ruleId,
        checkName: check.name,
        locator: "",
        status: check.status,
        message: check.message,
        value,
        expected,
        payload: check.details || check.pages
          ? JSON.stringify({ details: check.details, pages: check.pages })
          : null,
      });
    }
  }
  return out;
}

/**
 * Merge this run's fresh findings against the prior site state (pure).
 *
 * - fresh: for crawled URLs, upsert this run's findings (provenance=fresh);
 *   prior open findings on a crawled URL that are absent now → resolved.
 * - carried: stored open findings on an un-crawled, still-active page →
 *   carried forward unchanged (provenance=carried), no TTL.
 * - stale: a previously-active page that returned 404/410 this run → page
 *   removed, its findings staled. (Pages merely scoped-out — not popped this
 *   run — are NOT removed; they carry.)
 */
export function computeMerge(input: ComputeMergeInput): MergedState {
  const {
    siteKey,
    crawlId,
    crawledUrls,
    freshFindings,
    removedUrls,
    severityByRule,
    statusByUrl,
    priorFindings,
    priorPages,
    now,
    sampledCheckPages,
    resolution,
  } = input;

  // Index prior findings by full key for O(1) lookup.
  const priorByKey = new Map<string, PageFindingRecord>();
  for (const p of priorFindings) {
    priorByKey.set(
      findingKey(p.normalizedUrl, p.ruleId, p.checkName, p.locator),
      p
    );
  }

  // Index fresh findings by key (latest wins on dup keys within a run).
  const freshByKey = new Map<string, FlatFinding>();
  for (const f of freshFindings) {
    freshByKey.set(
      findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator),
      f
    );
  }

  const persisted: PageFindingRecord[] = [];
  const activeFindings: MergedFinding[] = [];
  const handledKeys = new Set<string>();

  // 1) FRESH — upsert findings for crawled URLs.
  for (const [key, f] of freshByKey) {
    const prior = priorByKey.get(key);
    const fp = fingerprint(f.status, f.message, f.value, f.expected);
    const severity = severityByRule.get(f.ruleId) ?? "warning";
    const record: PageFindingRecord = {
      siteKey,
      normalizedUrl: f.normalizedUrl,
      ruleId: f.ruleId,
      checkName: f.checkName,
      locator: f.locator,
      status: f.status,
      severity,
      message: f.message,
      value: f.value,
      expected: f.expected,
      payload: f.payload,
      fingerprint: fp,
      firstSeenAt: prior?.firstSeenAt ?? now,
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
      provenance: "fresh",
      state: "open",
    };
    persisted.push(record);
    activeFindings.push(toMerged(record));
    handledKeys.add(key);
  }

  // 2) Prior OPEN findings (we only loaded "open"): resolve, stale, or carry.
  for (const prior of priorFindings) {
    const key = findingKey(
      prior.normalizedUrl,
      prior.ruleId,
      prior.checkName,
      prior.locator
    );
    if (handledKeys.has(key)) continue; // superseded by a fresh finding

    const wasCrawled = crawledUrls.has(prior.normalizedUrl);
    const wasRemoved = removedUrls.has(prior.normalizedUrl);
    // (#1185) Crawled per the unsampled signal ONLY — the page produced no
    // checks in the sampled payload (clean everywhere, or clipped from every
    // sample) so it's absent from the payload-derived `crawledUrls`.
    const signalCrawled =
      !wasCrawled && (resolution?.crawledUrls.has(prior.normalizedUrl) ?? false);

    if (wasRemoved) {
      // Page gone — stale this finding. NOTE: site_pages state + the bulk
      // finding-stale UPDATE are written transactionally by `markPageRemoved`
      // (the orchestrator); we only record the staled row here so the
      // returned union correctly EXCLUDES it from scoring/report this run.
      persisted.push({
        ...prior,
        state: "stale",
        lastSeenCrawlId: crawlId,
        lastSeenAt: now,
      });
      handledKeys.add(key);
      continue;
    }

    if (wasCrawled || signalCrawled) {
      // (#1185) Resolution-signal override: a key present in `failingByCheck`
      // means the check RAN this run with page-attributable results, so its
      // UNSAMPLED failing set is authoritative — hash present → still failing
      // (clipped from the sample, carry); hash absent → crawled clean this run
      // → resolve, regardless of the #1167 sample guard below. A key marked
      // truncated (or absent — rule disabled, unknown shape, old CLI) gives no
      // authority and falls through to the pre-#1185 behavior.
      const checkKey = `${prior.ruleId}${KEY_SEP}${prior.checkName}`;
      const priorHash = resolution ? resolutionUrlHash(prior.normalizedUrl) : "";
      // The check produced NO evaluated result for this page this run (the rule
      // `skipped` it — perf/ttfb without timing data — or emitted nothing for
      // it). Its absence from the fresh findings is not evidence the finding is
      // gone, so it can never resolve: carry regardless of what the sampled
      // payload suggests.
      if (resolution?.notEvaluatedByCheck.get(checkKey)?.has(priorHash)) {
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        persisted.push(carried);
        activeFindings.push(toMerged(carried));
        handledKeys.add(key);
        continue;
      }
      const failingSet = resolution?.failingByCheck.get(checkKey);
      if (failingSet) {
        if (failingSet.has(priorHash)) {
          // Unlike the sample-guard carry below, this page WAS observed failing
          // this run — the signal is unsampled, so its presence is positive
          // evidence, not an absence we couldn't rule out. Refresh the
          // last-seen stamps so the dashboard's "carried forward" badge doesn't
          // read as stale on exactly the >100-page sites this fixes. Provenance
          // stays "carried": presence was reconfirmed, but the check payload
          // (message/details/severity) wasn't re-derived.
          const carried: PageFindingRecord = {
            ...prior,
            provenance: "carried",
            lastSeenCrawlId: crawlId,
            lastSeenAt: now,
          };
          persisted.push(carried);
          activeFindings.push(toMerged(carried));
          handledKeys.add(key);
          continue;
        }
        if (!resolution!.truncatedChecks.has(checkKey)) {
          persisted.push({
            ...prior,
            state: "resolved",
            lastSeenCrawlId: crawlId,
            lastSeenAt: now,
          });
          handledKeys.add(key);
          continue;
        }
      }

      if (signalCrawled) {
        // No authoritative signal for this check and the page is absent from
        // the sampled payload — exactly today's un-crawled behavior: carry.
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        persisted.push(carried);
        activeFindings.push(toMerged(carried));
        handledKeys.add(key);
        continue;
      }

      // (#1167) Truncated-sample guard: if this rule+check shipped a SAMPLE of its
      // affected pages and THIS page was clipped out of it, its absence from the
      // fresh findings is NOT evidence the finding is gone — carry it forward.
      // Only a page that WAS in the sample (or a non-truncated check) gives an
      // authoritative "re-crawled, no longer present → resolved".
      const sample = sampledCheckPages?.get(checkKey);
      if (sample && !sample.has(prior.normalizedUrl)) {
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        persisted.push(carried);
        activeFindings.push(toMerged(carried));
        handledKeys.add(key);
        continue;
      }

      // Re-crawled and the finding is no longer present → resolved (evidence).
      persisted.push({
        ...prior,
        state: "resolved",
        lastSeenCrawlId: crawlId,
        lastSeenAt: now,
      });
      handledKeys.add(key);
      continue;
    }

    // Un-crawled, still-active page: carry forward unchanged (no TTL).
    const carried: PageFindingRecord = { ...prior, provenance: "carried" };
    persisted.push(carried);
    activeFindings.push(toMerged(carried));
    handledKeys.add(key);
  }

  // 3) Site pages — active set (crawled non-removed) ∪ prior actives minus removed.
  const sitePageMap = new Map<string, SitePageRecord>();
  for (const p of priorPages) {
    sitePageMap.set(p.normalizedUrl, p);
  }
  // Crawled this run (excluding removed) → active with the real HTTP status.
  for (const url of crawledUrls) {
    if (removedUrls.has(url)) continue;
    sitePageMap.set(url, {
      siteKey,
      normalizedUrl: url,
      lastStatus: statusByUrl.get(url) ?? 200,
      state: "active",
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
    });
  }
  // Removed this run → removed, recording the real 404/410 status.
  for (const url of removedUrls) {
    const prior = sitePageMap.get(url);
    sitePageMap.set(url, {
      siteKey,
      normalizedUrl: url,
      lastStatus: statusByUrl.get(url) ?? prior?.lastStatus ?? 404,
      state: "removed",
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
    });
  }

  const sitePages = Array.from(sitePageMap.values());
  const activePageUrls = new Set<string>(
    sitePages.filter((p) => p.state === "active").map((p) => p.normalizedUrl)
  );

  return { findings: activeFindings, persisted, sitePages, activePageUrls };
}

function toMerged(r: PageFindingRecord): MergedFinding {
  return {
    siteKey: r.siteKey,
    normalizedUrl: r.normalizedUrl,
    ruleId: r.ruleId,
    checkName: r.checkName,
    locator: r.locator,
    status: r.status,
    severity: r.severity,
    message: r.message,
    value: r.value,
    expected: r.expected,
    payload: r.payload,
    fingerprint: r.fingerprint,
    firstSeenAt: r.firstSeenAt,
    lastSeenCrawlId: r.lastSeenCrawlId,
    lastSeenAt: r.lastSeenAt,
    provenance: r.provenance,
    state: r.state,
  };
}
