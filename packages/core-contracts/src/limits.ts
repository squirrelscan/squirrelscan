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
// quick raised again 240s→330s / 130s→210s (squirrelscan/repo#1699, #2026):
// the crawl phase must be able to hold the ENTRY page's worst case before the
// first page can exist, or a slow origin fails with "no pages collected" before
// the entry retry from #304 ever reports. That worst case, all bounds from
// CLOUD_CRAWLER below: preamble 45s + sitemap walk 20s + entry outer deadline
// 30s + plain entry retry 60s = 155s, plus one page round at the outer deadline
// (30s) so a stored entry page is followed by at least one more fetch, plus
// margin: 210s. The 130s phase ended at 95s of preamble + entry and cut the 60s
// retry short every time (nuxt.daigo.ru, verified 2026-09-09 on v0.0.93). The
// runtime moves by the same 80s so the post-crawl slice (rules, prefetch,
// publish) keeps its 110s and both invariants above hold.
export const AUDIT_RUNTIME = {
  timeoutByCoverageMs: {
    quick: 330_000,
    surface: 900_000,
    full: 2_400_000,
  } satisfies Record<CoverageMode, number>,
  crawlPhaseTimeoutByCoverageMs: {
    quick: 210_000,
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
  //   Was 4_800 (full budget ÷ its 500-page preset), which gave a 500-page full
  //   audit exactly the 2400s base. A 474-page rendered crawl of ~1MB Shopify
  //   pages needs ~27min to crawl + ~16min of rules on the container (#1864) and
  //   timed out at 310/474 pages with memory to spare (#1862). 7_200 lets the
  //   500-page preset reach the 1h ceiling; quick/surface presets are unchanged
  //   (25 × 7.2s = 180s < 240s base, 100 × 7.2s = 720s < 900s base).
  runPerPageMs: 7_200,
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
// The cloud runner's per-page fetch deadline (`config.crawler.timeout_ms` in
// the container; worker-agent resolves it from SQUIRREL_CRAWLER_TIMEOUT_MS
// clamped to [min, max]). It is the OUTER deadline of one page fetch through
// the cloud document fetcher, and the fetcher splits it (squirrelscan/repo#2026):
//
//   render gets `outer - fallbackHeadroomMs` to itself, then the plain-HTTP
//   fallback starts and races it for the last `fallbackHeadroomMs`, whichever
//   lands first serving the page. The fallback is therefore guaranteed its
//   headroom INSIDE the outer deadline, so any outer deadline still yields a
//   page whenever plain HTTP can fetch it in that time, and a render that
//   finishes late but inside the deadline is still used (it was charged on
//   submit). The headroom is clamped to half the outer so render always keeps
//   at least half. At the defaults: render 18s alone, then 12s racing.
//
// 12s → 30s (squirrelscan/repo#2026, the class fix under #1699): 12s was the
// tightest per-request bound in the system and, on its own, decided the audit
// for a far-away origin (nuxt.daigo.ru: ~1s TTFB from a dev box, slower from
// the container's egress) whose frontier was the seed alone. 30s is what the
// CLI's plain path and the crawler default already give a page. Rationale
// against the run budget: this is a CEILING only a stalled page pays, the
// crawl-phase budget (AUDIT_RUNTIME.crawlPhaseTimeoutByCoverageMs) still
// bounds the run, and the tail a stalled site can add is concurrency × 30s.
//
// THREE windows derive from it in packages/crawler, so raising it moves them:
//   - preamble budget  = min(45s, 3 × T)  → 45s (was 36s); the sequential root
//     probes (robots, llms, markdown, well-known, agent access, RSL) share it.
//   - sitemap walk window = min(20s, 3 × T) → 20s (unchanged, already capped);
//     the walk's hard stop (60s) does not derive from T.
//   - entry fetch: the seed's first attempt is one outer deadline through the
//     document fetcher (render + fallback as above); when that times out with
//     nothing stored, the plain retry from #1699 gets 2 × T → 60s (was 24s).
//   Also the per-URL watchdog, max(120s, 6 × T) → 180s (was 120s).
// Worst case on a quick run (130s crawl phase) with every stage at its bound:
// 45 + 20 + 30 = 95s before the entry retry, which the crawl-phase stop can
// then cut short. The old numbers summed to 36 + 20 + 45 (the render batch
// budget) + 12 = 113s with NO retry inside the phase, so this is not a
// regression on that path, and a healthy origin never approaches any of it.
export const CLOUD_CRAWLER = {
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 3_000,
  maxTimeoutMs: 60_000,
  // Reserved for the plain-HTTP fallback inside the outer deadline (see above).
  // 12s = what the WHOLE page fetch used to get, so the fallback never has less
  // than it had before the raise.
  fallbackHeadroomMs: 12_000,
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
  // per-check pages cap below (#918): raising THIS raises crawl cost.
  //
  // 2,000 → 10,000 (#1028): the ceiling was set when a published report carried
  // one entry per affected page, so payload grew with crawl size. #1167 made the
  // publish payload FLAT in crawl size (PUBLISH_LIMITS.maxPagesPerCheckPublish
  // samples each check to 100 pages) and #1023's chunked NDJSON findings ingest
  // removed the single-body ceiling on findings, so the 20MB gate no longer
  // scales with pages crawled. The binding constraint is now container MEMORY:
  // a measured 10,000-page CLI audit peaked at 4,562 MB RSS / 4,425 MB heap
  // (~0.39 MB retained per page, linear), which fits the standard-4 class paid
  // plans run on (#1869) and does NOT fit free's 4 GiB — which is why the free
  // plan's ladder value stays at 500 rather than tracking this.
  maxPages: 10_000,
  // Max pages a single folded aggregate check may list (fold cap +
  // checkResultSchema.pages). Set to MAX_PAGES_CAP so an audit crawling up to
  // the crawl ceiling keeps EVERY affected page in the published report instead
  // of silently clipping (#918) — the fold reduces N per-page checks to ONE
  // aggregate, and the publish payload guard degrades to a signalled clip
  // before the 20MB gate. Was strictly ABOVE maxPages while the cloud ceiling
  // (2,000) sat below the CLI's (5,000); now that both ceilings are 10,000 it
  // EQUALS maxPages, which is the same invariant ("covers a full crawl"), not
  // a weakening of it.
  maxPagesPerCheck: 10_000,
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
  // into the tag) and stays aligned with hosted report validation.
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
  // Full crawled-URL list cap — tracks the crawl ceiling (MAX_PAGES_CAP). These
  // are raw URLs, not hashes, so this is the one axis of the signal that scales
  // with crawl size: 10,000 typical URLs is ~0.8MB against the 20MB publish
  // gate. The pathological case (every URL at maxUrlLength) is 20MB, but that
  // was already 10MB at 5,000 — the ratio is what changed, not the class of
  // risk. A crawl past this cap degrades safely: pages beyond it fall back to
  // pre-#1185 carry behavior, never to a wrong resolve.
  maxCrawledUrls: 10_000,
  // Per-check failing-hash cap — tracks REPORT_LIMITS.maxPagesPerCheck (the
  // fold's own page cap, past which the source list is already incomplete).
  // maxHashesTotal below is UNCHANGED, so the signal's total hash budget (and
  // therefore its worst-case bytes) does not move with this.
  maxHashesPerCheck: 10_000,
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
  // #1028: byte budget for `pageStatuses`, the one published field sized by
  // PAGES CRAWLED rather than by findings and therefore invisible to the
  // per-check caps above. It lists every non-2xx page, count-capped at the crawl
  // ceiling, so at 10,000 pages of maxUrlLength URLs it is ~20MB on its own
  // against a 20MB gate — the degrade pass would run, shrink nothing that
  // mattered, and the publish would still fail. Clipping it only means fewer
  // carried findings get staled (they carry instead), never a wrong resolve.
  //
  // 4MB is a fifth of the gate: generous for any real site (an ordinary URL is
  // ~60 bytes, so this is tens of thousands of broken pages) while leaving the
  // rest of the budget to the report. Bytes, not a count, because entry size
  // varies by three orders of magnitude with URL length. See
  // clipPageStatusesToBytes in the rules pkg, which also explains why
  // `resolutionSignal` is left alone.
  maxPageStatusBytes: 4 * 1024 * 1024,
} as const;

// ── Coverage Mode Page Limits ───────────────────────────────────
export const COVERAGE_PAGE_LIMITS = {
  quick: 25,
  surface: 100,
  full: 500,
} as const satisfies Record<CoverageMode, number>;

// Hard ceiling on a single crawl, applied by the CLI (resolvePageLimit) and by
// every cloud dispatch path via REPORT_LIMITS.maxPages, which now equals it.
// 5,000 → 10,000 (#1028): see the memory arithmetic on REPORT_LIMITS.maxPages.
//
// ROLLOUT: server before CLI. The API validates a publish against ITS OWN copy
// of these constants, and rejects the whole payload rather than clamping it, so
// a CLI binary built with this cap publishing to an API still on the old one
// fails outright — for `pageStatuses` (was capped at the old maxPages) that
// bites at 2,001 pages, well below the new ceiling. Deploy the hosted side
// first, then cut the CLI release.
export const MAX_PAGES_CAP = 10_000;

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
