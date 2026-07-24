// Cloud prefetch phase — the ONLY place the audit pipeline talks to the
// credit-gated cloud services. Groups enabled cloud rules by service,
// estimates spend, applies the per-audit cap + TTY confirmation, then runs
// chunked batch calls and stamps every (service, key) with a result envelope.
// The store is threaded per-run onto `ctx.cloudResults`; rules read it
// synchronously via `readCloudResult(ctx.cloudResults, …)`.
//
// NEVER throws: every failure mode (logged out, declined confirm, 402, 5xx,
// cap reached) degrades to `skipped` envelopes with a reason. A failed or
// skipped prefetch must not fail the audit.

import {
  CloudClientError,
  type CloudServicesClient,
  type CreditsResponse,
} from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import {
  computeCost,
  type ArchiveIndexingRequest,
  type BlocklistCheckRequest,
  type CloudPagePayload,
  type CloudServiceId,
  type ContentGapsRequest,
  type CreditFeature,
  type KeywordGapsRequest,
  type RenderResultItem,
  type RenderResultResponse,
  SERVICE_LIMITS,
  type SiteMetadata,
  type SiteMetadataPagePayload,
} from "@squirrelscan/core-contracts";
import {
  CLOUD_SITE_KEY,
  type CloudResultEnvelope,
  type CloudResultStore,
  type CloudSkipReason,
  type RuleCloudSpec,
} from "@squirrelscan/rules";
import { mapWithConcurrency } from "@squirrelscan/utils";

import { isRenderBlocked } from "./cloud-fetcher";

/**
 * Services the prefetch knows how to call. Others skip `not-prefetched`.
 * Exported for the coverage invariant test: every rule's cloud service must be
 * here, in UNWIRED_CLOUD_SERVICES (rules pkg), or on a dedicated non-prefetch
 * path (dead-links via the external-links bulk checker).
 */
export const SUPPORTED_SERVICES: ReadonlySet<CloudServiceId> = new Set([
  "ai-parse",
  "authority-signals",
  "site-metadata",
  "blocklist-check",
  "keyword-gaps",
  "content-gaps",
  "archive-indexing",
  "render",
]);

/** Stage-0 site-metadata service id — resolved FIRST, gates everything else. */
const SITE_METADATA_SERVICE: CloudServiceId = "site-metadata";

/**
 * Per-service request payloads for the site-unit services. Built by the CLI
 * glue from crawl artifacts + config. A site-unit service with no payload here
 * skips `not-prefetched`.
 */
export interface CloudSitePayloads {
  "blocklist-check"?: Omit<BlocklistCheckRequest, "auditId">;
  "keyword-gaps"?: Omit<KeywordGapsRequest, "auditId">;
  "content-gaps"?: Omit<ContentGapsRequest, "auditId">;
  "archive-indexing"?: Omit<ArchiveIndexingRequest, "auditId">;
}

export interface CloudPrefetchInput {
  /** Null = logged out → every service skips `not-authenticated`. */
  client: CloudServicesClient | null;
  config: CloudConfig;
  /** Enabled rules carrying a `cloud` spec (already pattern-filtered). */
  rules: Array<{ id: string; cloud: RuleCloudSpec }>;
  /** Slim page payloads (textExcerpt pre-capped by the caller). */
  pages: CloudPagePayload[];
  /** Site base URL — its apex/host is the Stage-0 `site-metadata` cache key. */
  siteUrl: string;
  /** Payloads for the site-unit services (blocklists, gaps). */
  sitePayloads?: CloudSitePayloads;
  /**
   * Sampled per-page signals for the Stage-0 `site-metadata` call (home first).
   * Built by the CLI glue from crawl artifacts. Absent → site-metadata is
   * skipped `not-prefetched` (no charge, no gating — degrades to today).
   */
  metadataPages?: SiteMetadataPagePayload[];
  /**
   * Stage-1 gating policy (CLI-owned; engine stays policy-free). Consulted only
   * when Stage-0 resolves metadata: a service for which `gate` returns false is
   * removed from the plan BEFORE `applyCap`, skipping it `not-applicable` and
   * freeing its budget for the rest. Absent → no gating.
   */
  gate?: (meta: SiteMetadata, service: CloudServiceId) => boolean;
  /** Unique per audit run — scopes server idempotency keys. */
  auditId: string;
  /**
   * True only when the crawl rendered EVERY page (render strategy "all"). The
   * `render` service diffs raw vs rendered content (ax/content-without-js), which
   * is wholly self-identical when every page was rendered — so render is skipped
   * `not-applicable` (no charge, no re-render). Absent/false = raw or HTTP-first
   * ("auto") crawl → render runs; the rule's per-page `page.rendered` guard then
   * skips only the individual pages the crawl did render (#673).
   */
  crawlRendered?: boolean;
  /**
   * URLs the crawl ALREADY browser-rendered (per-page provenance from the crawl
   * `fetcherId`). The `render` service submits only pages NOT in this set —
   * an already-rendered page is self-identical (raw==rendered), so paying to
   * re-render it is waste the rule discards. Empty/absent → submit all (#673/#964).
   * Keys must match `pages[].url`.
   */
  renderedPageUrls?: ReadonlySet<string>;
  /**
   * TTY confirmation when the estimate exceeds `confirm_threshold`.
   * Absent (non-TTY / --yes) → proceed without asking.
   */
  confirm?: (estimatedCredits: number, balance: number) => Promise<boolean>;
  onProgress?: (message: string) => void;
}

