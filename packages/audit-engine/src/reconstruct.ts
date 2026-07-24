// Complete-store freshResults reconstruction (#1023 R-D3).
//
// The published score is built from `freshResults` (a `Map<ruleId, RuleRunResult>`)
// via `buildScoringResultsFromMerged`. On the normal cloud path those freshResults
// come from the report's `ruleResults` — the #1167 100-per-check SAMPLED folded
// aggregates — so a rule failing on >100 pages is scored from a 100-page sample
// (the #1179 starvation). When the chunked-publish path has streamed the COMPLETE
// per-(page,rule,check,locator) findings into the store, finalize can instead
// reconstruct freshResults from those complete findings so scoring sees every
// affected page.
//
// This is the inverse of `flattenChecks` (merge-core.ts): a check with items
// exploded to one finding per item is regrouped back into one CheckResult per
// (page, checkName); a whole-check finding (locator "") rebuilds a single
// CheckResult. Only page-scope rules are reconstructed — `flattenChecks` never
// produces findings for site-scope checks (no pageUrl), so those keep their
// sampled checks verbatim. All-pass page rules (no findings at all) keep their
// meta from the sampled `ruleResults` and score purely off `syntheticPassCount`.
//
// Pass denominator: fresh clean pages (crawled, no finding for the rule) are
// folded into `syntheticPassCount` — NOT materialized as per-page pass checks —
// exactly like the #918 carried-clean model, so a large crawl can't OOM the
// isolate with (page-scope rules × thousands of pages) pass objects. This
// EXTENDS the carried-clean synthetic-pass mechanism to fresh crawled pages;
// `buildScoringResultsFromMerged` preserves this count and adds carried-clean on
// top.

