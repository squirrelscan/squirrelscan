import type { CoverageMode } from "./index";

// ── Audit Runtime ───────────────────────────────────────────────
// Source of truth for the cloud-audit BASE timeout budgets enforced by
// worker-agent (runtime cap in entry.ts, container hard-kill in index.ts,
// crawl-phase soft-stop in component-runtime.ts). Page budgets past the presets
// scale these linearly, capped at 1h — see worker-agent timeouts.ts, which also
// derives the container hard timeout (runtime + 180s SIGKILL margin). Invariants:
//   hardTimeout ≥ runtime + hardTimeoutMarginMs   (mark-failed lands before SIGKILL)
//   crawlPhase  <  runtime                         (partial pages still audit+publish)
// quick raised 170s→240s / 90s→130s (#578): ~20+ page Wix sites finished at
// ~174s on a cold cache and tipped the old 170s cap; 240s gives headroom without
// unbounding the budget.
export const AUDIT_RUNTIME = {
  timeoutByCoverageMs: {
    quick: 240_000,
    surface: 900_000,
    full: 2_400_000,
  } satisfies Record<CoverageMode, number>,
  crawlPhaseTimeoutByCoverageMs: {
    quick: 130_000,
    surface: 540_000,
    full: 1_800_000,
  } satisfies Record<CoverageMode, number>,
  // Minimum gap between hardTimeout and runtime so the catch block's mark-failed
  // callback (retries + event flush) completes before the container is killed.
  // 120s is deliberately tight-but-sufficient: the worst-case callback budget
  // (up to 10s flush + 8 mark-failed attempts × 5s + backoff) is ~60–65s.
  hardTimeoutMarginMs: 120_000,
  // Page-scaled runtime cap scalars (#1058). Single source for the scaling both
  // worker-agent (timeouts.ts) and the API reaper (run-staleness.ts) apply to
  // the per-coverage BASE budgets above — the reaper can't cross-import
  // worker-agent, so before this these were duplicated literals; drift between
  // the two would mean the reaper reaps a run before/after the container is
  // actually guaranteed dead.
  //   full budget ÷ its 500-page preset — page-count scaling for oversized runs.
  runPerPageMs: 4_800,
  // 1h ceiling so a wedged crawl can't pin a container indefinitely.
  maxRunTimeoutMs: 3_600_000,
  // Gap the DO leaves between the runtime cap and container SIGKILL. Wider
  // than hardTimeoutMarginMs (the enforced minimum above) so an env override
  // can still raise the runtime a little.
  sigkillMarginMs: 180_000,
  rulesPhaseTimeoutMs: 1_800_000,
  // Must exceed the worst-case container hard timeout (1h run cap + 180s margin,
  // see worker-agent timeouts.ts) or the reaper kills legitimate large runs.
  staleRunThresholdMs: 75 * 60 * 1000,
  pendingTimeoutMs: 5 * 60 * 1000,
  // Post-crawl cloud-feature (smart-audit) bounds (#1008). The container's cloud
  // service calls (site-metadata / ai-parse / authority / editor-summary / …) are
  // best-effort enrichment proxied to the API's LLM/SEO providers; a hung provider
  // must degrade to "no enrichment", never eat the run's wall-clock budget:
  //   - cloudCallTimeoutMs: per-request hard timeout on the container's
  //     CloudServicesClient. The CLI default is 120s — half the quick run cap —
  //     so a single hung call (empirically site-metadata, which times out ~always:
  //     1 success / 3 days) can consume it. Quick clamps hard; surface/full keep
  //     the provider's ~90s ceiling since their budgets have the headroom.
  //   - cloudPrefetchBudgetMs: aggregate wall-clock for the multi-call Stage-0/1
  //     prefetch (site profile → gaps / authority / ai-parse …). Sequential calls
  //     compound past any per-call cap, so cap the whole phase; once spent, rules
  //     run without the enrichment (same graceful path as a prefetch failure).
  cloudCallTimeoutByCoverageMs: {
    quick: 40_000,
    surface: 90_000,
    full: 90_000,
  } satisfies Record<CoverageMode, number>,
  cloudPrefetchBudgetByCoverageMs: {
    quick: 45_000,
    surface: 300_000,
    full: 600_000,
  } satisfies Record<CoverageMode, number>,
  // #1214: per-stage wall-clock budget for each SINGLE-CALL post-crawl cloud
  // stage (tech-detect / editor-summary / domain-stats / threat-intel). Sized
  // ABOVE cloudCallTimeoutByCoverageMs so the client's per-request timeout fires
  // first (typed error → logged fallback); the deadline is the backstop for a
  // call whose timeout is defeated (run 01KXYKKYMM: wedged past every client
  // bound for 52min). On deadline the stage is abandoned: its report section is
  // omitted, the run continues. timeouts.test.ts guards the ordering invariant.
  cloudStageBudgetByCoverageMs: {
    quick: 50_000,
    surface: 105_000,
    full: 105_000,
  } satisfies Record<CoverageMode, number>,
} as const;

