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
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { unfoldAggregateCheck } from "@squirrelscan/rules/fold";
import { normalizePageUrl } from "@squirrelscan/utils/url";

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
 * Safety net for an over-cap payload carrying component evidence.
 *
 * `flattenChecks` already keeps every payload it builds within
 * `maxFindingPayload`, so in practice nothing here fires — it exists because
 * the chunk ingest DROPS an over-cap payload whole, and an additive field must
 * never be the reason a complete legacy finding is lost. It mirrors
 * `itemFindingPayload`'s ladder exactly: evidence, then a marker, then the
 * untouched legacy fields.
 */
function clampComponentEvidenceForStream(payload: string | null): string | null {
  if (!payload || payload.length <= REPORT_LIMITS.maxFindingPayload) return payload;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) return payload;
    parsed = value as Record<string, unknown>;
  } catch {
    return payload;
  }

  const occurrences = parsed.componentOccurrences;
  // (#2341) Either kind of evidence can be the reason a payload is over cap, so
  // a payload carrying only resource evidence must still be clampable.
  const resources = parsed.siteResourceOccurrences;
  const resourceCount = siteResourceOccurrenceCount(resources);
  if (!Array.isArray(occurrences) && resourceCount === 0) return payload;

  const {
    componentOccurrences: _componentOccurrences,
    siteResourceOccurrences: _siteResourceOccurrences,
    ...withoutEvidence
  } = parsed;
  const resourceMarker =
    resourceCount > 0
      ? {
          siteResourceEvidence: {
            state: "omitted",
            reason: "payload-limit",
            occurrenceCount: resourceCount,
          },
        }
      : {};

  // Element evidence is the bulkier of the two, so try dropping it alone first:
  // the resource set is what decides the shared-bundle page count, and losing it
  // changes the grouping answer rather than merely thinning the evidence.
  if (Array.isArray(occurrences) && resourceCount > 0) {
    const resourceKept = JSON.stringify({
      ...withoutEvidence,
      siteResourceOccurrences: resources,
      componentEvidence: {
        state: "omitted",
        reason: "payload-limit",
        occurrenceCount: occurrences.length,
      },
    });
    if (resourceKept.length <= REPORT_LIMITS.maxFindingPayload) return resourceKept;
  }

  const omitted = JSON.stringify({
    ...withoutEvidence,
    ...resourceMarker,
    ...(Array.isArray(occurrences)
      ? {
          componentEvidence: {
            state: "omitted",
            reason: "payload-limit",
            occurrenceCount: occurrences.length,
          },
        }
      : {}),
  });
  if (omitted.length <= REPORT_LIMITS.maxFindingPayload) return omitted;
  // No room for even the marker without trimming legacy data. Keep that data
  // byte-identical rather than emitting an over-cap payload the ingest drops.
  return JSON.stringify(withoutEvidence);
}

/** Occurrence count in either wire form, without rehydrating the whole blob. */
function siteResourceOccurrenceCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const rows = (value as { occurrences?: unknown }).occurrences;
  return Array.isArray(rows) ? rows.length : 0;
}

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
      // (#2063) A carried/unrendered check is a REPLAY of something an earlier
      // audit saw, not evidence from this crawl. Streaming it would persist it
      // with this run's crawl id and today's first/last-seen — the complete-store
      // path's version of the same laundering the sampled merge now refuses.
      if (c.provenance === "carried" || c.provenance === "unrendered") continue;
      const u = normalizePageUrl(c.pageUrl);
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
          payload: clampComponentEvidenceForStream(f.payload),
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
      // (#2063) Same exclusion as buildStreamFindings: a replayed fail would mark
      // a page "dirty" that this run never visited, and the synthetic pass counts
      // derived here must describe this crawl only.
      if (c.provenance === "carried" || c.provenance === "unrendered") continue;
      const u = normalizePageUrl(c.pageUrl);
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

// Grouped stream (squirrelscan/repo#1883).
// buildStreamFindings emits one line per page_findings row. Shared-chrome defects
// repeat the same (rule, check, locator, fingerprint) on hundreds of pages, so one
// 401-page site streamed 28,829 lines for 2,606 distinct groups. The grouped form
// ships ONE line per group with the COMPLETE page list; the server materializes the
// same per-page rows with expandGroupedStreamFinding. Additive: the per-page
// producer above is untouched.

/**
 * Default serialized-line budget for a grouped line. The API's per-line ceiling is
 * 256 KiB; half of that leaves headroom for the envelope and multi-byte escaping.
 */
export const GROUPED_STREAM_MAX_LINE_CHARS = 128 * 1024;

/**
 * One grouped NDJSON line: every page that carries the same finding.
 *
 * - `payloads` is a deduped table of the per-page payloads referenced by this line
 *   (payloads differ per page: emission index, page-level aggregate, evidence).
 * - `pages` is `[normalizedUrl, payloadIndex]` sorted by URL; `payloadIndex` points
 *   into `payloads`. The list is COMPLETE, never sampled: the score's per-page
 *   denominator derives from it.
 * - `part`/`parts` (0-based index, total) mark a group whose page list was split
 *   across lines to stay under the line budget; `parts` is 1 when it arrived whole.
 */
export type GroupedStreamFindingLine = Omit<
  StreamFindingLine,
  "normalizedUrl" | "payload" | "provenance" | "state"
> & {
  provenance: "fresh";
  state: "open";
  payloads: (string | null)[];
  pages: Array<[normalizedUrl: string, payloadIndex: number]>;
  part: number;
  parts: number;
};