import type { CheckItem, CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import type { SkippedPassCounts } from "./stream-findings";

export interface ReconstructCompleteInput {
  /**
   * The published (sampled) report's `ruleResults` — the source of rule META,
   * the set of rules that ran, and site-scope rules' checks. Page-scope rules'
   * checks are REPLACED by the complete reconstruction from `ingestedFindings`.
   */
  ruleResults: Record<string, { meta: RuleRunResult["meta"]; checks: CheckResult[] }>;
  /** Complete per-(page,rule,check,locator) findings streamed into the store. */
  ingestedFindings: PageFindingRecord[];
  /**
   * Full crawled-URL set (NORMALIZED) for this run — the `syntheticPassCount`
   * denominator. Sourced from `resolutionSignal.crawledUrls`, not the sampled
   * check pageUrls (the #1023 denominator switch).
   */
  crawledUrls: Set<string>;
  /**
   * (#1305) Per-(ruleId, checkName) count of PASSING checks on DIRTY pages — pages
   * that have a fail/warn finding for the rule AND a passing sibling check (e.g.
   * schema/faq's faq-questions warn + faq-valid pass). `page_findings` stores only
   * fail/warn, and a dirty page is excluded from the fresh-clean `syntheticPassCount`,
   * so without this the passing siblings vanish and a multi-checkName rule scores
   * harsher than the sampled path. Computed container-side by `buildSkippedPassCounts`
   * over the SAME complete ruleResults the findings were streamed from. Absent (old
   * containers) → no synthetic passes added, i.e. the pre-#1305 behavior.
   */
  skippedPassCounts?: SkippedPassCounts;
}

interface ParsedPayload {
  items?: CheckItem[];
  details?: Record<string, unknown>;
  pages?: string[];
  /** Emission-order index of this item within its check (flattenChecks stamps
   * it on every item finding). See {@link reconstructRuleChecks}. */
  i?: number;
}

/** Emission-order key for an item finding's payload; findings without a stamped
 * `i` (older payloads, or a payload dropped to null at clamp) sort to the tail
 * while a stable sort keeps their relative load order. */
function emissionIndex(p: ParsedPayload): number {
  return typeof p.i === "number" && Number.isFinite(p.i) ? p.i : Number.MAX_SAFE_INTEGER;
}

function parsePayload(payload: string | null): ParsedPayload {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as ParsedPayload;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Rebuild one page's CheckResults for a single rule from its findings — the
 * inverse of {@link flattenChecks}. Findings are grouped by (normalizedUrl,
 * checkName): item findings (locator = item id) collect back into `items[]`;
 * a single whole-check finding (locator "") rebuilds a check with no items.
 * `details`/`pages` come from the finding payload (identical across a check's
 * item findings — flattenChecks copies the source check's details onto each).
 */
function reconstructRuleChecks(findings: PageFindingRecord[]): CheckResult[] {
  // Nested Map (url -> checkName -> findings) so the group identity needs no
  // concatenated string key / delimiter — a check name is free to contain any
  // character without risking a group collision.
  const byPage = new Map<string, Map<string, PageFindingRecord[]>>();
  for (const f of findings) {
    let byCheck = byPage.get(f.normalizedUrl);
    if (!byCheck) {
      byCheck = new Map();
      byPage.set(f.normalizedUrl, byCheck);
    }
    const list = byCheck.get(f.checkName);
    if (list) list.push(f);
    else byCheck.set(f.checkName, [f]);
  }

  const groups: PageFindingRecord[][] = [];
  for (const byCheck of byPage.values()) for (const group of byCheck.values()) groups.push(group);

  const checks: CheckResult[] = [];
  for (const group of groups) {
    const first = group[0]!;
    // A `warn` finding is a "warn" CheckResult; anything else persisted is a
    // "fail". (flattenChecks only ever emits fail/warn findings.)
    const status = first.status === "warn" ? "warn" : "fail";
    // flattenChecks emits EITHER one whole-check finding (locator "") OR one per
    // item (locator = item.id) for a given check — never both — so a group is
    // homogeneous and this split is exhaustive.
    const itemFindings = group.filter((f) => f.locator !== "");

    const payload = parsePayload(first.payload);
    const check: CheckResult = {
      name: first.checkName,
      status,
      message: first.message,
      pageUrl: first.normalizedUrl,
    };
    if (first.value != null) check.value = first.value;
    if (first.expected != null) check.expected = first.expected;

    if (itemFindings.length > 0) {
      // Restore the ORIGINAL item emission order. `itemFindings` arrives in
      // loadIngestedFindings' `locator` (item id) sort order, which scrambles
      // unpadded numeric ids ("parse-10" < "parse-2"), so we re-sort by the
      // emission index (`i`) flattenChecks stamped into each item's payload.
      // Array.sort is stable, so item findings missing `i` keep their load order.
      const parsed = itemFindings.map((f) => parsePayload(f.payload));
      const order = itemFindings.map((_, idx) => idx);
      order.sort((a, b) => emissionIndex(parsed[a]!) - emissionIndex(parsed[b]!));
      const items: CheckItem[] = [];
      for (const idx of order) {
        const item = parsed[idx]!.items?.[0];
        if (item) items.push(item);
      }
      if (items.length > 0) check.items = items;
    }
    if (payload.details) check.details = payload.details;
    if (payload.pages) check.pages = payload.pages;

    checks.push(check);
  }
  return checks;
}

/**
 * Reconstruct the COMPLETE `freshResults` map for the complete-store finalize
 * path. Page-scope rules' checks come from `ingestedFindings` (every affected
 * page); site-scope rules keep their sampled checks. Each page-scope rule is
 * stamped with `syntheticPassCount` = fresh clean pages (no finding for it) PLUS
 * `skippedPassCounts` (passing sibling checks on dirty pages, #1305), so the pass
 * denominator matches the sampled path without materializing pass checks.
 */
export function reconstructCompleteResults(
  input: ReconstructCompleteInput,
): Map<string, RuleRunResult> {
  const { ruleResults, ingestedFindings, crawledUrls, skippedPassCounts } = input;

  // Group findings by ruleId once.
  const findingsByRule = new Map<string, PageFindingRecord[]>();
  for (const f of ingestedFindings) {
    const list = findingsByRule.get(f.ruleId);
    if (list) list.push(f);
    else findingsByRule.set(f.ruleId, [f]);
  }

  const result = new Map<string, RuleRunResult>();
  for (const [ruleId, r] of Object.entries(ruleResults)) {
    if (r.meta.scope !== "page") {
      // Site-scope rule: findings never carry these (flattenChecks skips
      // no-pageUrl checks), so keep the sampled checks verbatim.
      result.set(ruleId, { meta: r.meta, checks: r.checks });
      continue;
    }

    const findings = findingsByRule.get(ruleId) ?? [];
    const checks = reconstructRuleChecks(findings);

    // Fresh clean pages: crawled pages with NO finding for this rule (fail or
    // warn). A warn page has a finding, so it's excluded here and its 0.5 comes
    // from the reconstructed warn check — never double-counted.
    //
    // SKIP-AS-PASS APPROXIMATION (deliberate, documented): a crawled page the
    // rule SKIPPED (emitted no evaluated check for — e.g. perf/ttfb on a page
    // with no timing data) has no finding, so it's counted here as a clean pass.
    // The sample path instead scores that rule over ONLY its evaluated pages (a
    // skipped page emits no check → not in the denominator), so a skip-heavy rule
    // scores slightly HIGHER on the complete path. This is the SAME optimistic
    // assumption the existing #918 carried-clean model already makes (a carried
    // page with no finding for a rule counts as a pass for it, regardless of
    // whether that rule would evaluate it) — "no finding" is read as "no evidence
    // of failure". resolutionSignal.notEvaluated could exclude skipped pages
    // exactly, at the cost of coupling the reconstruction to the signal internals;
    // the divergence is measured + bounded (complete-store-parity.test.ts, the
    // skip-rule fixture) and revisited only if a real rule mix shows it's large.
    const failingPages = new Set<string>();
    for (const f of findings) failingPages.add(f.normalizedUrl);
    let clean = 0;
    for (const url of crawledUrls) if (!failingPages.has(url)) clean++;

    // (#1305) Passing SIBLING checks on dirty pages: a page with a fail/warn
    // finding is excluded from `clean` above, so its passing checks (never
    // streamed — flattenChecks skips pass) would be lost. Add them back as pass
    // units so a multi-checkName rule (schema/faq etc.) scores at the sampled
    // path's granularity. Disjoint from `clean` (clean = pages with NO finding;
    // these are checks on pages WITH a finding), so no double count.
    let skippedPasses = 0;
    const perCheck = skippedPassCounts?.[ruleId];
    if (perCheck) for (const n of Object.values(perCheck)) skippedPasses += n;
    // SECURITY CLAMP (#1305): skippedPassCounts arrives in the finalize body from
    // the container; an inflated/compromised count added straight into
    // syntheticPassCount would drive this rule's passRate toward 1.0 no matter how
    // many real fails it has — the exact score-integrity class (#1179) this feature
    // fixes. Bound the per-rule sum to the crawl universe (a check can't pass on more
    // pages than were crawled), so the numerator can never exceed the denominator's
    // scale. Only ever REDUCES an over-count (safe direction); the honest counts the
    // container ships are ≤ crawled pages, so this never bites real data.
    skippedPasses = Math.min(skippedPasses, crawledUrls.size);
    const syntheticPassCount = clean + skippedPasses;

    result.set(ruleId, {
      meta: r.meta,
      checks,
      ...(syntheticPassCount > 0 ? { syntheticPassCount } : {}),
    });
  }

  // A finding whose rule is absent from `ruleResults` cannot be scored (no meta)
  // — skip it, mirroring buildScoringResultsFromMerged's unknown-rule guard. In
  // practice every rule that produced findings is present in `ruleResults`.

  return result;
}