// ── Fix Runner ──────────────────────────────────────────────────
export const FIX_DEFAULTS = {
  timeoutMs: 3 * 60 * 60 * 1000,
  maxTurns: 1000,
  maxBudgetUsd: 100,
  maxIssueFanout: 25,
  hardTimeoutMarginMs: 5 * 60 * 1000,
} as const;

// ── Issue Agent ──────────────────────────────────────────────
export const ISSUE_DEFAULTS = {
  timeoutMs: 10 * 60 * 1000,
  maxTurns: 100,
  maxBudgetUsd: 5,
  hardTimeoutMarginMs: 5 * 60 * 1000,
} as const;

// ── Cloud Resource Checks ───────────────────────────────────────
export const CLOUD_RESOURCE_CHECK = {
  timeoutMs: 10_000,
  maxItems: 100,
  budgetMs: 45_000,
  // #1252: tarpit detection during asset fetch. A single check whose wall time
  // exceeds tarpitLatencyMs (or that aborts/errors) is a "strike" against its
  // host; tarpitStrikes consecutive strikes skip that host's REMAINING fetches
  // instead of waiting out the whole budget on an escalating-latency origin
  // (activera.com.au: 0.5s → 9.7s → 18s → 29s → 65s/page). A fast success
  // clears the streak, so a single slow asset never trips the skip.
  tarpitLatencyMs: 6_000,
  tarpitStrikes: 3,
} as const;

// ── Cloud Rules Phase (#1252) ───────────────────────────────────
// The cloud rules block is sync CPU over materialized DOMs. Without a
// cooperative MACROTASK yield the single-threaded loop starves every timer at
// once — the rules-phase deadline, the post-crawl backstop, AND the container's
// 30s liveness heartbeat (microtask `await`s between pages never return to the
// timers phase). So a healthy-but-slow rules phase was indistinguishable from a
// wedged container and the stale reaper killed it (the #1251 incident).
export const CLOUD_RULES = {
  // Yield to the event loop at least this often (ms) during the page-rule loop
  // so macrotask timers/heartbeats fire between pages. Tiny vs per-page cost.
  // This is what lets the rules-phase Effect.timeoutFail (and the container's
  // 30s liveness heartbeat) actually fire; without it sync CPU starves them.
  yieldEveryMs: 50,
  // Emit a rules progress event every N pages — resets the reaper and shows real
  // advancement, so "slow" is visibly distinct from "wedged" in the event feed.
  heartbeatEveryPages: 10,
} as const;

// ── Browser Queue (cloud rendering) ─────────────────────────────
export const BROWSER_QUEUE = {
  defaultTimeoutMs: 20_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 45_000,
} as const;

// ── Cloud Crawler ───────────────────────────────────────────────
export const CLOUD_CRAWLER = {
  defaultTimeoutMs: 12_000,
  minTimeoutMs: 3_000,
  maxTimeoutMs: 30_000,
} as const;

// ── Crawler Worker (DO) ─────────────────────────────────────────
export const CRAWLER_WORKER = {
  // Pages rendered concurrently per browser per consumer invocation. 3→4 (#992):
  // conservative bump for throughput; Browser Rendering session limits still
  // apply account-wide, so the pool caps total concurrency regardless.
  queueConcurrency: 4,
  batchDelayMs: 1_000,
  fallbackAlarmMs: 30_000,
  stuckThresholdMs: 5 * 60 * 1000,
  maxPageRetries: 3,
} as const;

