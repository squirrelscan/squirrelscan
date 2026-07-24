// Container-side complete-findings flattening for chunked publish (#1023 R-D3).
//
// The chunked-publish producer (worker-agent) streams the COMPLETE per-page
// findings into page_findings BEFORE the shell is sampled, so finalize can
// reconstruct the complete freshResults. This builds those NDJSON lines from the
// report's PRE-sample `ruleResults` using the SAME unfold + flatten the server's
// merge uses (unfoldAggregateCheck → flattenChecks), so what the container
// streams round-trips exactly through the server's reconstructCompleteResults.
//
// Worker-clean (no node/linkedom): flatten + fingerprint + url only. Surfaced via
// the package's `./smart-audits` entry so the container can import it.

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import { unfoldAggregateCheck } from "@squirrelscan/rules/fold";
import { normalizeUrl } from "@squirrelscan/utils/url";

import { findingFingerprint } from "./fingerprint";
import { findingKey, flattenChecks } from "./merge-core";

/**
 * One NDJSON finding line for the chunked-publish `/chunk` endpoint. Matches the
 * server's `pageFindingIngestSchema` minus the server-stamped `siteKey` /
 * `lastSeenCrawlId` (the session supplies those). `severity` comes from the rule
 * meta; `fingerprint` is the portable change hash (CLI+server parity).
 */
export type StreamFindingLine = Omit<PageFindingRecord, "siteKey" | "lastSeenCrawlId">;

/**
 * Flatten a report's `ruleResults` into complete streamable finding lines. Only
 * page-scope fail/warn checks become findings (mirrors flattenChecks + the
 * merge's `if (!c.pageUrl) continue` gate); folded aggregates are unfolded first
 * so every affected page is emitted, not just the fold's representative. `now`
 * stamps firstSeenAt/lastSeenAt (the server's LEAST(first_seen) upsert preserves
 * an earlier value on re-appearance, so this is a safe default).
 */
export function buildStreamFindings(
  // Accepts both the report's ReportRuleResult (RuleMetaLite) and the engine's
  // RuleRunResult (RuleMeta) — only `meta.severity` is read.
  ruleResults: Record<string, { meta: { severity: string }; checks: CheckResult[] }>,
  now: number,
): StreamFindingLine[] {
  // Dedupe by the page_findings PK (normalizedUrl, ruleId, checkName, locator),
  // LAST wins — the store upsert collapses key collisions (status is NOT part of
  // the key), so the streamed count must equal the store row count or finalize's
  // `received >= expected` gate never trips. Latest-wins matches computeMerge's
  // freshByKey, keeping the chunked and single-POST stores identical.
  const byKey = new Map<string, StreamFindingLine>();
  for (const [ruleId, r] of Object.entries(ruleResults)) {
    const severity = r.meta.severity;
    const checks = r.checks.flatMap(unfoldAggregateCheck);
    // Group per page (flattenChecks stamps one normalizedUrl across its checks).
    const byUrl = new Map<string, CheckResult[]>();
    for (const c of checks) {
      if (!c.pageUrl) continue; // site-scope check — never a per-page finding
      const u = normalizeUrl(c.pageUrl);
      const arr = byUrl.get(u);
      if (arr) arr.push(c);
      else byUrl.set(u, [c]);
    }
    for (const [u, cs] of byUrl) {
      for (const f of flattenChecks(u, ruleId, cs)) {
        byKey.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), {
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
          fingerprint: findingFingerprint(f.status, f.message, f.value, f.expected),
          firstSeenAt: now,
          lastSeenAt: now,
          provenance: "fresh",
          state: "open",
        });
      }
    }
  }
  return [...byKey.values()];
}

/** `{ ruleId: { checkName: passCount } }` — passing checks on DIRTY pages. */
export type SkippedPassCounts = Record<string, Record<string, number>>;

/**
 * Count, per (ruleId, checkName), the PASSING checks that `flattenChecks` never
 * streams (only fail/warn become findings) but that sit on a page which ALSO has
 * a fail/warn finding for the same rule — a "dirty" page.
 *
 * WHY: `reconstructCompleteResults` folds fresh CLEAN pages (zero findings for the
 * rule) into `syntheticPassCount`, but a page with a PARTIAL fail is excluded from
 * that count because it has a finding — so its passing SIBLING checks vanish from
 * both numerator and denominator. Multi-checkName page rules make this common
 * (e.g. schema/faq emits `faq-questions` warn + `faq-valid` pass on the same page),
 * where the sampled path scores warn+pass = 1.5/2 but the complete path scored the
 * passing sibling away to 0.5/1. The server adds these counts back as synthetic
 * pass units so the reconstruction matches the sampled path's per-check granularity.
 *
 * Bounded by (page-scope rule × distinct checkName) — NOT per-page — so it ships in
 * the tiny finalize JSON body. Uses the SAME `unfoldAggregateCheck` as
 * {@link buildStreamFindings}, so passes are counted to the same completeness as the
 * streamed findings. Site-scope checks (no `pageUrl`) are skipped: reconstruct keeps
 * their sampled checks verbatim, so their passes are already counted.
 */
export function buildSkippedPassCounts(
  ruleResults: Record<string, { checks: CheckResult[] }>,
): SkippedPassCounts {
  const out: SkippedPassCounts = {};
  for (const [ruleId, r] of Object.entries(ruleResults)) {
    const checks = r.checks.flatMap(unfoldAggregateCheck);
    // Group this rule's checks by page (page-scope checks carry a pageUrl).
    const byPage = new Map<string, CheckResult[]>();
    for (const c of checks) {
      if (!c.pageUrl) continue;
      const u = normalizeUrl(c.pageUrl);
      const arr = byPage.get(u);
      if (arr) arr.push(c);
      else byPage.set(u, [c]);
    }
    for (const cs of byPage.values()) {
      // Only DIRTY pages matter: a fully-clean page is already a syntheticPassCount
      // unit; a dirty page's passing siblings are what the reconstruction loses.
      if (!cs.some((c) => c.status === "fail" || c.status === "warn")) continue;
      for (const c of cs) {
        if (c.status !== "pass") continue;
        const perCheck = (out[ruleId] ??= {});
        perCheck[c.name] = (perCheck[c.name] ?? 0) + 1;
      }
    }
  }
  return out;
}
