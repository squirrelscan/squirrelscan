// Fold over-cap per-rule check arrays into per-issue-class aggregates (#910).

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import {
  clampDetailsRecord,
  clampItemId,
  clampItemString,
} from "@squirrelscan/core-contracts/clamp";
import { PUBLISH_LIMITS, REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { byteLength } from "@squirrelscan/utils/bytes";

/**
 * Bound every check item's `id`/`label` to the publish schema's medium-string
 * cap (#996). Rules emit raw URLs/selectors as ids (a `data:` URL image src
 * blows past 1000 chars) which the API used to REJECT, failing the whole audit.
 * Clamp producer-side — before fold (fold merges items by id) and before publish
 * — so both the CLI and the cloud container emit already-bounded ids. Returns the
 * SAME array/check/item references when nothing overruns, so under-cap reports are
 * untouched (no re-sort, no content-hash churn). id uses a hash-suffix clamp so
 * two distinct long ids stay distinct; label is a plain truncate.
 */
export function clampCheckItemIds(checks: CheckResult[]): CheckResult[] {
  let arrayChanged = false;
  const out = checks.map((check) => {
    if (!check.items || check.items.length === 0) return check;
    let itemsChanged = false;
    const items = check.items.map((item) => {
      const id = clampItemId(item.id, REPORT_LIMITS.maxMediumString);
      const label =
        item.label === undefined
          ? undefined
          : clampItemString(item.label, REPORT_LIMITS.maxMediumString);
      if (id === item.id && label === item.label) return item;
      itemsChanged = true;
      return { ...item, id, ...(label !== undefined ? { label } : {}) };
    });
    if (!itemsChanged) return check;
    arrayChanged = true;
    return { ...check, items };
  });
  return arrayChanged ? out : checks;
}

/**
 * #1263: bound every DISPLAY check string that may interpolate crawled page
 * content — `message`, `value`/`expected` (when string-typed), `skipReason` — to
 * the publish schema's medium-string cap, at the SAME producer-side choke point
 * as {@link clampCheckItemIds}. The API publish schema already truncates these
 * on receipt (#1216), but rules emit them into the LOCAL/unpublished report AND
 * the pre-publish issue/finding derivations, so clamping here makes the built
 * report uniformly bounded no matter which path renders it. `name` is a
 * fold/dedup + resolutionSignal JOIN KEY — never clamped. Returns the SAME
 * references when nothing overruns (no re-sort, no content-hash churn).
 */
export function clampCheckStrings(checks: CheckResult[]): CheckResult[] {
  const max = REPORT_LIMITS.maxMediumString;
  let arrayChanged = false;
  const out = checks.map((check) => {
    const message = clampItemString(check.message, max);
    const value = typeof check.value === "string" ? clampItemString(check.value, max) : check.value;
    const expected =
      typeof check.expected === "string" ? clampItemString(check.expected, max) : check.expected;
    const skipReason =
      check.skipReason === undefined ? undefined : clampItemString(check.skipReason, max);
    if (
      message === check.message &&
      value === check.value &&
      expected === check.expected &&
      skipReason === check.skipReason
    ) {
      return check;
    }
    arrayChanged = true;
    return {
      ...check,
      message,
      ...(value !== undefined ? { value } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(skipReason !== undefined ? { skipReason } : {}),
    };
  });
  return arrayChanged ? out : checks;
}

/**
 * #1288: bound every check's free-form `details` record at the SAME
 * producer-side choke point as {@link clampCheckStrings} — `details` is
 * `z.record(z.unknown())` at the publish schema (no single string to clamp
 * like message/value/expected), so it's bounded structurally instead via
 * {@link clampDetailsRecord} (depth/key-count/byte-budget + string-leaf
 * clamps). The API publish schema already clamps `details` on receipt, but
 * rules build the LOCAL/unpublished report directly from this same
 * CheckResult[], so clamping here keeps every rendering path uniformly
 * bounded regardless of whether it ever reaches the publish schema. Returns
 * the SAME references when nothing overruns.
 */
export function clampCheckDetails(checks: CheckResult[]): CheckResult[] {
  let arrayChanged = false;
  const out = checks.map((check) => {
    if (!check.details) return check;
    const clamped = clampDetailsRecord(check.details) as Record<string, unknown>;
    if (clamped === check.details) return check;
    arrayChanged = true;
    return { ...check, details: clamped };
  });
  return arrayChanged ? out : checks;
}

/**
 * Clamp a single check's `items` array to `maxItems` BEFORE fold/publish
 * (#1003). {@link foldOverflowChecks}'s own item-merge cap (inside foldGroup)
 * only applies when MERGING an over-cap (name, status) issue-class group
 * (#910) — a standalone check that already carries more than `maxItems` on
 * its own is never grouped (`group.length === 1` short-circuits straight to
 * the original check) and sails through untouched. Site-wide "one item per
 * broken link/image" checks (broken-links, broken-external-links,
 * broken-images — all `scope: "site"`, each emitting exactly ONE check) hit
 * this on link/image-heavy sites: the check count never overflows
 * maxChecksPerRule, so fold never triggers, and nothing else bounds the
 * items array — the publish schema's silent truncatedArray slice (#817) was
 * the only thing capping it. Clamp producer-side so that stays exceptional.
 *
 * Stamps `details.additional` with the dropped count, added to any existing
 * rule-side remainder (same bookkeeping as foldGroup's `additional`).
 * Returns the SAME array/check references when nothing overruns.
 */
export function clampCheckItemsOverflow(
  checks: CheckResult[],
  maxItems: number = REPORT_LIMITS.maxItemsPerCheck,
): CheckResult[] {
  let arrayChanged = false;
  const out = checks.map((check) => {
    if (!check.items || check.items.length <= maxItems) return check;
    const dropped = check.items.length - maxItems;
    arrayChanged = true;
    return {
      ...check,
      items: check.items.slice(0, maxItems),
      details: { ...check.details, additional: checkAdditional(check) + dropped },
    };
  });
  return arrayChanged ? out : checks;
}

/**
 * Publish-time SAMPLE caps (#1167). A published report is a summary, so every
 * check ships a bounded sample rather than the full crawl-scaled detail. Applied
 * by BOTH publish producers — the CLI (`slimForPublish`) and the cloud container
 * (worker-agent `truncateReportForPublish`) — via {@link sampleChecksForPublish},
 * so the publish payload is O(rules × sample_cap), flat regardless of crawl size.
 */
export interface PublishSampleLimits {
  /** Max affected-page URLs kept on a check's `pages[]` (rest → details.pagesTruncated). */
  maxPagesPerCheck: number;
  /** Max items kept on a check (rest → details.additional). */
  maxItems: number;
  /** Max `sourcePages` kept per item (deduped first). */
  maxSourcePagesPerItem: number;
}

/** Default publish sample: the primary caps applied on every publish (#1167). */
export const DEFAULT_PUBLISH_SAMPLE: PublishSampleLimits = {
  maxPagesPerCheck: PUBLISH_LIMITS.maxPagesPerCheckPublish,
  maxItems: PUBLISH_LIMITS.maxItems,
  maxSourcePagesPerItem: PUBLISH_LIMITS.maxSourcePagesPerItemPublish,
};

/**
 * Sample every check in an array for publish (#1167): clip `pages[]` to a fixed
 * cap (stamping `details.pagesTruncated` = the pre-clip count so the server's
 * `collectCheckTruncations` surfaces the cut AND the smart-audits merge treats the
 * page list as a SAMPLE), clip `items[]` (rolling the drop into
 * `details.additional`), and per kept item clamp its id/label to the medium-string
 * cap + dedupe/clip its `sourcePages`. Pages kept are the FIRST-N (post-fold dedupe
 * order — deterministic + stable across repeat audits, so the publish content hash
 * doesn't churn). Returns the SAME array/check/item references when nothing
 * overruns, so an already-small report is untouched.
 *
 * `pagesTruncated` is preserved-if-larger: a prior clip (e.g. the fold cap or a
 * second degrade pass) that already recorded a bigger original count wins, so the
 * true pre-sample total never gets overwritten by a later, smaller length.
 */
export function sampleChecksForPublish(
  checks: CheckResult[],
  limits: PublishSampleLimits = DEFAULT_PUBLISH_SAMPLE,
): CheckResult[] {
  let arrayChanged = false;
  const out = checks.map((check) => {
    const next = sampleCheckForPublish(check, limits);
    if (next !== check) arrayChanged = true;
    return next;
  });
  return arrayChanged ? out : checks;
}

/**
 * Chunked-publish shell slim (#1324): collapse ONE rule's per-page fail/warn
 * checks into a bounded aggregate per (name, status) issue class, DROP per-page
 * PASS checks entirely, and keep site-scope checks (no `pageUrl`) verbatim.
 *
 * WHY: on the chunked publish path the COMPLETE per-page findings are streamed
 * into page_findings and finalize reconstructs freshResults from them
 * (reconstructCompleteResults), so the shell's per-page checks are redundant for
 * SCORING — the shell only needs to (a) validate against auditReportSchema and
 * (b) render a bounded viewer sample when the smart-audits merge is off (then the
 * shell IS the stored report). A non-folded per-page shell is O(pages) — thousands
 * of check objects (61% of them pass rows that render nothing actionable) — which
 * is exactly what OOMs the API isolate on the init POST (#1324). Folding makes the
 * shell O(rules × classes): every affected page survives as `details.occurrences`
 * + a ≤maxPagesPerCheckPublish `pages` sample with `details.pagesTruncated` = the
 * true count (affected-pages.ts reads that), and pass rows are dropped (a page's
 * pass never becomes an issue or a viewer row). Scoring is unaffected either way —
 * the merge rescore rebuilds from findings (merge on) or trusts the report's
 * already-computed healthScore/passed/failed (merge off); ruleResults.checks is
 * display/transport only on the publish path.
 *
 * Site-scope checks (all statuses) are kept: reconstructCompleteResults keeps them
 * verbatim, so they must ride the shell.
 */
export function slimPageChecksForShell(checks: CheckResult[]): CheckResult[] {
  const kept: CheckResult[] = [];
  const pageIssues: CheckResult[] = [];
  for (const c of checks) {
    if (!c.pageUrl) {
      kept.push(c); // site-scope check — keep verbatim (reconstruct keeps these)
      continue;
    }
    if (c.status === "pass") continue; // per-page pass — drop (renders nothing actionable)
    pageIssues.push(c); // per-page fail/warn — fold below
  }
  if (pageIssues.length === 0) return kept.length === checks.length ? checks : kept;
  // Fold every (name,status) class to one aggregate, then sample its pages. maxChecks
  // = the distinct class count FORCES the fold regardless of page count (the default
  // only folds past maxChecksPerRule) while keeping every class (out.length = classes,
  // never > maxChecks, so the trailing slice-to-cap can't drop a class). Fold keeps the
  // full pages[] (≤5000) so sampleChecksForPublish can stamp the true pre-clip count as
  // `details.pagesTruncated`; occurrences carries the folded per-page check count.
  const classes = new Set(pageIssues.map((c) => `${c.name}\u0000${c.status}`)).size;
  const folded = sampleChecksForPublish(
    foldOverflowChecks(pageIssues, { ...DEFAULT_FOLD_LIMITS, maxChecks: classes }),
  );
  return [...kept, ...folded];
}

function sampleCheckForPublish(check: CheckResult, limits: PublishSampleLimits): CheckResult {
  let changed = false;
  let details = check.details;

  // 1) Sample pages[] → keep first-N, record the pre-clip count as a SAMPLE marker.
  let pages = check.pages;
  if (pages && pages.length > limits.maxPagesPerCheck) {
    const originalLen = pages.length;
    pages = pages.slice(0, limits.maxPagesPerCheck);
    const priorTruncated = details?.pagesTruncated;
    const pagesTruncated =
      typeof priorTruncated === "number" && priorTruncated > originalLen
        ? priorTruncated
        : originalLen;
    details = { ...details, pagesTruncated };
    changed = true;
  }

  // 2) Sample items[] → keep first-N, roll the drop into details.additional, and
  //    clamp each kept item's id/label + sourcePages.
  let items = check.items;
  if (items && items.length > 0) {
    const kept = items.length > limits.maxItems ? items.slice(0, limits.maxItems) : items;
    const dropped = items.length - kept.length;
    let itemsChanged = kept !== items;
    const clampedItems = kept.map((item) => {
      const id = clampItemId(item.id, REPORT_LIMITS.maxMediumString);
      const label =
        item.label === undefined
          ? undefined
          : clampItemString(item.label, REPORT_LIMITS.maxMediumString);
      let sourcePages = item.sourcePages;
      if (sourcePages && sourcePages.length > 0) {
        const deduped = [...new Set(sourcePages)];
        const sliced =
          deduped.length > limits.maxSourcePagesPerItem
            ? deduped.slice(0, limits.maxSourcePagesPerItem)
            : deduped;
        // Reuse the original ref only when dedupe + clip were both no-ops.
        sourcePages = sliced.length === sourcePages.length ? sourcePages : sliced;
      }
      if (id === item.id && label === item.label && sourcePages === item.sourcePages) return item;
      itemsChanged = true;
      return {
        ...item,
        id,
        ...(label !== undefined ? { label } : {}),
        ...(sourcePages ? { sourcePages } : {}),
      };
    });
    if (itemsChanged) {
      items = clampedItems;
      changed = true;
    }
    if (dropped > 0) {
      details = { ...details, additional: checkAdditional(check) + dropped };
    }
  }

  if (!changed) return check;
  return {
    ...check,
    ...(pages ? { pages } : {}),
    ...(items ? { items } : {}),
    ...(details ? { details } : {}),
  };
}

/**
 * Publish DEGRADE pass (#1172): re-sample an already-slimmed publish report's
 * per-check detail to a HARDER limit set. BOTH publish producers reach for this
 * when the primary-capped body still exceeds the payload/isolate gate — the CLI
 * (`publishReport` on a >20MB body) and the cloud container
 * (`attemptPublishReport` on a 413 / over-budget pre-check) — re-running
 * {@link sampleChecksForPublish} over every rule's `checks` and `siteChecks`
 * with the tighter `limits` (e.g. PUBLISH_DEGRADE_LIMITS). Mutates the checks
 * arrays on the report IN PLACE (both callers own their report by the time they
 * degrade — the CLI a throwaway slim, the cloud an already-mutated report) and
 * returns the same report.
 *
 * Idempotent + monotonic: re-sampling an already-sampled report at tighter
 * limits yields the SAME result as sampling the original once at those limits —
 * kept pages/items are first-N (N ≤ the prior cap, so first-N of first-M =
 * first-N), and `details.pagesTruncated` (preserved-if-larger) /
 * `details.additional` (additive) carry the TRUE pre-sample totals across
 * passes. So a report already at/under `limits` passes through unchanged (same
 * refs, via sampleChecksForPublish), and a second degrade is a no-op.
 */
export function degradeAndRebuild<
  T extends {
    ruleResults?: Record<string, { checks?: CheckResult[] } | null | undefined> | null;
    siteChecks?: CheckResult[] | null;
  },
>(report: T, limits: PublishSampleLimits): T {
  const ruleResults = report.ruleResults;
  if (ruleResults && typeof ruleResults === "object") {
    for (const rule of Object.values(ruleResults)) {
      if (rule && Array.isArray(rule.checks)) {
        rule.checks = sampleChecksForPublish(rule.checks, limits);
      }
    }
  }
  if (Array.isArray(report.siteChecks)) {
    report.siteChecks = sampleChecksForPublish(report.siteChecks, limits);
  }
  return report;
}

export interface FoldLimits {
  /** Max checks per rule in the published report (REPORT_LIMITS.maxChecksPerRule). */
  maxChecks: number;
  /** Max items on the folded aggregate check (REPORT_LIMITS.maxItemsPerCheck). */
  maxItemsPerCheck: number;
  /** Max pages on the folded aggregate check (schema cap: REPORT_LIMITS.maxPagesPerCheck). */
  maxPagesPerCheck: number;
  /** Max sourcePages per merged item (API checkItemSchema cap). */
  maxSourcePagesPerItem: number;
}

export const DEFAULT_FOLD_LIMITS: FoldLimits = {
  maxChecks: REPORT_LIMITS.maxChecksPerRule,
  maxItemsPerCheck: REPORT_LIMITS.maxItemsPerCheck,
  maxPagesPerCheck: REPORT_LIMITS.maxPagesPerCheck,
  maxSourcePagesPerItem: PUBLISH_LIMITS.maxSourcePagesPerItem,
};

// details.additional carries a rule's own "items truncated to N, remainder"
// count (e.g. critical-request-chains keeps 10 items + additional). Folded
// checks must not lose it or the aggregate undercounts.
function checkAdditional(check: CheckResult): number {
  const extra = check.details?.additional;
  return typeof extra === "number" && Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0;
}

/**
 * Bound a rule's report check array to `maxChecks` by folding each
 * (name, status) issue class down to ONE aggregate check (#910).
 *
 * Page-scope rules legitimately emit one check per affected page, so a
 * link-heavy 500+ page crawl overflows REPORT_LIMITS.maxChecksPerRule and the
 * publish schema silently slices the array (#817) — pages past the cap vanish
 * from the published report. Folding instead keeps every affected page:
 *  - `pages` = union of the folded checks' pageUrl/pages (schema allows maxPages);
 *  - `items` = union of the folded checks' items, deduped by id, each stamped
 *    with the pages it came from via `sourcePages`;
 *  - `details.occurrences` = folded check count (issue-sync reads this so the
 *    tracker's occurrence count survives the fold);
 *  - `details.additional` = items dropped at the cap + folded per-check remainders.
 *
 * Rules under the cap pass through UNTOUCHED (same reference) — scoring and
 * report totals are computed from the un-folded map upstream, so this only
 * changes what leaves the process in the report payload.
 */
export function foldOverflowChecks(
  checks: CheckResult[],
  limits: FoldLimits = DEFAULT_FOLD_LIMITS,
): CheckResult[] {
  if (checks.length <= limits.maxChecks) return checks;

  // Group per issue class, first-seen order. NUL cannot appear in a check name.
  const groups = new Map<string, CheckResult[]>();
  for (const check of checks) {
    const key = `${check.name}\u0000${check.status}`;
    const group = groups.get(key);
    if (group) group.push(check);
    else groups.set(key, [check]);
  }

  const out: CheckResult[] = [];
  for (const group of groups.values()) {
    out.push(group.length === 1 ? group[0]! : foldGroup(group, limits));
  }

  // Rule execution order is nondeterministic (#114); sort so repeat audits emit
  // identical folded arrays (#150 diff-churn, publish content hash).
  out.sort((a, b) => {
    const nameDiff = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    if (nameDiff !== 0) return nameDiff;
    return a.status < b.status ? -1 : a.status > b.status ? 1 : 0;
  });

  // No rule emits >maxChecks distinct issue classes; slice keeps the invariant
  // absolute if one ever does.
  return out.length > limits.maxChecks ? out.slice(0, limits.maxChecks) : out;
}

/**
 * Producer-side pre-clamp for a SINGLE RULE's checks array bound for publish
 * (#1003): clamp oversize item ids/labels (#996), clamp any single check's
 * oversize `items` array (#1003, see {@link clampCheckItemsOverflow}), then
 * fold the array itself down to `maxChecks` (#910). Composes the clamps in
 * the order that keeps each one's invariants — items must be bounded before
 * folding merges them, since a merge group's own item cap only catches items
 * dropped DURING a merge, not an already-oversize single check.
 *
 * foldOverflowChecks groups by (name, status): sound ONLY when every check in
 * the array comes from the SAME rule, where a repeated (name, status) really
 * does mean "the same finding, recurring" (e.g. once per affected page). Do
 * NOT use this for a checks array that mixes multiple rules' checks (a page's
 * `checks`, or the flat site-rules list) — two unrelated rules could
 * coincidentally share a check name+status, and folding would silently merge
 * them, dropping one check's `value`/`expected` and mislabeling the result
 * with fold's "(+N more pages)" wording. Use
 * {@link capMixedRuleChecksForPublish} for those. One call site: this is for
 * `ruleResults.<id>.checks` (maxChecks = REPORT_LIMITS.maxChecksPerRule), the
 * shape #910 was designed for.
 */
export function capChecksForPublish(checks: CheckResult[], maxChecks: number): CheckResult[] {
  return foldOverflowChecks(
    clampCheckItemsOverflow(clampCheckItemIds(clampCheckDetails(clampCheckStrings(checks)))),
    { ...DEFAULT_FOLD_LIMITS, maxChecks },
  );
}

/**
 * Producer-side pre-clamp for a checks array that MIXES multiple rules'
 * checks bound for publish (#1003): `pages[].checks` (every page-scoped
 * rule's check for one page) and `siteChecks` (every site-scoped rule's
 * check, flattened). Clamps oversize item ids/labels (#996) and any single
 * check's oversize `items` array (#1003), same as {@link capChecksForPublish}
 * — but caps the checks COUNT with a plain slice, not a fold: grouping by
 * (name, status) across DIFFERENT rules is unsound (see
 * {@link capChecksForPublish}'s doc), so this never merges. A dropped check
 * past `maxChecks` has NO signal at all — the array already fits under the
 * cap by the time it reaches the publish schema, so
 * `collectCheckTruncations`'s count check never trips for it (unlike the
 * schema's own `truncatedArray` slice, which the RAW pre-parse payload diff
 * still catches). Same silent-clamp tradeoff as `clampCheckItemIds` (#996).
 * In practice these arrays rarely exceed
 * `maxChecks` (this is a last-resort safety net, not the primary #1003
 * producer).
 */
export function capMixedRuleChecksForPublish(
  checks: CheckResult[],
  maxChecks: number,
): CheckResult[] {
  const clamped = clampCheckItemsOverflow(
    clampCheckItemIds(clampCheckDetails(clampCheckStrings(checks))),
  );
  return clamped.length > maxChecks ? clamped.slice(0, maxChecks) : clamped;
}

/**
 * Inverse of {@link foldOverflowChecks}: expand ONE folded aggregate back into
 * per-page checks (#910/#916). A published report arrives already folded, so any
 * consumer that needs per-page granularity — the server smart-audits union, which
 * re-derives one finding per affected page — must reconstruct them. The aggregate
 * carries every affected page in `pages` and each merged item's originating pages
 * in `sourcePages`, so emit one synthetic check per page, attributing each item to
 * the page(s) it came from.
 *
 * Lossless up to the fold's page cap (maxPagesPerCheck) and item sourcePages cap.
 * A non-aggregate check (or any check with no `pages`) passes through unchanged,
 * so this is a safe no-op to flatMap over a never-folded or mixed array.
 */
export function unfoldAggregateCheck(check: CheckResult): CheckResult[] {
  if (check.details?.aggregated !== true || !check.pages || check.pages.length === 0) {
    return [check];
  }
  // foldGroup composed the message as `${first.message} (+N more pages)`; strip
  // that suffix so a downstream re-fold doesn't stack a second one and carried
  // findings read as the plain per-page message.
  const perPageMessage = check.message.replace(/ \(\+\d+ more pages\)$/, "");
  // `aggregated`/`occurrences` describe the whole fold — meaningless per page.
  // `additional` (items dropped at the fold cap) can't be split across pages, so
  // pin the whole count to the FIRST page below: the scorer keys its density
  // penalty on (name,pageUrl) and reads `details.additional`, so dropping it
  // outright would understate the penalty and inflate the score for item-heavy
  // folded rules. A downstream re-fold re-sums it back onto the aggregate.
  const baseDetails: Record<string, unknown> = { ...check.details };
  delete baseDetails.aggregated;
  delete baseDetails.occurrences;
  const additional = baseDetails.additional;
  delete baseDetails.additional;

  // Index items by source page ONCE (O(items × sourcePages)) rather than
  // re-filtering all items per page (O(pages × items)) — the aggregate can carry
  // up to maxPagesPerCheck × maxItemsPerCheck, and this runs server-side on every
  // publish for over-cap rules.
  const itemsByPage = new Map<string, CheckItem[]>();
  for (const item of check.items ?? []) {
    for (const src of item.sourcePages ?? []) {
      const list = itemsByPage.get(src);
      if (list) list.push(item);
      else itemsByPage.set(src, [item]);
    }
  }

  return check.pages.map((page, i) => {
    const pageItems = itemsByPage.get(page);
    const details: Record<string, unknown> = { ...baseDetails };
    if (i === 0 && typeof additional === "number" && additional > 0) {
      details.additional = additional;
    }
    return {
      ...check,
      message: perPageMessage,
      pageUrl: page,
      pages: undefined,
      items: pageItems && pageItems.length > 0 ? pageItems : undefined,
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  });
}

/** Bytes reserved for the rest of the (separately capped) report under the 20MB
 * publish limit; the pages budget is maxPayloadBytes minus this headroom. */
const PAGES_PAYLOAD_HEADROOM = 6 * 1024 * 1024;

/**
 * Clamp a report's total folded `pages[]` bytes to a publish-payload budget so a
 * large crawl can't 413 the whole publish (#918). The raised per-check pages cap
 * (`maxPagesPerCheck` = 5000) lets a large-bad-site CLI audit carry enough
 * affected-page URLs across many rules to approach the API's 20MB body limit —
 * which rejects the ENTIRE publish, strictly worse than a clip. This degrades
 * gracefully: clip the largest `pages[]` arrays largest-first until the estimated
 * pages bytes fit the budget, stamping `details.pagesTruncated` (the pre-clip
 * count) so the server's `collectCheckTruncations` surfaces the cut as the
 * existing #817 signal instead of a silent drop.
 *
 * Budget covers pages bytes only — the caller/default sizes it below
 * maxPayloadBytes with headroom for the rest of the report (items, summary,
 * sitemaps, pageStatuses are all separately capped and realistically small).
 * Reassigns each clipped check's `pages` to a fresh sliced array (never mutates
 * the source). Returns the number of page entries dropped (0 = fit, no-op).
 */
export function clampReportPagesToBudget(
  ruleResults: Record<string, { checks: CheckResult[] }>,
  budgetBytes: number = REPORT_LIMITS.maxPayloadBytes - PAGES_PAYLOAD_HEADROOM,
): number {
  // "url", — quotes + comma per JSON array entry. #1275: measure the UTF-8 byte
  // size, not `.length` (UTF-16 code units), so a multi-byte URL is estimated at
  // its true wire size against this byte budget.
  const entryBytes = (url: string): number => byteLength(url) + 3;

  // Track the containing array + index so a clip REPLACES the element with a
  // clone rather than mutating the check object — the caller's checks arrays can
  // share objects with the source report (sampleChecksForPublish returns the same
  // ref when nothing overran), and slimForPublish re-slims from that same report
  // on its degrade pass, so an in-place mutation here would corrupt the original.
  const withPages: { checks: CheckResult[]; index: number; bytes: number }[] = [];
  let totalBytes = 0;
  for (const rule of Object.values(ruleResults)) {
    for (let index = 0; index < rule.checks.length; index++) {
      const check = rule.checks[index]!;
      if (!check.pages || check.pages.length === 0) continue;
      let bytes = 0;
      for (const url of check.pages) bytes += entryBytes(url);
      withPages.push({ checks: rule.checks, index, bytes });
      totalBytes += bytes;
    }
  }
  if (totalBytes <= budgetBytes) return 0;

  // Clip the largest pages arrays first until the global excess is covered.
  withPages.sort((a, b) => b.bytes - a.bytes);
  let excess = totalBytes - budgetBytes;
  let dropped = 0;
  for (const { checks, index } of withPages) {
    if (excess <= 0) break;
    const check = checks[index]!;
    const pages = check.pages!;
    const originalLen = pages.length;
    let keep = originalLen;
    // Keep at least one page so the check still cites where it fired.
    while (excess > 0 && keep > 1) {
      keep--;
      excess -= entryBytes(pages[keep]!);
      dropped++;
    }
    if (keep < originalLen) {
      // Preserve an already-recorded (larger) pre-sample count: publish sampling
      // (#1167) runs before this backstop and stamps the TRUE original page total;
      // this budget clip must not overwrite it with the post-sample length.
      const priorTruncated = check.details?.pagesTruncated;
      const pagesTruncated =
        typeof priorTruncated === "number" && priorTruncated > originalLen
          ? priorTruncated
          : originalLen;
      // Clone (never mutate the source check) — fresh pages array + details.
      checks[index] = {
        ...check,
        pages: pages.slice(0, keep),
        details: { ...check.details, pagesTruncated },
      };
    }
  }
  return dropped;
}

function foldGroup(group: CheckResult[], limits: FoldLimits): CheckResult {
  const first = group[0]!;

  const pageSet = new Set<string>();
  for (const check of group) {
    if (check.pageUrl) pageSet.add(check.pageUrl);
    for (const page of check.pages ?? []) pageSet.add(page);
  }
  const pages = [...pageSet].sort().slice(0, limits.maxPagesPerCheck);

  // Merge items by id; the folded checks' pageUrl becomes each item's
  // sourcePages so per-page attribution survives losing per-check pageUrl.
  const itemMap = new Map<string, CheckItem>();
  const sourceSets = new Map<string, Set<string>>();
  // Unique ids dropped at the cap — a repeat occurrence of an already-dropped
  // item (shared CDN asset referenced from many pages) must not recount.
  const droppedIds = new Set<string>();
  let additional = 0;
  for (const check of group) {
    additional += checkAdditional(check);
    for (const item of check.items ?? []) {
      let sources = sourceSets.get(item.id);
      if (!sources) {
        if (itemMap.size >= limits.maxItemsPerCheck) {
          droppedIds.add(item.id);
          continue;
        }
        itemMap.set(item.id, { ...item });
        sources = new Set(item.sourcePages ?? []);
        sourceSets.set(item.id, sources);
      } else {
        for (const src of item.sourcePages ?? []) sources.add(src);
      }
      // Attribute the item to the check's page(s). A per-page check carries
      // `pageUrl`. An already-aggregated check (re-fold path, #916) carries
      // `pages` — but only fall back to it when the item has NO sourcePages of
      // its own, else a re-fold would over-broaden a narrowly-scoped item to
      // every page of the aggregate (false attribution).
      if (check.pageUrl) {
        sources.add(check.pageUrl);
      } else if (!item.sourcePages?.length) {
        for (const page of check.pages ?? []) sources.add(page);
      }
    }
  }
  const items = [...itemMap.values()]
    .map((item) => {
      const sources = sourceSets.get(item.id)!;
      return sources.size > 0
        ? { ...item, sourcePages: [...sources].sort().slice(0, limits.maxSourcePagesPerItem) }
        : item;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const details: Record<string, unknown> = { aggregated: true, occurrences: group.length };
  if (additional + droppedIds.size > 0) details.additional = additional + droppedIds.size;

  // Smart audits (#110): stay "carried" only when every folded finding was.
  const allCarried = group.every((c) => c.provenance === "carried");
  let lastSeenAt: number | undefined;
  if (allCarried) {
    for (const c of group) {
      if (c.lastSeenAt !== undefined) lastSeenAt = Math.max(lastSeenAt ?? 0, c.lastSeenAt);
    }
  }

  // Composed message must stay under the API's medium-string cap or the whole
  // publish 400s (strings are rejected, not truncated).
  const message = `${first.message} (+${group.length - 1} more pages)`.slice(
    0,
    REPORT_LIMITS.maxMediumString,
  );

  return {
    name: first.name,
    status: first.status,
    message,
    ...(pages.length > 0 ? { pages } : {}),
    ...(items.length > 0 ? { items } : {}),
    details,
    ...(first.skipReason !== undefined ? { skipReason: first.skipReason } : {}),
    ...(allCarried
      ? { provenance: "carried" as const, ...(lastSeenAt !== undefined ? { lastSeenAt } : {}) }
      : {}),
  };
}