export interface CloudSpendLine {
  service: CloudServiceId;
  feature: CreditFeature;
  /** Units actually submitted (pages, or 1 for site-scope). */
  units: number;
  /** Credits spent on successful calls (server-debited). */
  credits: number;
}

/**
 * A failed cloud service call (one record per service that lost ≥1 call).
 * Lets the CLI surface partial coverage instead of silently showing fewer
 * results — a failed batch is uncharged AND unreported otherwise.
 */
export interface CloudServiceFailure {
  service: CloudServiceId;
  /** Units lost to failed calls (pages, or 1 for site-scope). */
  failedUnits: number;
  /** Units attempted for this service this run (after the credit cap). */
  attemptedUnits: number;
  /** Failed batch calls (1 for site-scope services). */
  failedBatches: number;
  reason: CloudSkipReason;
  /** Short operator-facing cause, e.g. "payload too large", "service error (502)". */
  detail: string;
}

export interface CloudPrefetchResult {
  store: CloudResultStore;
  spend: CloudSpendLine[];
  totalSpent: number;
  /** Per-service call failures — empty when every attempted call succeeded. */
  failures: CloudServiceFailure[];
  /**
   * ESTIMATED balance after the run: preflight balance minus client-side
   * spend. Concurrent usage by other sessions is not reflected — render with
   * a `~` qualifier; `getBalance()` is the authoritative read.
   */
  balanceAfter: number | null;
  /**
   * Resolved Stage-0 site profile, or null when it couldn't be resolved
   * (offline / logged out / no credits / cap reached / service error). Null
   * means NO Stage-1 gating happened — the run degrades to today's behavior.
   */
  siteMetadata: SiteMetadata | null;
}

interface ServicePlan {
  service: CloudServiceId;
  feature: CreditFeature;
  unit: RuleCloudSpec["unit"];
  /** Pages included under the cap (empty for site-scope). */
  pages: CloudPagePayload[];
  /** Pages excluded by the per-audit cap. */
  capped: CloudPagePayload[];
  /** Whether the whole service was excluded by the cap. */
  fullyCapped: boolean;
  estimate: number;
}

/** Result of one page-batch call, merged into the service totals in batch order. */
interface BatchOutcome {
  entries: Array<[string, CloudResultEnvelope]>;
  units: number;
  credits: number;
  failedUnits: number;
  failedBatches: number;
  failure: { reason: CloudSkipReason; detail: string } | null;
}

function emptyResult(
  store: CloudResultStore,
  siteMetadata: SiteMetadata | null = null,
): CloudPrefetchResult {
  return { store, spend: [], totalSpent: 0, failures: [], balanceAfter: null, siteMetadata };
}

/** Stamp a skip envelope for every key a service would have produced. */
function skipService(
  store: CloudResultStore,
  service: CloudServiceId,
  unit: RuleCloudSpec["unit"],
  pages: CloudPagePayload[],
  reason: CloudSkipReason,
): void {
  const byKey = store.get(service) ?? new Map<string, CloudResultEnvelope>();
  if (unit === "site") {
    if (!byKey.has(CLOUD_SITE_KEY))
      byKey.set(CLOUD_SITE_KEY, { status: "skipped", skipReason: reason });
  } else {
    for (const p of pages) {
      if (!byKey.has(p.url)) byKey.set(p.url, { status: "skipped", skipReason: reason });
    }
  }
  store.set(service, byKey);
}

