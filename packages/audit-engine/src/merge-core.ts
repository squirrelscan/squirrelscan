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
import type { PageUrlSet } from "./scoring";

const EMPTY_HASHES: readonly string[] = [];

/**
 * Every resolution-signal hash a page could have been published under (#2063).
 *
 * The signal's URL hashes are computed by the PRODUCER, so which normalizer it
 * used is decided by whichever release the user is running — and #2063 changed
 * that normalizer from a query-blind one to the query-preserving page identity
 * the store is keyed by. A publisher on an older release therefore hashes
 * `/p?id=1` as `/p`, and matching only the new spelling would read its signal as
 * "this page is not in the failing set" — i.e. resolve a finding that is still
 * there.
 *
 * So accept EITHER spelling. Every consequence of the extra hash is a carry: a
 * hit in `notEvaluated` carries, a hit in `failing` carries, and a miss in
 * `failing` is the only branch that resolves. The worst case is that two query
 * URLs sharing a path both carry when only one still fails — over-carry, which a
 * later run with matching versions resolves. Under-carry is the outcome that
 * silently deletes a real finding, and this shape cannot produce it.
 */
function resolutionHashes(normalizedUrl: string): readonly string[] {
  const q = normalizedUrl.indexOf("?");
  if (q === -1) return [resolutionUrlHash(normalizedUrl)];
  return [resolutionUrlHash(normalizedUrl), resolutionUrlHash(normalizedUrl.slice(0, q))];
}

/** True when `set` holds any of `hashes` (see {@link resolutionHashes}). */
function hasAnyHash(set: Set<string> | undefined, hashes: readonly string[]): boolean {
  if (!set) return false;
  for (const h of hashes) {
    if (set.has(h)) return true;
  }
  return false;
}

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
  /**
   * (pub#474) Page checks whose fresh `items` this run are the page's COMPLETE
   * item list, keyed by {@link pageCheckKey}. Consulted only where the
   * {@link resolution} signal says the page still fails the check: a prior item
   * finding there whose locator is not in this run's list is resolved instead of
   * carried, because a complete list leaving it out is proof it is gone (fixed,
   * or renamed by a rule change).
   *
   * Without it the signal branch carries every unmatched item on a still-failing
   * page, since the signal is page-level. That carry is right when the list is a
   * sample (a rule cap, a publish clip, an unfolded aggregate), which is why the
   * caller lists only keys {@link itemListComplete} vouches for. Undefined →
   * today's carry.
   */
  completeItemChecks?: Set<string>;
  /**
   * (#2658) The other half of {@link completeItemChecks}: page checks that still
   * fail or warn this run with an item list that is a SAMPLE. Consulted where no
   * signal speaks for the check (none sent, or the check is not in it): a prior
   * finding there that this run's list does not match may sit past the clip, so
   * it carries rather than resolving. Undefined → the pre-#2658 resolve.
   */
  incompleteItemChecks?: Set<string>;
  /**
   * (#2658) Page checks the published payload shows PASSING this run, keyed by
   * {@link pageCheckKey}. Consulted only where a {@link resolution} signal was
   * sent but lost its say for the page and check (its key truncated, or the page
   * left off a clipped list): absence is then no evidence at all, so a prior
   * finding resolves only on this positive evidence (or a complete item list
   * that no longer holds it) and carries otherwise. Undefined → none.
   */
  passedCheckPages?: Set<string>;
}