// ── Callback / Retry Policies ───────────────────────────────────
export const CALLBACK_RETRY = {
  maxAttempts: 8,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
  requestTimeoutMs: 5_000,
  eventMaxAttempts: 3,
} as const;

export const RECONCILE_RETRY = {
  maxAttempts: 20,
  baseDelayMs: 1_000,
  requestTimeoutMs: 5_000,
} as const;

// ── API Pagination & Search ─────────────────────────────────────
export const API_PAGINATION = {
  defaultLimit: 50,
  maxLimit: 100,
  maxSearchLength: 200,
} as const;

// ── Scheduler ───────────────────────────────────────────────────
export const SCHEDULER = {
  defaultBatchSize: 20,
  lockDurationMs: 5 * 60 * 1000,
  pruneAgeDays: 90,
} as const;

// ── Report Limits ───────────────────────────────────────────────
export const REPORT_LIMITS = {
  // Sized for maxPages-page cloud reports; the schema array caps bound worst-case growth.
  maxPayloadBytes: 20 * 1024 * 1024,
  // Report page-count ceiling for the CLOUD crawl config + sitemap arrays
  // (planMaxPages, cloud/custom-crawl caps all track this). Decoupled from the
  // per-check pages cap below (#918): raising THIS would raise crawl cost.
  maxPages: 2000,
  // Max pages a single folded aggregate check may list (fold cap +
  // checkResultSchema.pages). Set to MAX_PAGES_CAP so a CLI audit crawling up to
  // the 5000-page ceiling keeps EVERY affected page in the published report
  // instead of silently clipping past 2000 (#918). Larger than maxPages on
  // purpose — the fold reduces N per-page checks to ONE aggregate, and the
  // publish payload guard degrades to a signalled clip before the 20MB gate.
  maxPagesPerCheck: 5000,
  maxChecksPerPage: 200,
  maxItemsPerCheck: 1000,
  maxUrlLength: 2048,
  maxShortString: 255,
  maxMediumString: 1000,
  maxLongString: 5000,
  // A single finding's opaque JSON `payload` ({items,details,pages}) column cap
  // (#1023 chunk ingest + page_findings store). Larger than maxLongString: one
  // finding can legitimately carry a few maxMediumString ids/labels + maxUrlLength
  // source pages (~6KB) — 16KB fits that with headroom while still bounding a
  // pathological blob. The ingest DROPS a payload over this (never truncates JSON).
  maxFindingPayload: 16 * 1024,
  // meta description gets extra headroom over maxMediumString (search engines
  // truncate around 155-320 chars for display, but some CMSes stuff far more
  // into the tag) — mirrors pageAuditSchema.meta.description in
  // apps/api/src/schemas/audit-report.ts; keep the two in sync (#1259).
  maxMetaDescriptionString: 2000,
  // Must stay ABOVE the shipped rules-catalog count with headroom — the API
  // publish schema rejects whole reports past this, so hitting it strands
  // every cloud/CLI publish in prod (#982: 251 rules vs old cap of 250).
  // packages/rules has a drift-guard test asserting catalog count < this.
  maxRules: 400,
  maxChecksPerRule: 500,
  maxSummaryItems: 1000,
  maxSourcePages: 5,
  // Caps both sitemaps.discovered and each entry's childSitemaps — mega-site
  // sitemap indexes (techcrunch: 2057 children) must be trimmed CLI-side or
  // the publish 400s wholesale.
  maxSitemapEntries: 2000,
} as const;

