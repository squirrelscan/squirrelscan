// Smart audits — pure merge core (#110/#195).
//
// Storage-agnostic, dependency-free heart of the finding merge. NO node
// builtins, NO Effect, NO store I/O — just the in-memory state machine over
// already-loaded prior state. Both the CLI's Effect wrapper (`merge.ts`, over
// `CrawlStorage`) and the API's Promise wrapper (`merge-promise.ts`, over
// `SmartAuditStore`) load prior findings/pages their own way, then call
// `computeMerge`, so the algorithm lives in EXACTLY one place (no drift).

import type {
  CheckItem,
  CheckResult,
  FindingProvenance,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
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
  /**
   * (#1652) True when this finding is carried but its page has NEVER been
   * rendered by any audit of the site — not by an earlier run (it is absent from
   * `priorPages`) and not by this one (absent from `crawledUrls`). Such findings
   * are seeded from pages the crawl only KNOWS about (sitemap entries, the page
   * lists on folded aggregates) and were never inherited from a prior audit, so
   * surfaces must label them "unrendered", not "carried" — on a first run there
   * is no previous audit for "carried" to refer to.
   *
   * DERIVED ONLY: never persisted (the store's `provenance` column is
   * constrained to fresh|carried), always false for a fresh finding.
   */
  neverRendered: boolean;
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
 * Max chars of the page-invariant check text kept in front of the item id, so a
 * pathologically long rule message cannot crowd the id out of the store's
 * `maxMediumString` clamp on the `message` column. Real rule messages are well
 * under this (the longest on a 401-page production audit is ~110 chars).
 */
const ITEM_MESSAGE_PREFIX_MAX = 240;

/**
 * Reduce a page-scope check's message to the part that does NOT depend on the
 * page: drop a leading count, then neutralise any digit run left behind.
 *
 * A page-scope check's message COUNTS that page's items ("26 cross-origin
 * resources without Subresource Integrity"), which is why it cannot ride on an
 * item row verbatim. `N` as the placeholder is not invented here — the report's
 * own grouping already shows exactly that for a merged group whose members'
 * messages differ only in digits (`packages/report/src/grouping.ts`), so the two
 * surfaces read alike.
 *
 * Anchored and non-overlapping: the leading `\s*` and the trailing `\s+` are
 * separated by a mandatory digit and the class between them excludes whitespace,
 * so there is no ambiguity for a backtracker to explore (#150/#175/#177).
 *
 * KNOWN LIMIT: a leading number that is WORDING rather than a count is eaten the
 * same way ("404 Not Found" → "Not Found"). No rule in the catalog opens an
 * item-bearing check's message that way today, and the alternative — keeping the
 * number and writing "N cross-origin resources …" on every item row — is worse
 * copy for the shapes that actually occur. Public #229 is the gate that would
 * catch a future rule reintroducing it.
 */
function pageInvariantCheckText(message: string, max: number): string {
  const stripped = message.replace(/^\s*\d[\d,._]*\s+/, "").trim();
  // Nothing but a number ("26", "2.5") — there is no wording to keep, and the
  // caller falls back to the check name. Tested BEFORE the substitution, because
  // afterwards the placeholder `N` is itself a letter.
  if (!/\p{L}/u.test(stripped)) return "";
  return sliceWholeChars(stripped.replace(/\d+/g, "N").trim(), max);
}

/** `slice` on a UTF-16 code-unit boundary can cut a surrogate PAIR in half and
 * leave a lone surrogate, which is not valid text to hand a database or a JSON
 * encoder. Drop the orphan. */
function sliceWholeChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Page-invariant, ITEM-scoped message for an item finding (#1881).
 *
 * WHY: `findingFingerprint` hashes [status, message, value, expected] and is
 * nominally URL-free, so `finding_defs` (keyed by site + fingerprint) is meant to
 * hold ONE row per distinct defect. Copying the parent check's message onto every
 * item row defeats that, because a page-scope check's message is a COUNT of that
 * page's items: one Shopify CDN script missing SRI on 401 pages stored 25 distinct
 * messages ("26 cross-origin resources without Subresource Integrity" on one page,
 * "24 ..." on another) and therefore 25 fingerprints for one defect. On a real
 * 401-page audit that inflated distinct (rule, check, locator, status, message,
 * value, expected) from 2,606 to 4,201.
 *
 * Reads as `<page-invariant check text>: <item id>`, e.g.
 * `cross-origin resources without Subresource Integrity: https://cdn.shopify.com/…/globo.js`.
 * The id alone would also be page-invariant and is what the fingerprint really
 * needs, but this column is a display string wherever a reader does not rebuild a
 * CheckResult first, and a bare URL is not a finding description.
 *
 * `item.label` deliberately does NOT feed this. It is free-form per-check text
 * and several rules stamp per-PAGE numbers into it (content/keyword-stuffing
 * emits `"everyday" (2.3%)`, a density that moves page to page), which would
 * re-create the very split this fixes. The label is not lost: it rides in the
 * payload's `items[0]`, which every reader that rebuilds a CheckResult replays.
 *
 * Derived generically here rather than edited into ~280 rules. Measured on a real
 * 45,663-row site: distinct (rule, check, locator, status) is 4,068 and adding
 * this message takes it to 4,069, so the text contributes one tuple in 45k rows.
 * That is empirical, not a proof — a rule that put some OTHER page-varying token
 * in its message (a URL, a page title) would still split, which is a rule bug and
 * is what public #229 exists to catch.
 */
export function itemFindingMessage(check: CheckResult, item: CheckItem): string {
  const id = item.id.trim();
  // The ID is the discriminator, so it gets first claim on the store's
  // `maxMediumString` clamp: budget the prefix against what the id leaves behind,
  // or a long URL would be truncated away and two distinct items would display
  // identically. Still a pure function of (check message, item id), so this does
  // not weaken page-invariance.
  const budget = Math.min(
    ITEM_MESSAGE_PREFIX_MAX,
    Math.max(0, REPORT_LIMITS.maxMediumString - id.length - 2)
  );
  // A message with no wording in it ("26") yields "" — fall back to the check
  // name, which is page-invariant too.
  const text = pageInvariantCheckText(check.message, budget) || sliceWholeChars(check.name, budget);
  // An empty id makes the locator "" (colliding with a whole-check row) — a
  // degenerate case, but still never the parent's page-level message.
  if (id === "") return text;
  return text === "" ? id : `${text}: ${id}`;
}

/**
 * Serialize one item finding's payload, adding the aggregate stash only when the
 * result still fits `maxFindingPayload`.
 *
 * WHY A BUDGET: the chunk ingest DROPS a payload over that cap whole, and
 * `details` is load-bearing for scoring (`details.additional` feeds the density
 * penalty), so letting the stash tip a near-cap payload over the line would
 * inflate the health score — the #1179 class. The stash is display detail, so it
 * is the part that yields, and a row that loses it reads its own message exactly
 * like a pre-#1881 row.
 *
 * The budget only ever REMOVES the stash. It never trims `items`/`details`/`pages`
 * to make room, because this function also feeds the CLI's local SQLite store,
 * which persists the payload with no cap at all — dropping detail here to work
 * around a transport limit would destroy data that the local path would have
 * kept. Shrinking an already-over-cap payload for transport belongs at the
 * transport boundary (`clampFindingPayload` in the API's chunk ingest), not here.
 */
function itemFindingPayload(
  check: CheckResult,
  item: CheckItem,
  i: number,
  value: string | null,
  expected: string | null
): string {
  const base = { items: [item], details: check.details, pages: check.pages, i };
  const withAggregate = JSON.stringify({
    ...base,
    // Short keys: this rides on EVERY item row. `v`/`e` are omitted when the
    // check carried none, and `m` is the marker a reader keys the whole restore
    // on — a pre-#1881 row has no `m`, and a whole-check row never writes one.
    m: check.message,
    ...(value !== null ? { v: value } : {}),
    ...(expected !== null ? { e: expected } : {}),
  });
  if (withAggregate.length <= REPORT_LIMITS.maxFindingPayload) return withAggregate;
  // Byte-identical to the pre-#1881 payload, so an over-cap finding is no worse
  // off than it was — the ingest drops it exactly as before, and the local store
  // keeps every field exactly as before.
  return JSON.stringify(base);
}

/**
 * Flatten a page's CheckResults into per-finding rows. Only failing/warning
 * checks become persisted findings — `pass`/`info`/`skipped` checks are not
 * issues to carry (the union scorer re-derives pass denominators from the
 * active-page set, so we never need to persist passes).
 *
 * A check with `items[]` yields one finding per item (locator = item.id); a
 * check without items yields a single whole-check finding (locator = "") and
 * keeps the check's page-level message/value/expected verbatim.
 *
 * (#1881) An ITEM finding's message/value/expected describe the ITEM, not the
 * page — see {@link itemFindingMessage}. The check's page-level trio is stashed
 * in the payload as `m`/`v`/`e` so a reader rebuilding a CheckResult
 * (`carriedFindingToCheck`, `reconstructRuleChecks`) restores it unchanged.
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
          // (#1881) ITEM-scoped, so the fingerprint follows the defect rather
          // than the page's item count. `value`/`expected` are the same
          // page-level aggregate the message was, so they are dropped from the
          // row for the same reason; all three are stashed in the payload below
          // and restored by every reader that rebuilds a CheckResult.
          message: itemFindingMessage(check, item),
          value: null,
          expected: null,
          payload: itemFindingPayload(check, item, i, value, expected),
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

  // (#1652) The site's render history: `site_pages` rows are written only for
  // pages a run actually crawled (step 3 below), in any lifecycle state — a
  // "removed" page was still rendered once. A carried finding whose page is in
  // neither this set nor rendered this run was never observed by a previous
  // audit: it is "unrendered", not carry-over. Empty on a first run, which is
  // exactly why a first run must report zero carried findings.
  //
  // `renderedThisRun` is passed in rather than re-derived from `crawledUrls`:
  // the #1185 signal can mark a page crawled this run that never reached the
  // payload-derived crawled set, and such a page WAS rendered.
  //
  // KNOWN BOUNDS — both err toward "unrendered", never toward inventing a prior
  // audit, so the worst case is a missing "last seen" date rather than a false
  // claim about an audit that did not happen:
  //  - a page rendered ONLY per the #1185 signal gets no `site_pages` row (that
  //    is deliberate — adding one would grow `carriedPageUrls` and with it the
  //    synthetic-pass denominator, moving scores), so a later run that skips it
  //    reads it as unrendered;
  //  - a removed page whose `site_pages` row was pruned by retention and that is
  //    later rediscovered loses its history the same way.
  const everRenderedUrls = new Set<string>();
  for (const p of priorPages) everRenderedUrls.add(p.normalizedUrl);
  const neverRendered = (normalizedUrl: string, renderedThisRun: boolean): boolean =>
    !renderedThisRun && !everRenderedUrls.has(normalizedUrl);

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
    // A fresh finding was evaluated on a page rendered this run, by definition.
    activeFindings.push(toMerged(record, false));
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
    // (#1652) Same value for every carry branch below — computed once here so a
    // new branch can't silently forget it and default a never-rendered page back
    // to "carried".
    const unrendered = neverRendered(
      prior.normalizedUrl,
      wasCrawled || signalCrawled
    );

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
        activeFindings.push(toMerged(carried, unrendered));
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
          activeFindings.push(toMerged(carried, unrendered));
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
        activeFindings.push(toMerged(carried, unrendered));
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
        activeFindings.push(toMerged(carried, unrendered));
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
    activeFindings.push(toMerged(carried, unrendered));
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

function toMerged(
  r: PageFindingRecord,
  neverRendered: boolean
): MergedFinding {
  return {
    neverRendered,
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