/** Pre-indexed form of the publish `ResolutionSignal` (#1185). */
export interface MergeResolutionInput {
  /**
   * NORMALIZED URLs crawled this run per the unsampled signal. A superset of
   * the sampled-payload-derived `crawledUrls`, used for the resolve decision
   * and (#2067) for `site_pages`: every page here gets an active row, so it
   * counts as audited and is known to later runs. Never for this run's scoring
   * denominator: a clean page clipped from every sample stays in
   * `carriedPageUrls` exactly as before, so its synthetic pass keeps counting.
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
  /**
   * (#2658) False when the signal lists only part of the crawl (its byte budget
   * clipped `crawledUrls`). Its page sets are then exact for the listed pages
   * only, so a page outside `crawledUrls` gets no resolve authority from it and
   * takes the pre-#1185 path. Undefined → the whole crawl is listed.
   */
  crawledComplete?: boolean;
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

/** Key for one check on one page (a {@link findingKey} without the locator). */
export function pageCheckKey(normalizedUrl: string, ruleId: string, checkName: string): string {
  return [normalizedUrl, ruleId, checkName].join(KEY_SEP);
}

/**
 * (pub#474) Checks whose rule capped its items WITHOUT recording a remainder
 * until pub#474, keyed `${ruleId}|${checkName}` → the cap. A publisher on an
 * older release still sends those lists bare, so a list sitting exactly at the
 * cap may be cut off. Current rules record `details.additional`, so a current
 * list at the cap with no remainder carries once more than it needs to, which
 * is the safe direction.
 */
export const LEGACY_SILENT_ITEM_CAPS: ReadonlyMap<string, number> = new Map([
  ["a11y/identical-links-same-purpose|identical-links-same-purpose", 10],
  ["a11y/label-content-name-mismatch|label-content-name-mismatch", 10],
  ["a11y/link-in-text-block|link-in-text-block", 10],
  ["a11y/tabindex|tabindex-very-high", 10],
  ["a11y/tabindex|tabindex-positive", 10],
  ["perf/animated-content|animated-gifs", 10],
  ["perf/source-maps|source-maps-inline", 3],
  ["schema/rating-scope|rating-visible", 10],
  ["schema/rating-scope|rating-subject", 10],
]);

/**
 * (pub#474) Checks whose rule stops at a work budget (elements walked, CSS or
 * text read) and reports whether it did in `details.scanTruncated`. Only an
 * explicit `false` proves the whole page was looked at: an older publisher
 * sends neither value, and its list may stop short anywhere, not at a cap.
 */
export const SCAN_BUDGET_CHECKS: ReadonlySet<string> = new Set([
  "content/hidden-text|hidden-text",
  "content/dev-leakage|dev-leakage",
]);

/**
 * (pub#474) True when a fail/warn check's `items` are its COMPLETE list, so an
 * item missing from it is gone rather than cut off.
 *
 * Every cap that drops items records the remainder in `details.additional`: the
 * rules' own caps, `clampCheckItemsOverflow`, the fold's item merge and the
 * publish sampler. A rule that stops at a work budget before it has looked at
 * the whole page sets `details.scanTruncated`. So a list with items and neither
 * marker is complete, except a bare list at a cap an older release did not
 * record ({@link LEGACY_SILENT_ITEM_CAPS}), or a budgeted check that does not
 * say it finished ({@link SCAN_BUDGET_CHECKS}).
 *
 * The caller must also rule out what the check cannot show about itself: that
 * it was rebuilt by `unfoldAggregateCheck`, or that another aggregate of the
 * same rule and name holds more of this page's items (see `runCloudSmartAudits`).
 * A check with no items is never "complete": it has no list to compare against.
 */
export function itemListComplete(ruleId: string, check: CheckResult): boolean {
  const items = check.items;
  if (!items || items.length === 0) return false;
  const details = check.details;
  if (details?.aggregated === true || details?.scanTruncated === true) return false;
  // Any remainder that is not plainly zero counts, including a malformed one:
  // reading a sample as complete resolves real findings, the reverse only carries.
  const additional = details?.additional;
  if (additional !== undefined && additional !== null && additional !== 0) return false;
  const key = `${ruleId}${KEY_SEP}${check.name}`;
  if (SCAN_BUDGET_CHECKS.has(key) && details?.scanTruncated !== false) return false;
  const legacyCap = LEGACY_SILENT_ITEM_CAPS.get(key);
  return legacyCap === undefined || items.length < legacyCap;
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

/** Inputs to a {@link createMergeSession}: everything except the prior findings,
 *  which the session consumes incrementally. */
export type MergeSessionInput = Omit<ComputeMergeInput, "priorFindings">;

/**
 * Where a merge session sends the records it derives from PRIOR findings (#1876).
 *
 * Prior-derived output is pushed rather than returned so a caller can stream tens
 * of thousands of priors past the session without any of them, or of the records
 * they produce, being resident at once. {@link computeMerge}'s sink appends to
 * arrays, which is what keeps the array API byte-identical.
 */
export interface MergePriorSink {
  /** A row to upsert: a carried, resolved or staled prior. */
  persist(record: PageFindingRecord): void;
  /** A prior that is OPEN in the merged union (i.e. carried). Fresh actives are
   *  NOT sent here — they come back from {@link MergeSession.finish}. */
  active(finding: MergedFinding): void;
}

/** A merge in progress: prior findings stream in, fresh records come out at the end. */
export interface MergeSession {
  /**
   * Site pages after the merge, and the URLs active afterwards. Step 3 of the
   * merge reads only `priorPages` + this run's crawl, never a prior FINDING, so
   * both are known before the first prior arrives — which is what lets the caller
   * derive `carriedPageUrls` up front and fold carried findings as they stream.
   */
  readonly sitePages: SitePageRecord[];
  readonly activePageUrls: Set<string>;
  /**
   * (#497) What the streaming caller asks of the site's pages, answered without
   * copying them: `sitePages` and `activePageUrls` are built on first read, and
   * these are not. A site's pages are bounded by its history, not by the run.
   */
  readonly activePageCount: number;
  /**
   * The `sitePages` rows this run wrote: the pages it crawled or saw removed.
   * Every other row is a prior page passed through unchanged, so a store that
   * already holds `priorPages` reaches the same rows by upserting only these.
   */
  readonly changedSitePages: SitePageRecord[];
  isActivePage(normalizedUrl: string): boolean;
  /** A page some audit rendered: it has a prior `site_pages` row (#1652). */
  everRendered(normalizedUrl: string): boolean;
  /**
   * Prior pages whose row is active and that this run neither crawled nor saw
   * removed, in the prior pages' order (the last row winning for a url listed
   * twice). The union scorer's carried pages; a view, not a copy.
   */
  readonly carriedPageUrls: PageUrlSet;
  /**
   * Decide one batch of prior OPEN findings, pushing the results to the sink.
   * The decision is per row and never depends on how the priors are batched, so
   * any batching (one array, one page, one row) yields the same records in the
   * same order.
   */
  addPriorFindings(priors: readonly PageFindingRecord[]): void;
  /**
   * Emit this run's FRESH records. Call once, AFTER every prior has been added:
   * a fresh finding inherits `firstSeenAt` from the prior it supersedes, and
   * those stamps are harvested as the priors go past.
   */
  finish(): { persisted: PageFindingRecord[]; active: MergedFinding[] };
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
 *
 * (#1876) The whole-array form: it drives a {@link createMergeSession} with a
 * sink that collects, so there is exactly ONE decision implementation shared with
 * the API's streaming driver. Fresh records lead `persisted`/`findings` here
 * because that is the order the pre-#1876 two-pass loop produced and the report's
 * carried replays are built from it.
 */
export function computeMerge(input: ComputeMergeInput): MergedState {
  const priorPersisted: PageFindingRecord[] = [];
  const priorActive: MergedFinding[] = [];
  const session = createMergeSession(input, {
    persist: (record) => {
      priorPersisted.push(record);
    },
    active: (finding) => {
      priorActive.push(finding);
    },
  });
  // The array API takes an ARRAY, so nothing stops a caller passing the same
  // finding key twice, and the pre-#1876 loop handled a repeat by ignoring it
  // (one `handledKeys` set answered both "superseded by a fresh finding" and
  // "already decided"). The session does not carry that set — it is the one
  // structure whose size is the prior count, and a store read cannot produce a
  // repeat because the key IS the primary key — so the dedupe lives here, where
  // the whole array is resident anyway.
  session.addPriorFindings(dedupeByKey(input.priorFindings, freshKeysOf(input.freshFindings)));
  const fresh = session.finish();
  return {
    findings: [...fresh.active, ...priorActive],
    persisted: [...fresh.persisted, ...priorPersisted],
    sitePages: session.sitePages,
    activePageUrls: session.activePageUrls,
  };
}

function freshKeysOf(fresh: readonly FlatFinding[]): Set<string> {
  const keys = new Set<string>();
  for (const f of fresh) keys.add(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator));
  return keys;
}

/**
 * Repeated prior keys, resolved the way the pre-#1876 loop resolved them — which
 * is NOT one rule (see {@link computeMerge}).
 *
 * A prior the merge decides on: FIRST wins. `handledKeys` was set by the decision,
 * so every later repeat hit the `continue` at the top of the loop.
 *
 * A prior a FRESH finding supersedes: LAST wins. Those never reached the loop's
 * decision at all — they were read out of `priorByKey`, an index built by
 * assigning each prior in turn, so the last assignment is the one the fresh
 * record inherited its `firstSeenAt` from. They are passed through here for the
 * same reason: the session returns early on them, keeping only the stamp, and the
 * last one to go past sets it.
 */
function dedupeByKey(
  priors: readonly PageFindingRecord[],
  freshKeys: Set<string>
): readonly PageFindingRecord[] {
  const seen = new Set<string>();
  const out: PageFindingRecord[] = [];
  for (const p of priors) {
    const key = findingKey(p.normalizedUrl, p.ruleId, p.checkName, p.locator);
    if (!freshKeys.has(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(p);
  }
  return out.length === priors.length ? priors : out;
}

/**
 * The merge as a resumable state machine (#1876), so prior findings can arrive
 * from a cursor in bounded batches instead of as one materialized array.
 *
 * PRECONDITION: prior findings are unique by {@link findingKey}. That is the
 * page_findings primary key, so every store read satisfies it; the array-shaped
 * {@link computeMerge} enforces it for callers that build the list by hand.
 *
 * WHAT CHANGED vs the pre-#1876 two-pass loop, and why it is equivalent: that
 * version indexed EVERY prior into `priorByKey` so the fresh pass could ask "did a
 * previous audit see this one" (for `firstSeenAt`), then walked the priors again.
 * The index is the unbounded part, and it only ever answered questions about keys
 * in the FRESH set — which is bounded by the run. So the lookup is flipped: the
 * fresh set is indexed, priors stream past it, and a prior that matches one leaves
 * its `firstSeenAt` behind on the way through. The fresh records are then emitted
 * by {@link MergeSession.finish}, which is why it must be called last.
 */
export function createMergeSession(
  input: MergeSessionInput,
  sink: MergePriorSink
): MergeSession {
  const {
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
    completeItemChecks,
    incompleteItemChecks,
    passedCheckPages,
  } = input;

  // Index fresh findings by key (latest wins on dup keys within a run).
  const freshByKey = new Map<string, FlatFinding>();
  for (const f of freshFindings) {
    freshByKey.set(
      findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator),
      f
    );
  }

  // (#1876) First-seen stamps harvested from the priors this run's fresh findings
  // SUPERSEDE — the one thing the fresh pass needed the prior index for. Bounded
  // by the fresh set, so it is the half of the old index that can stay resident.
  const firstSeenByFreshKey = new Map<string, number>();

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
  // KNOWN BOUND — errs toward "unrendered", never toward inventing a prior
  // audit, so the worst case is a missing "last seen" date rather than a false
  // claim about an audit that did not happen: a removed page whose `site_pages`
  // row was pruned by retention and that is later rediscovered loses its
  // history. (A page rendered ONLY per the #1185 signal used to lose it the same
  // way; it gets a row since #2067, see step 3.)
  //
  // (#497) Read off the prior pages' index below rather than a set of its own:
  // its keys are exactly the prior pages.
  const neverRendered = (normalizedUrl: string, renderedThisRun: boolean): boolean =>
    !renderedThisRun && !known.index.has(normalizedUrl);

  // 3) Site pages — active set (crawled non-removed) ∪ prior actives minus removed.
  //
  // (#1876) Hoisted ahead of the finding passes: it reads `priorPages`, not prior
  // FINDINGS, so it can be settled before a single prior streams in. The caller
  // needs `activePageUrls` to derive `carriedPageUrls`, and the carried scoring
  // fold needs THAT before it can fold the first carried page.
  //
  // (#2067) "Crawled" here includes the pages only the #1185 signal saw. A page
  // crawled clean whose every check was clipped from the publish sample (or that
  // produced no page check at all) is in no check's `pageUrl`, so it is missing
  // from the payload-derived `crawledUrls`; without its own row it was neither
  // counted as audited nor known to a later run. The row does NOT make it crawled
  // for the finding decisions below — those keep reading `crawledUrls` and the
  // signal separately — and it does not move this run's score: `runCloudSmartAudits`
  // derives `carriedPageUrls` from `priorPages`, not from `activePageUrls`.
  //
  // (#497) Kept as the prior pages (the last row winning for a url listed twice)
  // plus this run's changes, never as one merged copy: a site's pages outnumber a
  // run's by orders of magnitude, so the counts the callers need are derived from
  // the run's pages, and the merged list is built only when it is read.
  const known = indexPriorPages(priorPages);
  const priorOf = (url: string): SitePageRecord | undefined => {
    const i = known.index.get(url);
    return i === undefined ? undefined : known.pages[i];
  };
  const priorActive = (url: string): boolean => priorOf(url)?.state === "active";
  /** Pages this run crawled or saw removed. Bounded by the run. */
  const thisRun = new Map<string, SitePageRecord>();
  const pageOf = (url: string): SitePageRecord | undefined => thisRun.get(url) ?? priorOf(url);
  // Crawled this run (excluding removed) → active with the real HTTP status.
  const markCrawled = (url: string): void => {
    if (removedUrls.has(url)) return;
    thisRun.set(url, {
      siteKey,
      normalizedUrl: url,
      lastStatus: statusByUrl.get(url) ?? 200,
      state: "active",
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
    });
  };
  for (const url of crawledUrls) markCrawled(url);
  if (resolution) for (const url of resolution.crawledUrls) markCrawled(url);
  // Removed this run → removed, recording the real 404/410 status.
  for (const url of removedUrls) {
    const prior = pageOf(url);
    thisRun.set(url, {
      siteKey,
      normalizedUrl: url,
      lastStatus: statusByUrl.get(url) ?? prior?.lastStatus ?? 404,
      state: "removed",
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
    });
  }

  // Active afterwards: the prior actives, corrected page by page for the run's own.
  let activePageCount = known.active;
  for (const [url, p] of thisRun) {
    if (priorActive(url)) activePageCount -= 1;
    if (p.state === "active") activePageCount += 1;
  }
  // Carried: the prior actives this run neither crawled nor saw removed.
  let carriedPageCount = known.active;
  for (const url of crawledUrls) if (priorActive(url)) carriedPageCount -= 1;
  for (const url of removedUrls) {
    if (!crawledUrls.has(url) && priorActive(url)) carriedPageCount -= 1;
  }
  const carriesPage = (url: string, p: SitePageRecord): boolean =>
    p.state === "active" && !crawledUrls.has(url) && !removedUrls.has(url);
  const carriedPageUrls: PageUrlSet = {
    size: carriedPageCount,
    has: (url) => {
      const p = priorOf(url);
      return p !== undefined && carriesPage(url, p);
    },
    *[Symbol.iterator]() {
      for (const p of known.pages) if (carriesPage(p.normalizedUrl, p)) yield p.normalizedUrl;
    },
  };

  /** The merged pages, in the order one map written prior-first would hold them. */
  const buildSitePages = (): SitePageRecord[] => {
    const pages = known.pages.slice();
    for (const [url, p] of thisRun) {
      const i = known.index.get(url);
      if (i === undefined) pages.push(p);
      else pages[i] = p;
    }
    return pages;
  };
  let sitePages: SitePageRecord[] | undefined;
  let activePageUrls: Set<string> | undefined;

  /** This run's FRESH records — emitted by `finish()`, once every prior has had
   *  its chance to leave a `firstSeenAt` behind. */
  const emitFresh = (): { persisted: PageFindingRecord[]; active: MergedFinding[] } => {
    const persisted: PageFindingRecord[] = [];
    const active: MergedFinding[] = [];
    for (const [key, f] of freshByKey) {
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
        firstSeenAt: firstSeenByFreshKey.get(key) ?? now,
        lastSeenCrawlId: crawlId,
        lastSeenAt: now,
        provenance: "fresh",
        state: "open",
      };
      persisted.push(record);
      // A fresh finding was evaluated on a page rendered this run, by definition.
      active.push(toMerged(record, false));
    }
    return { persisted, active };
  };

  /** Prior OPEN findings (we only ever load "open"): resolve, stale, or carry. */
  const addPrior = (prior: PageFindingRecord): void => {
    const key = findingKey(
      prior.normalizedUrl,
      prior.ruleId,
      prior.checkName,
      prior.locator
    );
    // Superseded by a fresh finding this run. The fresh record inherits this
    // prior's first-seen (a finding that resolved and returned must not reset it),
    // which is the ONLY thing the pre-#1876 whole-prior index was for.
    if (freshByKey.has(key)) {
      firstSeenByFreshKey.set(key, prior.firstSeenAt);
      return;
    }

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
      sink.persist({
        ...prior,
        state: "stale",
        lastSeenCrawlId: crawlId,
        lastSeenAt: now,
      });
      return;
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
      // (#2658) A signal that lists only part of the crawl speaks for the listed
      // pages only: for any other page its sets are silent, not evidence of clean.
      const signal =
        resolution &&
        (resolution.crawledComplete !== false || resolution.crawledUrls.has(prior.normalizedUrl))
          ? resolution
          : undefined;
      const priorHashes = signal ? resolutionHashes(prior.normalizedUrl) : EMPTY_HASHES;
      // The check produced NO evaluated result for this page this run (the rule
      // `skipped` it — perf/ttfb without timing data — or emitted nothing for
      // it). Its absence from the fresh findings is not evidence the finding is
      // gone, so it can never resolve: carry regardless of what the sampled
      // payload suggests.
      if (hasAnyHash(signal?.notEvaluatedByCheck.get(checkKey), priorHashes)) {
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        sink.persist(carried);
        sink.active(toMerged(carried, unrendered));
        return;
      }
      const failingSet = signal?.failingByCheck.get(checkKey);
      if (failingSet) {
        if (hasAnyHash(failingSet, priorHashes)) {
          // (pub#474) The page still fails the check, but this run's item list
          // for it is complete and does not hold this locator (a fresh match
          // returned above), so this item is gone: fixed, or renamed by a rule
          // change. Carrying it would keep a ghost open for as long as the page
          // fails the check for any other item.
          if (
            completeItemChecks?.has(
              pageCheckKey(prior.normalizedUrl, prior.ruleId, prior.checkName)
            )
          ) {
            sink.persist({
              ...prior,
              state: "resolved",
              lastSeenCrawlId: crawlId,
              lastSeenAt: now,
            });
            return;
          }
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
          sink.persist(carried);
          sink.active(toMerged(carried, unrendered));
          return;
        }
        if (!signal!.truncatedChecks.has(checkKey)) {
          sink.persist({
            ...prior,
            state: "resolved",
            lastSeenCrawlId: crawlId,
            lastSeenAt: now,
          });
          return;
        }
      }

      if (signalCrawled) {
        // No authoritative signal for this check and the page is absent from
        // the sampled payload — exactly today's un-crawled behavior: carry.
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        sink.persist(carried);
        sink.active(toMerged(carried, unrendered));
        return;
      }

      // (#1167) Truncated-sample guard: if this rule+check shipped a SAMPLE of its
      // affected pages and THIS page was clipped out of it, its absence from the
      // fresh findings is NOT evidence the finding is gone — carry it forward.
      // Only a page that WAS in the sample (or a non-truncated check) gives an
      // authoritative "re-crawled, no longer present → resolved".
      const sample = sampledCheckPages?.get(checkKey);
      if (sample && !sample.has(prior.normalizedUrl)) {
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        sink.persist(carried);
        sink.active(toMerged(carried, unrendered));
        return;
      }

      const pageCheck = pageCheckKey(prior.normalizedUrl, prior.ruleId, prior.checkName);
      // (#2658) A signal was sent but lost its say here: a count cap or the byte
      // budget truncated the key, or the page is off a clipped list. What it
      // would have said (still failing, not evaluated) is gone with it, so the
      // finding's absence from the sampled payload proves nothing. Only positive
      // evidence resolves: the payload shows the check passing on this page, or
      // its complete item list no longer holds the finding (as the signal branch
      // above resolves it).
      if (resolution && (!signal || signal.truncatedChecks.has(checkKey))) {
        if (!passedCheckPages?.has(pageCheck) && !completeItemChecks?.has(pageCheck)) {
          const carried: PageFindingRecord = { ...prior, provenance: "carried" };
          sink.persist(carried);
          sink.active(toMerged(carried, unrendered));
          return;
        }
        sink.persist({
          ...prior,
          state: "resolved",
          lastSeenCrawlId: crawlId,
          lastSeenAt: now,
        });
        return;
      }

      // (#2658) No signal speaks for this check (none sent, or the check is not
      // in it). The page still fails the check, and this run's item list for it
      // is a sample (a rule cap, a publish clip): a finding it does not match may
      // sit past the clip.
      if (incompleteItemChecks?.has(pageCheck)) {
        const carried: PageFindingRecord = { ...prior, provenance: "carried" };
        sink.persist(carried);
        sink.active(toMerged(carried, unrendered));
        return;
      }

      // Re-crawled and the finding is no longer present → resolved (evidence).
      sink.persist({
        ...prior,
        state: "resolved",
        lastSeenCrawlId: crawlId,
        lastSeenAt: now,
      });
      return;
    }

    // Un-crawled, still-active page: carry forward unchanged (no TTL).
    const carried: PageFindingRecord = { ...prior, provenance: "carried" };
    sink.persist(carried);
    sink.active(toMerged(carried, unrendered));
  };

  return {
    get sitePages() {
      return (sitePages ??= buildSitePages());
    },
    get activePageUrls() {
      if (!activePageUrls) {
        activePageUrls = new Set<string>();
        for (const p of (sitePages ??= buildSitePages())) {
          if (p.state === "active") activePageUrls.add(p.normalizedUrl);
        }
      }
      return activePageUrls;
    },
    // Taken once: `thisRun` is complete by now and nothing writes it later.
    changedSitePages: Array.from(thisRun.values()),
    activePageCount,
    isActivePage: (url) => pageOf(url)?.state === "active",
    everRendered: (url) => known.index.has(url),
    carriedPageUrls,
    addPriorFindings: (priors) => {
      for (const prior of priors) addPrior(prior);
    },
    finish: emitFresh,
  };
}

/**
 * (#497) The prior pages, one per url: at its FIRST position, holding its LAST
 * row, which is what one `Map.set` per row keeps. `active` counts their active
 * rows. A store's rows are unique by url, so the slower pass for a repeat is
 * there for hand-built inputs only.
 */
function indexPriorPages(priorPages: readonly SitePageRecord[]): {
  index: Map<string, number>;
  pages: readonly SitePageRecord[];
  active: number;
} {
  const index = new Map<string, number>();
  for (let i = 0; i < priorPages.length; i++) index.set(priorPages[i]!.normalizedUrl, i);
  let pages = priorPages;
  if (index.size !== priorPages.length) {
    index.clear();
    const deduped: SitePageRecord[] = [];
    for (const p of priorPages) {
      const i = index.get(p.normalizedUrl);
      if (i === undefined) {
        index.set(p.normalizedUrl, deduped.length);
        deduped.push(p);
      } else {
        deduped[i] = p;
      }
    }
    pages = deduped;
  }
  let active = 0;
  for (const p of pages) if (p.state === "active") active += 1;
  return { index, pages, active };
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