// ── Check Details Record (#1288) ────────────────────────────────
// `check.details` is a free-form `z.record(z.unknown())` at the publish
// schema — unlike every other display field (#1216/#1263) it has no single
// shape to clamp a string against, so it's bounded structurally instead (see
// clampDetailsRecord in ./clamp).
//
// maxDepth/maxKeysPerLevel bound the per-axis worst case, but they MULTIPLY:
// maxDepth permits 4 container levels (depths 0-3; clampDetailsValue's own
// doc explains the off-by-one), each up to maxKeysPerLevel=20 wide, so the
// structural pass alone can visit up to 20^4 = 160,000 leaf nodes before
// maxBytes ever runs — the per-axis caps bound WIDTH and DEPTH but not TOTAL
// WORK. maxNodes closes that: a hard ceiling on values visited during the
// structural walk (clampDetailsValue increments + checks it on every call,
// short-circuiting once exceeded), independent of how depth/width combine.
// 1000 is enormous headroom for real data (176 rule-emitted `details` shapes
// audited for #1288 are all well under 50 total nodes) while decisively
// bounding the pathological case to a small constant instead of 160,000.
//
// maxBytes remains the backstop against a record that's WITHIN maxNodes but
// still serializes large (near-max-length strings at every one of those
// nodes) — real `details` are well under 1KB, so this too is generous
// headroom, not a tight fit; this is a pathological-input backstop, not a
// budget real reports are expected to approach.
export const CHECK_DETAILS_LIMITS = {
  maxDepth: 3,
  maxKeysPerLevel: 20,
  maxNodes: 1000,
  maxBytes: 8 * 1024,
} as const;

// ── Per-website Custom Crawl Config (#318) ─────────────────────
// maxPages reuses REPORT_LIMITS.maxPages as the hard ceiling.
export const CUSTOM_CRAWL_CONFIG = {
  maxDepth: 10,
} as const;

// ── LLM Report Output ──────────────────────────────────────────
export const LLM_REPORT = {
  maxAffectedPages: 5,
  maxItems: 5,
  maxItemSourcePages: 5,
  maxMetaValueLength: 200,
} as const;

// ── Publish Limits (CLI → API) ──────────────────────────────────
export const PUBLISH_LIMITS = {
  maxItems: 50,
  maxSummary: 10,
  maxSitemapUrls: 100,
  // Must match the API's checkItemSchema sourcePages cap — payloads
  // exceeding it are rejected wholesale with VALIDATION_ERROR.
  maxSourcePagesPerItem: 100,
  // #1167: publish-time per-check page sampling. A published report is a SUMMARY,
  // so a site-wide failing rule ships a fixed-size SAMPLE of affected-page URLs
  // (+ the true count via details.pagesTruncated), never every URL. This makes the
  // publish payload O(rules × sample_cap) — flat from a 10-page audit to a 100k-page
  // one — instead of scaling with crawl size × failure count (public #26: a 500-page
  // audit produced a 22.85MB payload that blew the 20MB gate AFTER 1050 credits spent).
  maxPagesPerCheckPublish: 100,
  // #1167: at publish, cap each item's sourcePages HARDER than the schema max
  // (maxSourcePagesPerItem). sourcePages exists only so the server can attribute a
  // merged item to a few of the sampled pages; 100 is attribution overkill and the
  // dominant "items remainder" bloat (root cause #2). 10 keeps per-check item bytes
  // bounded while preserving enough attribution for the (default-off) smart-audits merge.
  maxSourcePagesPerItemPublish: 10,
} as const;

// #1185: bounds for the unsampled publish resolution signal (resolution.ts).
// Everything here degrades SAFELY when hit: a crawled URL past the cap, a
// dropped key, or a truncated hash set all fall back to pre-#1185 carry
// behavior on the server — never to a wrong resolve.
export const RESOLUTION_SIGNAL_LIMITS = {
  // Full crawled-URL list cap — tracks the CLI crawl ceiling (MAX_PAGES_CAP).
  maxCrawledUrls: 5_000,
  // Per-check failing-hash cap — tracks REPORT_LIMITS.maxPagesPerCheck (the
  // fold's own page cap, past which the source list is already incomplete).
  maxHashesPerCheck: 5_000,
  // Per-MAP hash budget, enforced independently for `failing` and for
  // `notEvaluated` (both by the builder and by the publish schema's refines) —
  // so the schema-permitted worst case is ~200k hashes × ~11 bytes ≈ 2.2MB, not
  // 1.1MB. Still small against the 20MB publish gate even for a pathological
  // every-rule-fails run; size future changes against the doubled figure.
  maxHashesTotal: 100_000,
  // Max `${ruleId}|${checkName}` keys (catalog ≈ 261 rules × a few check
  // classes each; 2000 is generous headroom).
  maxChecks: 2_000,
} as const;