interface GroupAcc {
  head: Omit<GroupedStreamFindingLine, "payloads" | "pages" | "part" | "parts">;
  /** url -> payload. One entry per page (PK dedupe already applied). */
  pages: Map<string, string | null>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group the report's findings by (ruleId, checkName, locator, fingerprint) without
 * ever materializing the per-page row array. Filtering is exactly
 * {@link buildStreamFindings}': unfold, skip site-scope and carried/unrendered,
 * normalize, flatten per (rule, url), last-wins per PK. The PK includes url and
 * rule, so dedupe per (rule, url) equals the global dedupe.
 *
 * The group key uses the literal status/message/value/expected next to the
 * fingerprint, so a hash collision can never merge two distinct rows.
 */
export function buildGroupedStreamFindings(
  ruleResults: Record<string, { meta: { severity: string }; checks: CheckResult[] }>,
  now: number,
  opts?: { maxLineChars?: number },
): GroupedStreamFindingLine[] {
  const budget = opts?.maxLineChars ?? GROUPED_STREAM_MAX_LINE_CHARS;
  const groups = new Map<string, GroupAcc>();

  for (const [ruleId, r] of Object.entries(ruleResults)) {
    const severity = r.meta.severity;
    const byUrl = new Map<string, CheckResult[]>();
    for (const c of r.checks.flatMap(unfoldAggregateCheck)) {
      if (!c.pageUrl) continue;
      if (c.provenance === "carried" || c.provenance === "unrendered") continue;
      const u = normalizePageUrl(c.pageUrl);
      const arr = byUrl.get(u);
      if (arr) arr.push(c);
      else byUrl.set(u, [c]);
    }
    for (const [u, cs] of byUrl) {
      // Last wins per (checkName, locator): status is not part of the PK.
      const local = new Map<string, ReturnType<typeof flattenChecks>[number]>();
      for (const f of flattenChecks(u, ruleId, cs)) {
        local.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), f);
      }
      for (const f of local.values()) {
        const key = JSON.stringify([
          f.ruleId,
          f.checkName,
          f.locator,
          f.status,
          f.message,
          f.value,
          f.expected,
        ]);
        let g = groups.get(key);
        if (!g) {
          g = {
            head: {
              ruleId: f.ruleId,
              checkName: f.checkName,
              locator: f.locator,
              fingerprint: findingFingerprint(f.status, f.message, f.value, f.expected),
              status: f.status,
              severity,
              message: f.message,
              value: f.value,
              expected: f.expected,
              firstSeenAt: now,
              lastSeenAt: now,
              provenance: "fresh",
              state: "open",
            },
            pages: new Map(),
          };
          groups.set(key, g);
        }
        g.pages.set(u, clampComponentEvidenceForStream(f.payload));
      }
    }
  }

  const sorted = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    const h = a.head;
    const o = b.head;
    return (
      cmp(h.ruleId, o.ruleId) ||
      cmp(h.checkName, o.checkName) ||
      cmp(h.locator, o.locator) ||
      cmp(h.fingerprint, o.fingerprint) ||
      cmp(ka, kb)
    );
  });

  const out: GroupedStreamFindingLine[] = [];
  for (const [, g] of sorted) {
    const urls = [...g.pages.keys()].sort(cmp);
    // Fixed overhead of the line without pages/payloads. Slack covers the digits of
    // part/parts, which are not known until the split is decided.
    const base =
      JSON.stringify({ ...g.head, payloads: [], pages: [], part: 0, parts: 0 }).length + 24;
    const partsOut: string[][] = [];
    let cur: string[] = [];
    let curSize = base;
    let seen = new Set<string | null>();
    for (const u of urls) {
      const p = g.pages.get(u) ?? null;
      // Index digits are bounded by the page count; use the widest for a safe bound.
      const entry = JSON.stringify([u, urls.length]).length + 1;
      const payloadCost = seen.has(p) ? 0 : JSON.stringify(p).length + 1;
      if (cur.length > 0 && curSize + entry + payloadCost > budget) {
        partsOut.push(cur);
        cur = [];
        curSize = base;
        seen = new Set();
      }
      // A single oversized page still gets its own part: never drop a page.
      curSize += entry + (seen.has(p) ? 0 : JSON.stringify(p).length + 1);
      seen.add(p);
      cur.push(u);
    }
    if (cur.length > 0) partsOut.push(cur);

    partsOut.forEach((chunk, part) => {
      const index = new Map<string | null, number>();
      const payloads: (string | null)[] = [];
      const pages: Array<[string, number]> = chunk.map((u) => {
        const p = g.pages.get(u) ?? null;
        let idx = index.get(p);
        if (idx === undefined) {
          idx = payloads.length;
          payloads.push(p);
          index.set(p, idx);
        }
        return [u, idx];
      });
      out.push({ ...g.head, payloads, pages, part, parts: partsOut.length });
    });
  }
  return out;
}

/**
 * Inverse of {@link buildGroupedStreamFindings} for one line: the per-page rows
 * {@link buildStreamFindings} would have produced for the pages it carries.
 */
export function expandGroupedStreamFinding(line: GroupedStreamFindingLine): StreamFindingLine[] {
  const { payloads, pages, part: _part, parts: _parts, ...head } = line;
  return pages.map(([normalizedUrl, idx]) => ({
    ...head,
    normalizedUrl,
    payload: payloads[idx] ?? null,
  }));
}

/**
 * `rows` is the total page count across lines, i.e. the page_findings row count the
 * server must reach. The finalize gate compares `count(*)` against `rows`, NOT
 * `lines`, so a dropped line or part leaves received < expected and fails closed.
 */
export function summarizeGroupedStream(lines: GroupedStreamFindingLine[]): {
  lines: number;
  rows: number;
} {
  let rows = 0;
  for (const l of lines) rows += l.pages.length;
  return { lines: lines.length, rows };
}