/**
 * Byte budget per batch request body. The API rejects bodies over 5MB (413);
 * stay safely under it — request envelope + JSON overhead included.
 */
export const BATCH_BYTE_BUDGET = 4 * 1024 * 1024;

/** Page-batches dispatched concurrently per page-unit service — small to stay polite to the shared cloud API. */
export const BATCH_CONCURRENCY = 4;

/**
 * Split pages into batches bounded by BOTH a page count and a serialized byte
 * budget. The count cap matches the server's batch limit; the byte budget
 * keeps each request body under the API's 5MB body limit (a 20-page batch of
 * huge rendered pages can otherwise 413 and lose the whole batch). A single
 * page over the budget still ships alone — a server reject then loses only
 * that page, not its neighbours.
 */
export function chunkPagesBySize(
  pages: CloudPagePayload[],
  maxCount: number,
  maxBytes: number = BATCH_BYTE_BUDGET,
): CloudPagePayload[][] {
  const encoder = new TextEncoder();
  const out: CloudPagePayload[][] = [];
  let current: CloudPagePayload[] = [];
  let currentBytes = 0;
  for (const page of pages) {
    // +1 for the array comma separator; envelope overhead is covered by the
    // budget headroom (5MB limit vs 4MB budget).
    const size = encoder.encode(JSON.stringify(page)).length + 1;
    if (current.length > 0 && (current.length >= maxCount || currentBytes + size > maxBytes)) {
      out.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(page);
    currentBytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Unique (service → spec) map from the enabled cloud rules, stable order. */
function planServices(rules: CloudPrefetchInput["rules"]): Map<CloudServiceId, RuleCloudSpec> {
  const specs = new Map<CloudServiceId, RuleCloudSpec>();
  for (const r of [...rules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!specs.has(r.cloud.service)) specs.set(r.cloud.service, r.cloud);
  }
  return specs;
}

/**
 * Apply `max_credits_per_audit` deterministically: services in sorted-id order,
 * page-unit services truncate their page list to what fits the remaining
 * budget, everything past the cap is marked `credit-cap-reached`.
 */
function applyCap(
  specs: Map<CloudServiceId, RuleCloudSpec>,
  pages: CloudPagePayload[],
  cap: number,
): ServicePlan[] {
  const plans: ServicePlan[] = [];
  let remaining = cap === 0 ? Number.POSITIVE_INFINITY : cap;

  const ordered = [...specs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [service, spec] of ordered) {
    if (spec.unit === "site") {
      const cost = computeCost(spec.creditFeature, 1);
      if (cost <= remaining) {
        plans.push({
          service,
          feature: spec.creditFeature,
          unit: spec.unit,
          pages: [],
          capped: [],
          fullyCapped: false,
          estimate: cost,
        });
        remaining -= cost;
      } else {
        plans.push({
          service,
          feature: spec.creditFeature,
          unit: spec.unit,
          pages: [],
          capped: [],
          fullyCapped: true,
          estimate: 0,
        });
      }
      continue;
    }

    // Page-unit: find the largest page count whose cost fits the budget.
    let fit = pages.length;
    while (fit > 0 && computeCost(spec.creditFeature, fit) > remaining) fit--;
    const included = pages.slice(0, fit);
    const capped = pages.slice(fit);
    const estimate = fit > 0 ? computeCost(spec.creditFeature, fit) : 0;
    plans.push({
      service,
      feature: spec.creditFeature,
      unit: spec.unit,
      pages: included,
      capped,
      fullyCapped: fit === 0 && pages.length > 0,
      estimate,
    });
    remaining -= estimate;
  }
  return plans;
}

/** Map a client error to the skip reason rules surface. */
function reasonForError(error: unknown): CloudSkipReason {
  if (error instanceof CloudClientError) {
    if (error.code === "insufficient_credits") return "insufficient-credits";
    if (error.code === "not_authenticated") return "not-authenticated";
    if (error.code === "payload_too_large") return "payload-too-large";
  }
  // invalid_request / duplicate_request / network / 5xx — nothing usable came
  // back for these pages this run.
  return "service-unavailable";
}

/**
 * Latch the first error that should abort the WHOLE prefetch, not just skip one
 * call: out of credits (402), or a cloud run reaped/failed mid-prefetch (#475).
 * Both doom every remaining `/v1/services/*` call the same way (the run-guard
 * blocks a dead run's debits), so bail fast. Returns the stop marker, or null to
 * keep going. Used via `stop ??= latchFatal(...)` at each service/batch catch.
 */
function latchFatal(
  error: unknown,
  reason: CloudSkipReason,
): { reason: CloudSkipReason; detail: string } | null {
  const fatal =
    reason === "insufficient-credits" ||
    (error instanceof CloudClientError && error.code === "run_inactive");
  return fatal ? { reason, detail: describeError(error) } : null;
}

/** Short operator-facing cause for a failed call, shown in the CLI warning. */
function describeError(error: unknown): string {
  if (error instanceof CloudClientError) {
    switch (error.code) {
      case "payload_too_large":
        return "payload too large";
      case "insufficient_credits":
        return "out of credits";
      case "not_authenticated":
        return "not authenticated";
      case "invalid_request":
        return `request rejected (${error.status})`;
      case "duplicate_request":
        return "duplicate request";
      case "run_inactive":
        return "run no longer active";
      case "service_unavailable":
        return error.status > 0 ? `service error (${error.status})` : "service error";
      case "network_error":
        return "network error";
    }
  }
  return error instanceof Error ? error.message : "unknown error";
}

/** Bound the prefetch wait on a render job — a browser render is slow, but must not wedge the phase. */
export const RENDER_POLL_TIMEOUT_MS = 90_000;
export const RENDER_POLL_INTERVAL_MS = 1_500;

/**
 * Poll a submitted render job to terminal state. NON-throwing: a transport error or a timeout returns
 * whatever results exist (usually none) so the caller stamps skip envelopes — the submit already charged
 * (charge-on-submit), so we never re-submit and never lose the debit accounting to a poll fault.
 */
async function pollRenderResults(
  client: CloudServicesClient,
  jobId: string,
): Promise<RenderResultItem[]> {
  const deadline = Date.now() + RENDER_POLL_TIMEOUT_MS;
  for (;;) {
    let res: RenderResultResponse | null = null;
    try {
      res = await client.renderResult(jobId);
    } catch {
      /* transient poll error — retry until the deadline */
    }
    if (res && (res.status === "done" || res.status === "error")) return res.results ?? [];
    if (Date.now() >= deadline) return res?.results ?? [];
    await new Promise<void>((r) => setTimeout(r, RENDER_POLL_INTERVAL_MS));
  }
}

/**
 * Fetch one page-unit batch, keyed by url. `render` is job-based (submit → poll); the single-call
 * services return their results directly. Submit failures throw (the caller's catch skips + records the
 * failure, uncharged); a render SUBMIT that succeeds is charge-on-submit, so the poll is non-throwing.
 */
async function fetchPageBatch(
  client: CloudServicesClient,
  service: CloudServiceId,
  batch: CloudPagePayload[],
  auditId: string,
): Promise<Map<string, unknown>> {
  if (service === "render") {
    // Charge-on-submit + non-idempotent (client pins maxAttempts:1 → no double-charge on retry). A submit
    // that THROWS (402 / 5xx / pre-ack network error) did not charge → the caller's catch skips it uncharged,
    // which is correct for those cases. The one unrecoverable gap is a submit the server debited but whose
    // 202/jobId was lost: client-side spend then under-reports. That's inherent to a non-idempotent charge
    // and matches the single-call services' best-effort estimate — the server ledger stays authoritative.
    const job = await client.render({ urls: batch.map((p) => p.url) });
    const results = await pollRenderResults(client, job.jobId);
    // A render that came back a bot-wall/challenge (401/403/429/503 or an interstitial served as HTML) is
    // NOT usable content — drop it so the page maps to a skip rather than feeding a challenge page into the
    // rule's word-count diff (spurious "JS-only content"). The live crawl renderer retries these via a
    // non-browser egress (#490); prefetch has no fallback, so a blocked page is simply unavailable here.
    return new Map(results.filter((r) => !isRenderBlocked(r)).map((r) => [r.url, r]));
  }
  const req = { auditId, pages: batch };
  const res = service === "ai-parse" ? await client.aiParse(req) : await client.authoritySignals(req);
  return new Map(res.results.map((r) => [r.url, r]));
}

export async function prefetchCloudData(input: CloudPrefetchInput): Promise<CloudPrefetchResult> {
  const store: CloudResultStore = new Map();
  const specs = planServices(input.rules);
  if (specs.size === 0) return emptyResult(store);

  const skipAll = (reason: CloudSkipReason) => {
    for (const [service, spec] of specs)
      skipService(store, service, spec.unit, input.pages, reason);
    return emptyResult(store);
  };

  if (!input.config.enabled) return skipAll("not-prefetched");
  if (!input.client) return skipAll("not-authenticated");
  const client = input.client;

  // Unsupported services (future waves) skip cleanly and drop out of the plan.
  for (const [service, spec] of [...specs]) {
    if (!SUPPORTED_SERVICES.has(service)) {
      skipService(store, service, spec.unit, input.pages, "not-prefetched");
      specs.delete(service);
    }
  }

  // Render diffs raw-vs-rendered content, meaningless when EVERY page was rendered (raw==rendered). Skip it
  // — no charge, no self-identical re-render — so a fully-rendered crawl doesn't pay to render every page
  // for a comparison the rule discards anyway (#673). The rule then reads `not-applicable` and skips visibly.
  // Only set for render strategy "all"; an "auto" (HTTP-first) crawl leaves most pages raw and runs render,
  // relying on the rule's per-page `page.rendered` guard to skip the individual pages it did render (#964).
  if (input.crawlRendered) {
    const spec = specs.get("render");
    if (spec) {
      skipService(store, "render", spec.unit, input.pages, "not-applicable");
      specs.delete("render");
    }
  }
  if (specs.size === 0) return emptyResult(store);

  // Preflight: balance + connectivity in one call.
  let preflight: CreditsResponse;
  try {
    preflight = await client.getBalance();
  } catch (error) {
    return skipAll(reasonForError(error));
  }

  const spend: CloudSpendLine[] = [];
  const failures: CloudServiceFailure[] = [];
  let totalSpent = 0;
  // The first fatal error (out of credits, or a run reaped/failed mid-prefetch
  // #475) stops all remaining spend attempts and marks the rest with its reason.
  let stop: { reason: CloudSkipReason; detail: string } | null = null;

  // The per-audit cap is consumed by Stage 0 first, then the remainder seeds
  // `applyCap` for the downstream services. 0 = unlimited.
  let remainingCap =
    input.config.max_credits_per_audit === 0
      ? Number.POSITIVE_INFINITY
      : input.config.max_credits_per_audit;

  // ── Spend confirmation (BEFORE any charge, incl. Stage 0) ──────────
  // The TTY confirm gate must run BEFORE Stage-0 charges AND its estimate must
  // include Stage-0's cost — otherwise a 12-credit metadata charge could slip
  // past a low confirm_threshold without prompting. We confirm a conservative
  // UPPER BOUND: assume Stage-0 is NOT a cache hit (full cost0) and that NO
  // Stage-1 service is gated out (ungated estimate). Cache hits + gating only
  // ever REDUCE actual spend below this, so actual spend ≤ what was confirmed.
  if (input.confirm) {
    const metaCost =
      specs.has(SITE_METADATA_SERVICE) &&
      input.metadataPages &&
      input.metadataPages.length > 0 &&
      computeCost("site_metadata", 1) <= remainingCap
        ? computeCost("site_metadata", 1)
        : 0;
    const stage1Specs = new Map(specs);
    stage1Specs.delete(SITE_METADATA_SERVICE);
    const stage1Cap =
      remainingCap === Number.POSITIVE_INFINITY ? 0 : Math.max(0, remainingCap - metaCost);
    const upperEstimate =
      metaCost +
      applyCap(stage1Specs, input.pages, stage1Cap).reduce((sum, p) => sum + p.estimate, 0);
    if (upperEstimate > input.config.confirm_threshold) {
      const proceed = await input.confirm(upperEstimate, preflight.balance.total);
      if (!proceed) {
        for (const [service, spec] of specs) {
          skipService(
            store,
            service,
            spec.unit,
            spec.unit === "site" ? [] : input.pages,
            "not-prefetched",
          );
        }
        return {
          store,
          spend,
          totalSpent,
          failures,
          balanceAfter: preflight.balance.total,
          siteMetadata: null,
        };
      }
    }
  }

  // ── STAGE 0: resolve site metadata FIRST (gates everything downstream) ──
  // Charged from the cap before any other service. On any miss (cap / error /
  // absent payload) siteMetadata stays null → no Stage-1 gating, run as today.
  let siteMetadata: SiteMetadata | null = null;
  if (specs.has(SITE_METADATA_SERVICE)) {
    const cost0 = computeCost("site_metadata", 1);
    const metaPages = input.metadataPages;
    if (!metaPages || metaPages.length === 0) {
      // Nothing to extract from — skip without charging.
      skipService(store, SITE_METADATA_SERVICE, "site", [], "not-prefetched");
    } else if (cost0 > remainingCap) {
      skipService(store, SITE_METADATA_SERVICE, "site", [], "credit-cap-reached");
    } else {
      input.onProgress?.(`cloud: ${SITE_METADATA_SERVICE}`);
      try {
        const data = await client.siteMetadata({
          auditId: input.auditId,
          url: input.siteUrl,
          pages: metaPages,
        });
        // A fresh (<30d) server-side cache hit is served at 0 credits — never
        // bill the cap or report spend for it, else a finite cap can be falsely
        // exhausted and downstream services wrongly skipped.
        const credits = data.cached ? 0 : cost0;
        const byKey = store.get(SITE_METADATA_SERVICE) ?? new Map<string, CloudResultEnvelope>();
        byKey.set(CLOUD_SITE_KEY, { status: "ok", data, creditsSpent: credits });
        store.set(SITE_METADATA_SERVICE, byKey);
        siteMetadata = data;
        if (credits > 0) {
          spend.push({
            service: SITE_METADATA_SERVICE,
            feature: "site_metadata",
            units: 1,
            credits,
          });
          totalSpent += credits;
          remainingCap -= credits;
        }
      } catch (error) {
        const reason = reasonForError(error);
        stop ??= latchFatal(error, reason);
        skipService(store, SITE_METADATA_SERVICE, "site", [], reason);
        failures.push({
          service: SITE_METADATA_SERVICE,
          failedUnits: 1,
          attemptedUnits: 1,
          failedBatches: 1,
          reason,
          detail: describeError(error),
        });
        input.onProgress?.(`cloud: ${SITE_METADATA_SERVICE} failed (${describeError(error)})`);
      }
    }
    specs.delete(SITE_METADATA_SERVICE);
  }

  // ── STAGE 1: gate downstream services by the resolved metadata ──
  // A gated-out service is removed BEFORE applyCap, so it never charges and its
  // budget frees up for the rest. Only runs when metadata actually resolved.
  if (siteMetadata && input.gate) {
    for (const [service, spec] of [...specs]) {
      if (!input.gate(siteMetadata, service)) {
        skipService(store, service, spec.unit, input.pages, "not-applicable");
        specs.delete(service);
      }
    }
  }

  // The per-audit cap is exhausted exactly when Stage-0 (or its absence with a
  // finite cap) leaves nothing for the rest. `remainingCap === 0` here always
  // means "finite cap, fully consumed" — Stage-0 only spends from a cap that
  // fit it (cost0 ≤ remainingCap), so an unlimited cap stays Infinity. Mark every
  // remaining service `credit-cap-reached` instead of calling applyCap(0), which
  // would (mis)read 0 as "unlimited" and let downstream services overspend.
  if (specs.size === 0 || remainingCap === 0) {
    for (const [service, spec] of specs) {
      skipService(store, service, spec.unit, input.pages, "credit-cap-reached");
    }
    return {
      store,
      spend,
      totalSpent,
      failures,
      balanceAfter: Math.max(0, preflight.balance.total - totalSpent),
      siteMetadata,
    };
  }

  // Seed applyCap with the post-Stage-0 remainder. Infinity (unlimited config
  // cap) maps to applyCap's sentinel 0; a finite remainder passes through as-is
  // (the `remainingCap === 0` exhaustion case is already handled above).
  const plans = applyCap(
    specs,
    input.pages,
    remainingCap === Number.POSITIVE_INFINITY ? 0 : remainingCap,
  );
  // Stamp cap exclusions up front so they read `credit-cap-reached`, not a
  // generic miss, regardless of what happens to the rest of the run.
  for (const plan of plans) {
    if (plan.fullyCapped)
      skipService(
        store,
        plan.service,
        plan.unit,
        plan.unit === "site" ? [] : input.pages,
        "credit-cap-reached",
      );
    else if (plan.capped.length > 0)
      skipService(store, plan.service, plan.unit, plan.capped, "credit-cap-reached");
  }

  // NO zero-estimate short-circuit (pricing v10): folded services estimate 0
  // but MUST still dispatch — the audit base the user already paid covers them.
  // 0-cost plans write ok envelopes with creditsSpent 0 and push no spend line.

  // Spend confirmation already happened up front (before Stage 0), covering the
  // worst-case total including the metadata cost — no second prompt here.

  for (const plan of plans) {
    if (plan.fullyCapped) continue;
    if (plan.unit !== "site" && plan.pages.length === 0) continue;
    const line: CloudSpendLine = {
      service: plan.service,
      feature: plan.feature,
      units: 0,
      credits: 0,
    };

    if (stop) {
      skipService(store, plan.service, plan.unit, plan.pages, stop.reason);
      continue;
    }

    if (plan.unit === "site") {
      // Dispatch the site-unit service. Each needs a caller-built payload;
      // absent payload → not-prefetched (no charge).
      const callSite = (): Promise<unknown> | null => {
        const auditId = input.auditId;
        switch (plan.service) {
          case "blocklist-check": {
            const p = input.sitePayloads?.["blocklist-check"];
            return p ? client.blocklistCheck({ auditId, ...p }) : null;
          }
          case "keyword-gaps": {
            const p = input.sitePayloads?.["keyword-gaps"];
            return p ? client.keywordGaps({ auditId, ...p }) : null;
          }
          case "content-gaps": {
            const p = input.sitePayloads?.["content-gaps"];
            return p ? client.contentGaps({ auditId, ...p }) : null;
          }
          case "archive-indexing": {
            const p = input.sitePayloads?.["archive-indexing"];
            return p ? client.archiveIndexing({ auditId, ...p }) : null;
          }
          default:
            return null;
        }
      };

      const call = callSite();
      if (!call) {
        skipService(store, plan.service, plan.unit, [], "not-prefetched");
        continue;
      }

      input.onProgress?.(`cloud: ${plan.service}`);
      try {
        const data = await call;
        const byKey = store.get(plan.service) ?? new Map<string, CloudResultEnvelope>();
        // Cache-aware services (archive-indexing) return `cached: true` on a
        // 0-credit server cache hit — mirror that in the spend accounting
        // (same treatment as site-metadata's Stage-0 call).
        const cached = (data as { cached?: boolean } | null)?.cached === true;
        const cost = cached ? 0 : computeCost(plan.feature, 1);
        byKey.set(CLOUD_SITE_KEY, { status: "ok", data, creditsSpent: cost });
        store.set(plan.service, byKey);
        line.units = 1;
        line.credits = cost;
      } catch (error) {
        const reason = reasonForError(error);
        stop ??= latchFatal(error, reason);
        skipService(store, plan.service, plan.unit, [], reason);
        failures.push({
          service: plan.service,
          failedUnits: 1,
          attemptedUnits: 1,
          failedBatches: 1,
          reason,
          detail: describeError(error),
        });
        input.onProgress?.(`cloud: ${plan.service} failed (${describeError(error)})`);
      }
      if (line.credits > 0) {
        spend.push(line);
        totalSpent += line.credits;
      }
      continue;
    }

    // Per-page render gate (#673/#964): render only the pages the crawl left RAW. On an "auto" (HTTP-first
    // hybrid) crawl the whole-run gate is off, but the hybrid still upgraded the CSR shells to a real render
    // — those pages are self-identical (raw==rendered), so re-rendering them wastes charge-on-submit credits
    // on a diff the rule's per-page `page.rendered` guard discards anyway. Skip them `not-applicable` and
    // submit only the raw pages. Non-render services are unaffected (they want every page).
    let pagesToFetch = plan.pages;
    if (plan.service === "render" && input.renderedPageUrls && input.renderedPageUrls.size > 0) {
      const rendered = input.renderedPageUrls;
      const alreadyRendered = plan.pages.filter((p) => rendered.has(p.url));
      if (alreadyRendered.length > 0) {
        skipService(store, plan.service, plan.unit, alreadyRendered, "not-applicable");
        pagesToFetch = plan.pages.filter((p) => !rendered.has(p.url));
      }
    }
    if (pagesToFetch.length === 0) continue; // all render pages already rendered (page-unit only here)

    // Page-unit service: chunked batches (count + byte budget — an oversized
    // body 413s the WHOLE batch); a failed chunk only loses that chunk. render has a smaller
    // server-side per-job url cap than the generic batch_size, so clamp it (mirrors cloud-fetcher).
    const maxBatch =
      plan.service === "render"
        ? Math.min(input.config.batch_size, SERVICE_LIMITS.renderBatchUrls)
        : input.config.batch_size;
    const batches = chunkPagesBySize(pagesToFetch, maxBatch);
    const byKey = store.get(plan.service) ?? new Map<string, CloudResultEnvelope>();
    const perPage = computeCost(plan.feature, 1);

    // Independent batches overlap (bounded); `stop` short-circuits batches not yet dispatched.
    // onProgress may fire out of batch order under concurrency — it is display-only.
    const runBatch = async (batch: CloudPagePayload[], i: number): Promise<BatchOutcome> => {
      const s = stop; // capture for closure narrowing
      if (s) {
        return {
          entries: batch.map((p) => [p.url, { status: "skipped", skipReason: s.reason }]),
          units: 0,
          credits: 0,
          failedUnits: batch.length,
          failedBatches: 1,
          failure: { reason: s.reason, detail: s.detail },
        };
      }
      input.onProgress?.(`cloud: ${plan.service} ${i + 1}/${batches.length}`);
      try {
        const byUrl = await fetchPageBatch(client, plan.service, batch, input.auditId);
        // Pages the server omitted from results are a partial provider failure — skipped, not refunded.
        // (For render, charge-on-submit already billed the batch, so a missing page is skipped-not-refunded
        // exactly like the single-call services — the batch credits below still cover every submitted url.)
        const entries = batch.map<[string, CloudResultEnvelope]>((p) => {
          const r = byUrl.get(p.url);
          return [
            p.url,
            r
              ? { status: "ok", data: r, creditsSpent: perPage }
              : { status: "skipped", skipReason: "service-unavailable" },
          ];
        });
        return {
          entries,
          units: batch.length,
          credits: computeCost(plan.feature, batch.length),
          failedUnits: 0,
          failedBatches: 0,
          failure: null,
        };
      } catch (error) {
        const reason = reasonForError(error);
        stop ??= latchFatal(error, reason);
        input.onProgress?.(
          `cloud: ${plan.service} ${i + 1}/${batches.length} failed (${describeError(error)})`,
        );
        return {
          entries: batch.map((p) => [p.url, { status: "skipped", skipReason: reason }]),
          units: 0,
          credits: 0,
          failedUnits: batch.length,
          failedBatches: 1,
          failure: { reason, detail: describeError(error) },
        };
      }
    };

    const outcomes = await mapWithConcurrency(
      batches.map((batch, i) => () => runBatch(batch, i)),
      BATCH_CONCURRENCY,
    );

    // Merge in batch order — byte-identical to serial accumulation.
    let failedUnits = 0;
    let failedBatches = 0;
    let failure: { reason: CloudSkipReason; detail: string } | null = null;
    for (const o of outcomes) {
      for (const [url, env] of o.entries) byKey.set(url, env);
      line.units += o.units;
      line.credits += o.credits;
      failedUnits += o.failedUnits;
      failedBatches += o.failedBatches;
      failure ??= o.failure;
    }
    store.set(plan.service, byKey);
    if (failure) {
      failures.push({
        service: plan.service,
        failedUnits,
        attemptedUnits: plan.pages.length,
        failedBatches,
        ...failure,
      });
    }
    if (line.credits > 0) {
      spend.push(line);
      totalSpent += line.credits;
    }
  }

  return {
    store,
    spend,
    totalSpent,
    failures,
    balanceAfter: Math.max(0, preflight.balance.total - totalSpent),
    siteMetadata,
  };
}