// #1167: hard-clip fallback applied by the CLI publish degrade pass (publish.ts)
// only when the primary-capped payload STILL exceeds maxPayloadBytes — should be
// unreachable post-sampling, but guarantees a signalled clip over a 413. Tighter
// than PUBLISH_LIMITS on every axis so the rebuilt body provably fits the 20MB gate.
// Shape matches the rules pkg `PublishSampleLimits` so it drops straight into
// sampleChecksForPublish / slimForPublish's degrade pass.
export const PUBLISH_DEGRADE_LIMITS = {
  maxPagesPerCheck: 25,
  maxItems: 10,
  maxSourcePagesPerItem: 3,
} as const;

// ── Coverage Mode Page Limits ───────────────────────────────────
export const COVERAGE_PAGE_LIMITS = {
  quick: 25,
  surface: 100,
  full: 500,
} as const satisfies Record<CoverageMode, number>;

export const MAX_PAGES_CAP = 5_000;

// Upper bound for the CLI --concurrency / --per-host flags (#1068). Guards
// against an absurd worker-pool size; mirrors MAX_PAGES_CAP's clamp posture.
export const MAX_CRAWL_CONCURRENCY = 100;

// ── Enrichment ──────────────────────────────────────────────────
export const ENRICHMENT = {
  // Master kill switch for AI issue enrichment (recommendation/fix
  // generation). Disabled for now: it's wasted spend without a linked GitHub
  // repo to act on the recommendations, and is slated to become an enterprise
  // feature. Flip to `true` (or replace with a plan/repo gate) to re-enable.
  // Every enrichment entry point (post-audit auto-enrich, the queue step, and
  // the /enrich, /summary, /bulk-enrich endpoints) checks this.
  enabled: false,
  autoSafetyCap: 50,
  batchSize: 5,
} as const;

// ── Memory ──────────────────────────────────────────────────────
export const MEMORY = {
  embedTimeoutMs: 10_000,
  dedupThreshold: 0.9,
  maxTotalTokens: 2_000,
  maxPerItemTokens: 400,
  fixRunnerTimeoutMs: 5_000,
} as const;

// ── Database Connection Pool ────────────────────────────────────
// idleTimeoutSec must stay BELOW Hyperdrive's own idle-reap window so postgres.js
// closes idle pooled connections first (clean, transparent reconnect) instead of
// Hyperdrive force-closing them and surfacing an async "Idle connection closed by
// Hyperdrive" error (Sentry API-1). maxLifetimeSec bounds connection age likewise.
export const DB_POOL = {
  idleTimeoutSec: 4,
  connectTimeoutSec: 10,
  maxLifetimeSec: 60 * 10,
} as const;

// ── Telemetry ───────────────────────────────────────────────────
export const TELEMETRY = { timeoutMs: 3_000 } as const;

// ── Dashboard SSE ───────────────────────────────────────────────
export const CLIENT_STREAM = { maxReconnectDelayMs: 10_000 } as const;

// ── Cloud Service Limits ────────────────────────────────────────
export const SERVICE_LIMITS = {
  maxBodyBytes: 5 * 1024 * 1024,
  aiParseBatchPages: 20,
  authorityBatchPages: 20,
  deadLinksBatchUrls: 200,
  renderBatchUrls: 10,
  /** Max sampled pages per tech-detect call (home + a few representative pages). */
  techDetectMaxPages: 12,
  /** Defensive per-page HTML cap (bytes) for tech-detect; CLI pre-caps too. */
  techDetectMaxHtmlBytes: 512 * 1024,
  /** Max scripts considered per page for tech-detect detectors. */
  techDetectMaxScriptsPerPage: 60,
  /** Max sampled pages per site-metadata call (home + a few representative pages). */
  metadataMaxPages: 6,
  /** Defensive cap (bytes) on the total JSON-LD payload per site-metadata call. */
  metadataMaxJsonLdBytes: 32_768,
  /** Max category lines accepted per editor-summary call (CLI sends the worst few). */
  editorSummaryMaxCategories: 24,
  /** Max top issues accepted per editor-summary call (CLI pre-ranks + pre-caps). */
  editorSummaryMaxIssues: 30,
  blocklistBatchValues: 2000,
  gapsMaxCompetitors: 5,
  gapsMaxSeeds: 50,
  gapsMaxResults: 100,
} as const;
