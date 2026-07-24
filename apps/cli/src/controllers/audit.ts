// Audit controller - composes crawl + analyze + report

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { Duration, Effect, Fiber, Stream } from "effect";

import type { Config } from "@/config";
import type { CrawlerEvent } from "@/crawler/core/types";
import type { TlsEvent } from "@/crawler/fetcher";
import type { CrawlerConfigSnapshot } from "@/crawler/storage/types";
import type { AuditReport, AuditOptions } from "@/types";

import { createCrawler } from "@/crawler/core";

export type { CrawlerEvent } from "@/crawler/core/types";

import type { RenderChargeLine } from "@squirrelscan/core-contracts";
import type { ParsedPageCache } from "@squirrelscan/parser";

import { createCloudDocumentFetcher } from "@squirrelscan/audit-engine";
import { PLANS } from "@squirrelscan/core-contracts/plans";
import {
  createConditionalRenderDocumentFetcher,
  createFetchDocumentFetcher,
} from "@squirrelscan/fetchers";

import {
  fetchResourceAssets,
  runRulesOnStorage,
  checkExternalLinksOnStorage,
  buildSiteContext,
  releaseSiteContextDocuments,
} from "@/audit/adapter";
import {
  resolveDeadLinksBulkChecker,
  runCloudDomainStats,
  runCloudEditorSummary,
  runCloudPrefetch,
  runCloudTechDetect,
  detectLocalTechnologies,
  type CloudPrefetchResult,
  type CloudTechDetectResult,
} from "@/audit/cloud";
import { gateStage1 } from "@/audit/cloud-gating";
import { resolveRulesConfig } from "@/audit/rule-filter";
import { runSmartAudits } from "@/audit/smart-audits";
import {
  loadConfig,
  DEFAULT_CRAWLER_CONCURRENCY,
  DEFAULT_CRAWLER_PER_HOST_CONCURRENCY,
  DEFAULT_CRAWLER_PER_HOST_DELAY_MS,
} from "@/config";
import {
  CRAWL_PHASE_MAX_TIMEOUT_MS,
  CRAWL_PHASE_MIN_TIMEOUT_MS,
  CRAWL_PHASE_PER_PAGE_BUDGET_MS,
  CRAWL_PHASE_SETUP_SLACK_MS,
  MAX_PAGES_CAP,
} from "@/constants";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { createHybridDocumentFetcher } from "@/crawl/hybrid-fetcher";
import { createStorage, domainToProjectName } from "@/crawler/storage";
import { reconstructReport } from "@/reports/reconstruct";
import { detectRunner } from "@/self/install-meta";
import { createCloudClientFromSettings } from "@/tools/cloud";
import { initRequestTool } from "@/tools/request";
import { configureLogger, logger } from "@/utils/logger";
import { checkReachability } from "@/utils/reachability";
import { summarizeRenderTimings } from "@/utils/render-timing-summary";
import { getHostname, isLoopbackHost, parseUserUrl } from "@/utils/url";
import { resolveStickyUserAgent } from "@/utils/user-agent";

/**
 * Fields that affect crawl scope - changes require fresh crawl_id
 * Type-checked against CrawlerConfigSnapshot to catch field renames at compile time
 */
const DIRTY_CONFIG_FIELDS = [
  "include",
  "exclude",
  "allowedDomains",
  "allowQueryParams",
  "dropQueryPrefixes",
] as const satisfies ReadonlyArray<keyof CrawlerConfigSnapshot>;

/**
 * Check if config changes require a fresh crawl (scope-affecting fields changed)
 */
function isDirtyConfig(
  oldConfig: CrawlerConfigSnapshot,
  newConfig: Partial<CrawlerConfigSnapshot>
): boolean {
  for (const field of DIRTY_CONFIG_FIELDS) {
    const oldVal = JSON.stringify(oldConfig[field]);
    const newVal = JSON.stringify(newConfig[field]);
    if (oldVal !== newVal) {
      logger.debug("dirty config field", field, oldVal, "→", newVal);
      return true;
    }
  }
  return false;
}

export interface AuditProgress {
  phase: "crawling" | "external-links" | "cloud" | "rules" | "complete";
  current?: number;
  total?: number;
  /** Free-text detail for the cloud phase (service + batch progress). */
  detail?: string;
}

export type ProgressCallback = (progress: AuditProgress) => void;

export type CrawlerEventCallback = (event: CrawlerEvent) => void;

export interface RunAuditOptions extends AuditOptions {
  onProgress?: ProgressCallback;
  onEvent?: CrawlerEventCallback;
  configPath?: string;
  documentFetcher?: DocumentFetcher;
  externalLinksEnabled?: boolean;
  externalLinksConcurrency?: number;
  externalLinksTimeoutMs?: number;
  crawlerTimeoutMs?: number;
  /**
   * Hard wall-clock backstop for the whole crawl phase (ms). On expiry the
   * crawler is stopped and the audit proceeds with whatever pages were
   * collected (or fails clearly if none) — so a wedged crawl can never hang
   * the CLI indefinitely. <=0 disables. Default: computed from maxPages /
   * concurrency. Mirrors the cloud container path (audit-engine cloud-runner).
   */
  crawlPhaseTimeoutMs?: number;
  /** Max time for the rules phase in ms (default: unlimited) */
  rulesPhaseTimeoutMs?: number;
  /** Max resources to check per category (CSS, images, scripts) in the rules phase */
  resourceCheckMaxItems?: number;
  /** Timeout per individual resource check in ms (overrides default 10s) */
  resourceCheckTimeoutMs?: number;
  /**
   * TTY confirmation for cloud spend above `[cloud].confirm_threshold`.
   * Absent (non-TTY / --yes) → prefetch proceeds without asking.
   */
  confirmCloudSpend?: (
    estimatedCredits: number,
    balance: number
  ) => Promise<boolean>;
  /** User accepted the cost-disclosing consent prompt under a cap → skip the
   * post-crawl prefetch confirm. Uncapped spend (dead-links) is still gated. */
  cloudConsented?: boolean;
  /**
   * Concrete fetch mode for this run, already resolved by the caller from
   * flags/config/auth-consent. Folded into `[cloud].rendering` by
   * `mergeOptionsToConfig`. When omitted, `[cloud].rendering` decides; an unset
   * config value ("auto") means plain HTTP here — the authed-default rendering
   * is resolved in the CLI layer, never silently in the engine.
   */
  cloudRendering?: "http" | "browser";
  /**
   * Resolver for this run's cloud run id (#1134), threaded onto render submits so
   * the render debit is attributed to the audit in the ledger. A resolver (not a
   * value) because CLI run registration is async and may resolve after the crawl
   * starts — renders before it lands stay untagged, the rest are attributed.
   */
  getRunId?: () => string | undefined;
  /**
   * Render strategy when rendering is on (#294): "auto" = HTTP-first hybrid
   * (render only client-side-rendered pages), "all" = render every HTML page.
   * Resolved by the CLI from `--render-mode` / `[cloud].render`. Undefined →
   * coverage-driven default (quick → auto, surface/full → all).
   */
  renderStrategy?: "auto" | "all";
  /**
   * Whether cloud is usable this run — resolved ONCE by the CLI layer (token
   * present AND a balance call succeeded). `false` means the session is expired
   * or the API is unreachable, so every cloud step skips cleanly (no client is
   * built, nothing is attempted, no per-step "failed" noise). Omitted/undefined
   * preserves legacy behaviour (treated as available) for non-CLI callers/tests.
   */
  cloudAvailable?: boolean;
}

/**
 * Resolve the crawl's DocumentFetcher. Cloud browser rendering applies only
 * when the resolved `[cloud].rendering` is exactly "browser", cloud is enabled,
 * the user is authed, and no caller-supplied fetcher exists. "http" and the
 * unset "auto" value both keep plain-HTTP behavior (undefined → crawler default).
 *
 * In `quick` coverage (#294) we don't browser-render every page — quick already
 * skips link discovery + cloud enrichment, and rendering all pages serially
 * (~15–30s each, 1-at-a-time on Free) makes a "quick" audit take minutes. Quick
 * uses an HTTP-first hybrid: plain HTTP for every page, re-rendering ONLY pages
 * detected as client-side-rendered shells. surface/full still render every page.
 */
export function resolveDocumentFetcher(
  options: RunAuditOptions,
  mergedConfig: Config,
  onRenderCharged?: (
    units: number,
    credits: number,
    breakdown: RenderChargeLine[]
  ) => void,
  isQuickMode = false
): DocumentFetcher | undefined {
  if (options.documentFetcher) return options.documentFetcher;
  // Cloud unusable (expired/unreachable) → no render fetcher even for explicit
  // --render (resolveCloudRendering returns "browser" before checking auth).
  if (
    options.cloudAvailable === false ||
    !mergedConfig.cloud.enabled ||
    mergedConfig.cloud.rendering !== "browser"
  ) {
    if (
      options.cloudAvailable === false &&
      mergedConfig.cloud.rendering === "browser"
    ) {
      logger.warn(
        "Cloud rendering requested but cloud is unavailable (signed out / API unreachable); using plain HTTP fetch"
      );
    }
    return undefined;
  }
  const client = createCloudClientFromSettings();
  if (!client) {
    logger.warn(
      "Cloud rendering requested but you are not logged in; using plain HTTP fetch"
    );
    return undefined;
  }

  const httpFetcher = createFetchDocumentFetcher();
  const renderFetcher = createCloudDocumentFetcher(client, {
    fallback: httpFetcher,
    onFallback: (reason) =>
      logger.warn(
        `Cloud rendering unavailable (${reason}); continuing with plain HTTP fetch`
      ),
    onRenderBlock: (url) =>
      // info (not debug): on a site that walls the renderer, the user should see
      // pages are silently dropping to plain HTTP (not JS-rendered results).
      logger.info(
        `render blocked by site (bot wall/403/WAF); retrying ${url} via direct fetch`
      ),
    onRenderCharged,
    // #1134: attribute render debits to the run. Resolver (not value) — CLI run
    // registration is async, so it's read at each submit once the id lands.
    ...(options.getRunId ? { runId: options.getRunId } : {}),
  });

  // Strategy: explicit `--render-mode`/`[cloud].render` (auto|all) wins; else
  // coverage default (quick → auto/HTTP-first, surface/full → all).
  const explicitStrategy =
    options.renderStrategy ??
    (mergedConfig.cloud.render === "auto" || mergedConfig.cloud.render === "all"
      ? mergedConfig.cloud.render
      : undefined);
  const strategy = explicitStrategy ?? (isQuickMode ? "auto" : "all");

  if (strategy === "auto") {
    logger.debug("render strategy: HTTP-first hybrid (render only CSR shells)");
    return createHybridDocumentFetcher({
      http: httpFetcher,
      render: renderFetcher,
      onUpgrade: (url) =>
        logger.debug("hybrid: upgrading CSR shell to render", url),
    });
  }

  logger.debug("render strategy: rendering every page");
  // #821/#839: gate each render behind a cheap plain-HTTP probe so an unchanged
  // page reuses its stored render instead of re-rendering on every re-run —
  // either the origin answers 304, or the normalized source (Cloudflare
  // challenge-platform injection stripped) hashes to the stored value even when
  // the origin always 200s. The probe fires when the crawler attached
  // conditional headers or a stored source hash (incremental + a stored page);
  // first visits render directly. Preserves the render fetcher's charge/fallback
  // behavior (it wraps, never re-implements).
  return createConditionalRenderDocumentFetcher({
    http: httpFetcher,
    render: renderFetcher,
    onReuse: (url) =>
      logger.debug(
        "conditional render: source unchanged (304 or matching hash), reusing cached render",
        url
      ),
  });
}

/** A single cloud-spend breakdown line in `report.cloudSpend.lines`. */
export interface CloudSpendLine {
  service: string;
  feature: string;
  units: number;
  credits: number;
}

/**
 * Fold the per-batch render charge splits into at most two spend lines —
 * render misses (`render`) and render_cached hits (`render_cached`) —
 * preserving the ACTUAL server debit. A cache hit then surfaces as its own
 * `render_cached` line (1cr) so the savings are visible, instead of being
 * lumped under `render` at the 2cr estimate. Exported for tests. #279
 */
export function foldRenderSpendLines(
  breakdown: RenderChargeLine[]
): CloudSpendLine[] {
  let renderUnits = 0;
  let renderCredits = 0;
  let cachedUnits = 0;
  let cachedCredits = 0;
  for (const line of breakdown) {
    if (line.feature === "render_cached") {
      cachedUnits += line.units;
      cachedCredits += line.credits;
    } else {
      renderUnits += line.units;
      renderCredits += line.credits;
    }
  }
  const lines: CloudSpendLine[] = [];
  if (renderUnits > 0) {
    lines.push({
      service: "render",
      feature: "render",
      units: renderUnits,
      credits: renderCredits,
    });
  }
  if (cachedUnits > 0) {
    lines.push({
      service: "render_cached",
      feature: "render_cached",
      units: cachedUnits,
      credits: cachedCredits,
    });
  }
  return lines;
}

/**
 * Ordered phase names for the audit controller's wall-clock breakdown (#857).
 * `publish` runs outside this file (CLI command layer, after `runAudit`
 * returns) — it's added to the same map by the caller before this is used for
 * telemetry, so it's listed here for documentation only.
 */
export const AUDIT_PHASES = [
  "crawl",
  "external_links",
  "assets",
  "cloud_prefetch",
  "tech_detect",
  "rules",
  "smart_merge",
  "report",
  "editor_summary",
  "domain_stats",
  "publish",
] as const;

/**
 * `CommandError.details` shape on a failed `runAudit()` (#871) — the partial
 * phase breakdown up to the point of failure, absent when no phase completed
 * yet (e.g. an early reachability failure).
 */
export interface AuditFailureDetails {
  phaseTimingsMs: Record<string, number>;
}

/**
 * Tracks per-phase wall-clock elapsed time (#857), plus which phase is
 * currently in flight so a crash mid-phase can still be attributed (#871) —
 * a wedged crawl fetch throws before `mark("crawl")` ever runs, so without
 * this the failure path's phaseTimingsMs would stay empty for exactly the
 * field case that motivated #857 in the first place. Exported for tests.
 */
export class PhaseTimer<Name extends string> {
  private readonly timings: Record<string, number> = {};
  private cursor = performance.now();
  private current: Name | undefined;

  /** Records which phase is about to run. */
  enter(name: Name): void {
    this.current = name;
  }

  /** Records elapsed ms since the last mark (or enter) under `name`. */
  mark(name: Name): void {
    const now = performance.now();
    this.timings[name] = now - this.cursor;
    this.cursor = now;
    this.current = undefined;
  }

  /** Resets the cursor without marking a phase — excludes setup time from whatever runs next. */
  resetCursor(): void {
    this.cursor = performance.now();
  }

  /**
   * On a failure, attributes elapsed time to the phase that was entered but
   * never got to mark itself. No-ops if every entered phase already marked
   * (nothing in flight) or the in-flight phase was somehow already marked.
   */
  attributeInFlight(): void {
    if (this.current && !(this.current in this.timings)) {
      this.timings[this.current] = performance.now() - this.cursor;
    }
  }

  /** Defensive copy — callers must not be able to mutate internal state. */
  get timingsMs(): Record<string, number> {
    return { ...this.timings };
  }
}

/**
 * Render the per-phase wall-clock breakdown for the debug summary line, e.g.
 * `"crawl=47.2s rules=237.4s report=62.1s total=312.8s"`. Phases are emitted in
 * the order they were recorded (object insertion order == execution order,
 * since callers only ever set each key once, when that phase completes) —
 * phases that never ran are simply absent from `phases`. Exported for tests.
 */
export function formatPhaseTimings(phases: Record<string, number>): string {
  const parts = Object.entries(phases).map(
    ([name, ms]) => `${name}=${(ms / 1000).toFixed(1)}s`
  );
  const total = Object.values(phases).reduce((sum, ms) => sum + ms, 0);
  parts.push(`total=${(total / 1000).toFixed(1)}s`);
  return parts.join(" ");
}

/**
 * Resolve the crawl-phase wall-clock backstop (ms), or undefined to disable.
 * A generous per-page allowance scaled by maxPages/concurrency and clamped, so
 * it (almost) never fires during a healthy-but-slow crawl and only rescues a
 * genuinely wedged one. The per-URL watchdog inside the crawler is the primary
 * self-heal; this is the last-resort total cap. Explicit option wins; <=0 off.
 */
export function resolveCrawlPhaseTimeoutMs(
  options: RunAuditOptions,
  maxPages: number,
  concurrency: number
): number | undefined {
  if (typeof options.crawlPhaseTimeoutMs === "number") {
    return options.crawlPhaseTimeoutMs > 0
      ? Math.floor(options.crawlPhaseTimeoutMs)
      : undefined;
  }
  const conc = Math.max(1, concurrency);
  const pages = Math.max(1, maxPages);
  const est =
    Math.ceil(pages / conc) * CRAWL_PHASE_PER_PAGE_BUDGET_MS +
    CRAWL_PHASE_SETUP_SLACK_MS;
  return Math.min(
    Math.max(est, CRAWL_PHASE_MIN_TIMEOUT_MS),
    CRAWL_PHASE_MAX_TIMEOUT_MS
  );
}

export interface CrawlConcurrencySettings {
  concurrency: number;
  perHostConcurrency: number;
  perHostDelayMs: number;
}

/**
 * Loopback fast profile (#1068). A loopback target is the user's own dev server
 * (the agent/CI "audit before deploy" inner loop), so politeness throttling is
 * pointless — raise both concurrency knobs and drop the per-host stagger. Capped
 * at 16 rather than unbounded because dev servers are often single-threaded
 * (Vite SSR chokes at high parallelism); users who need more (or less) set
 * --concurrency / --per-host, which also suppresses this profile entirely.
 */
export const LOOPBACK_FAST_CONCURRENCY = 16;
export const LOOPBACK_FAST_PER_HOST_CONCURRENCY = 16;
export const LOOPBACK_FAST_PER_HOST_DELAY_MS = 0;

/** Loopback fast-path inputs; see `resolveCrawlConcurrency`. */
export interface LoopbackFastPathContext {
  /** Target host resolves to loopback (localhost, 127/8, ::1, *.localhost). */
  isLoopback: boolean;
  /** User set concurrency explicitly (flag or non-default config) → don't override. */
  userOverride: boolean;
}

/**
 * Did the user set crawl concurrency explicitly? True when a CLI flag was passed
 * OR the merged config's concurrency knobs differ from the schema defaults — the
 * only way to recover the "was it set" provenance zod erases. Any of these
 * suppresses the loopback fast path (#1068). Exported for tests.
 */
export function deriveUserSetConcurrency(
  options: Pick<RunAuditOptions, "concurrency" | "perHostConcurrency">,
  config: Config
): boolean {
  return (
    options.concurrency !== undefined ||
    options.perHostConcurrency !== undefined ||
    config.crawler.concurrency !== DEFAULT_CRAWLER_CONCURRENCY ||
    config.crawler.per_host_concurrency !==
      DEFAULT_CRAWLER_PER_HOST_CONCURRENCY ||
    config.crawler.per_host_delay_ms !== DEFAULT_CRAWLER_PER_HOST_DELAY_MS
  );
}

/**
 * Whether the loopback fast profile applies: a TRUE plain-HTTP crawl (no
 * fetcher — a hybrid/render fetcher still submits cloud renders and must keep
 * `base`) against a loopback target the user hasn't overridden (#1068). Single
 * source of truth for both the profile selection and the debug log. Exported
 * for tests.
 */
export function shouldUseLoopbackFastPath(
  documentFetcher: DocumentFetcher | undefined,
  loopback: LoopbackFastPathContext | undefined
): boolean {
  return !documentFetcher && !!loopback?.isLoopback && !loopback.userOverride;
}

/**
 * Resolve crawl parallelism for the active document fetcher.
 *
 * Cloud-render fetches are queued jobs in OUR cloud — each one is a submit +
 * poll loop that takes tens of seconds, and the CLI never touches the target
 * host itself (the render workers do). Throttling those submits with the
 * plain-HTTP per-host limits (2 concurrent, 200ms delay) made rendered crawls
 * effectively serial (~15-20s/page). Raise parallelism to
 * `[cloud].render_concurrency` (default 6, capped at 10 because render workers
 * DO hit the target host) and drop the CLI-side per-host delay.
 *
 * `planRenderConcurrency` (from the user's plan via GET /v1/credits) further
 * clamps the configured value — Free runs 1 render at a time, Pro runs 5,
 * Team runs 10.
 *
 * On the plain-HTTP path, a loopback target with no explicit user override gets
 * the loopback fast profile (#1068).
 *
 * Exported for tests.
 */
export function resolveCrawlConcurrency(
  config: Config,
  documentFetcher: DocumentFetcher | undefined,
  planRenderConcurrency?: number,
  loopback?: LoopbackFastPathContext
): CrawlConcurrencySettings {
  const base: CrawlConcurrencySettings = {
    concurrency: config.crawler.concurrency,
    perHostConcurrency: config.crawler.per_host_concurrency,
    perHostDelayMs: config.crawler.per_host_delay_ms,
  };
  if (documentFetcher?.id !== "cloud-render") {
    if (shouldUseLoopbackFastPath(documentFetcher, loopback)) {
      return {
        concurrency: LOOPBACK_FAST_CONCURRENCY,
        perHostConcurrency: LOOPBACK_FAST_PER_HOST_CONCURRENCY,
        perHostDelayMs: LOOPBACK_FAST_PER_HOST_DELAY_MS,
      };
    }
    return base;
  }

  const renderConcurrency = Math.max(
    1,
    Math.min(
      config.cloud.render_concurrency,
      planRenderConcurrency ?? Number.POSITIVE_INFINITY
    )
  );
  return {
    // Exactly renderConcurrency for BOTH knobs — every worker is a render job
    // in cloud-render mode, and the per-host limiter alone would let a
    // multi-host crawl run hosts × limit renders. The cap must hold even when
    // the config's crawler concurrency or per_host_concurrency is higher.
    concurrency: renderConcurrency,
    perHostConcurrency: renderConcurrency,
    // No artificial delay between job submissions; robots.txt crawl-delay
    // still applies (the crawler prefers robots.crawlDelayMs when present).
    perHostDelayMs: 0,
  };
}

/**
 * Upsell hint appended to the render-concurrency clamp warning: Free -> Pro,
 * Pro (planId "starter") -> Team. Interpolated from `PLANS` so the numbers
 * never drift from the actual plan definitions. Team has no higher tier, so
 * a clamped Team plan (or any unknown planId) gets no hint.
 * Exported for tests.
 */
export function renderConcurrencyUpsellHint(planId: string): string {
  if (planId === "free") {
    return ` — upgrade to Pro for ${PLANS.starter.renderConcurrency} concurrent renders`;
  }
  if (planId === "starter") {
    return ` — upgrade to Team for ${PLANS.team.renderConcurrency} concurrent renders`;
  }
  return "";
}

/**
 * Fetch the plan's render-concurrency limit before a cloud-rendered crawl.
 * One extra GET /v1/credits per rendered audit. Fails OPEN (undefined) on
 * transport errors — concurrency is a speed perk, not a spend control (every
 * render debits credits regardless), so a flaky preflight must not slow a
 * paying user down to the free tier.
 */
async function fetchPlanRenderConcurrency(
  config: Config
): Promise<number | undefined> {
  const client = createCloudClientFromSettings();
  if (!client) return undefined;
  try {
    const { plan } = await client.getBalance({
      signal: AbortSignal.timeout(10_000),
    });
    if (typeof plan?.renderConcurrency !== "number") return undefined;
    if (plan.renderConcurrency < config.cloud.render_concurrency) {
      logger.warn(
        `Render concurrency limited to ${plan.renderConcurrency} on the ${plan.name} plan` +
          renderConcurrencyUpsellHint(plan.id)
      );
    }
    return plan.renderConcurrency;
  } catch (error) {
    logger.debug("plan render-concurrency preflight failed", error);
    return undefined;
  }
}

/**
 * Resolve incremental crawl: --refresh forces a full fetch; else the explicit
 * --incremental/--no-incremental flag; else the [crawler] incremental config. (#125)
 */
export function resolveIncremental(
  refresh: boolean | undefined,
  flag: boolean | undefined,
  configIncremental: boolean
): boolean {
  if (refresh) return false;
  return flag ?? configIncremental;
}

/**
 * Run full audit: crawl → analyze → report
 * This is the entry point that composes all steps
 */
export async function runAudit(
  options: RunAuditOptions
): Promise<Result<AuditReport>> {
  // Parse and normalize URL
  const parsed = parseUserUrl(options.url);
  if (!parsed.ok) {
    return err(commandError(ErrorCodes.INVALID_URL, parsed.error));
  }
  const url = parsed.url;

  // Load config first (needed for TLS settings before reachability check)
  // Silent since CLI already logged the config path
  const config = await loadConfig(options.configPath, { silent: true });
  const mergedConfig = mergeOptionsToConfig(config, options);

  const onProgress = options.onProgress ?? (() => {});

  // Per-phase wall-clock breakdown (#857/#871) — see PhaseTimer above. A phase
  // that never runs (e.g. cloud disabled) is simply never marked, so it's
  // absent from the map and the debug summary line. Declared here (not
  // inside the inner try below) so the outer catch can still log whatever
  // phases completed — or was in flight — before a failure.
  const phaseTimer = new PhaseTimer<(typeof AUDIT_PHASES)[number]>();

  try {
    configureLogger({ debug: options.debug ?? false });
    logger.debug("starting audit", url);

    // Initialize request tool with config
    initRequestTool({
      timeout: mergedConfig.crawler.timeout_ms,
    });

    // Check reachability
    logger.debug("checking reachability", url);
    const reachability = await checkReachability(url);
    if (!reachability.reachable) {
      return err(
        commandError(
          ErrorCodes.UNREACHABLE,
          `Cannot reach ${url}: ${reachability.error}`
        )
      );
    }

    // Warn if target site uses WAF/bot protection
    if (reachability.wafDetected) {
      const provider = reachability.wafProvider ?? "WAF";
      logger.warn(
        `Site uses ${provider} protection - some pages may be inaccessible and results may be incomplete`
      );
    }

    // Create storage with project name (use provided name or derive from domain)
    const projectName = options.projectName ?? domainToProjectName(url);
    logger.debug("creating storage", projectName);

    const storage = await Effect.runPromise(createStorage({ projectName }));

    // Crawler stashes each ParsedPage here so the audit skips a re-parse (#267)
    const parsedPageCache: ParsedPageCache = new Map();

    // Fiber handle for event subscription (declared outside try for finally cleanup)
    let eventsFiber: ReturnType<typeof Effect.runFork> | undefined;

    // Cloud spend charged OUTSIDE the prefetch: render submits during the
    // crawl and dead-links bulk calls during the external-links phase. Both
    // are merged with the prefetch spend into report.cloudSpend below.
    // Per-batch render charge splits (render misses 2cr vs render_cached hits
    // 1cr) — the ACTUAL server debit, not the estimate. Folded into spend lines
    // below so cache savings show as their own `render_cached` line. #279
    const renderCharges: RenderChargeLine[] = [];
    let deadLinksUnits = 0;
    let deadLinksCredits = 0;
    // Tech-detect: a flat-charged, report-only cloud call (STEP 2.6).
    let techDetectCredits = 0;
    let techResult: CloudTechDetectResult | null = null;
    // Editor's summary: a flat-charged, credited, report-only cloud call (STEP 3.1).
    let editorSummaryCredits = 0;
    // Domain stats: a flat-charged, credited, report-only cloud call (STEP 3.2).
    let domainStatsCredits = 0;

    try {
      // ============================================
      // STEP 1: CRAWL
      // ============================================
      phaseTimer.resetCursor(); // exclude reachability/storage setup above
      phaseTimer.enter("crawl");
      // Resolve user-agent: empty string = random browser UA, pinned per
      // project so re-runs serve the same markup (#875)
      const { userAgent, source: uaSource } = await Effect.runPromise(
        resolveStickyUserAgent(mergedConfig.crawler.user_agent, storage, {
          freshUa: options.freshUa,
        })
      );
      logger.debug(`using ${uaSource} user-agent`, userAgent);

      // Resolve coverage mode: CLI flag > config > default (surface)
      const coverageMode =
        options.coverageMode ?? mergedConfig.crawler.coverage ?? "surface";
      // Quick coverage skips all networked cloud enrichment (no credit prompt).
      const isQuickMode = coverageMode === "quick";

      const documentFetcher = resolveDocumentFetcher(
        options,
        mergedConfig,
        (_units, _credits, breakdown) => {
          renderCharges.push(...breakdown);
        },
        isQuickMode
      );
      // Plan-gated render concurrency: Free=1, Pro=5, Team=10 (cloud renders only).
      // cloudAvailable check is belt-and-suspenders — resolveDocumentFetcher
      // already returns non-render when cloud is unavailable — but keeps the
      // gate explicit so this getBalance never fires at a dead session.
      const planRenderConcurrency =
        options.cloudAvailable !== false &&
        documentFetcher?.id === "cloud-render"
          ? await fetchPlanRenderConcurrency(mergedConfig)
          : undefined;
      // Loopback fast path (#1068): boost concurrency for the user's own dev
      // server unless they set concurrency explicitly (flag, or config that
      // differs from the schema default — zod erases the "was it set" bit).
      const loopbackCtx = {
        isLoopback: isLoopbackHost(getHostname(url)),
        userOverride: deriveUserSetConcurrency(options, mergedConfig),
      };
      const crawlConcurrency = resolveCrawlConcurrency(
        mergedConfig,
        documentFetcher,
        planRenderConcurrency,
        loopbackCtx
      );
      if (shouldUseLoopbackFastPath(documentFetcher, loopbackCtx)) {
        // Explain the silent 5→16 bump in traces (#1068).
        logger.debug(
          `loopback fast path: concurrency ${LOOPBACK_FAST_CONCURRENCY}, no per-host delay`
        );
      } else if (
        loopbackCtx.isLoopback &&
        !loopbackCtx.userOverride &&
        documentFetcher
      ) {
        // Loopback but a render/hybrid fetcher is active — say why the boost
        // was skipped so "the fast path didn't fire" isn't a mystery (#1068).
        logger.debug(
          "loopback fast path skipped: cloud rendering active (renders honor the plan concurrency clamp); use --http or --offline for the plain-HTTP fast path"
        );
      }

      const incrementalEnabled = resolveIncremental(
        options.refresh,
        options.incremental,
        mergedConfig.crawler.incremental
      );

      const crawlerConfig = {
        maxPages: mergedConfig.crawler.max_pages,
        maxDepth: mergedConfig.crawler.max_depth,
        concurrency: crawlConcurrency.concurrency,
        perHostConcurrency: crawlConcurrency.perHostConcurrency,
        delayMs: mergedConfig.crawler.delay_ms,
        perHostDelayMs: crawlConcurrency.perHostDelayMs,
        timeoutMs: mergedConfig.crawler.timeout_ms,
        userAgent,
        headers: mergedConfig.crawler.headers,
        followRedirects: mergedConfig.crawler.follow_redirects,
        respectRobots: mergedConfig.crawler.respect_robots,
        incremental: incrementalEnabled,
        // Browser-like freshness: skip re-requesting fresh pages (max-age /
        // Expires) across audits. Honored only when incremental; --refresh
        // forces a full re-fetch by disabling incremental above. (#106)
        useCacheControl: mergedConfig.crawler.use_cache_control,
        maxStalenessSeconds: mergedConfig.crawler.max_staleness_seconds,
        include: mergedConfig.crawler.include,
        exclude: mergedConfig.crawler.exclude,
        allowQueryParams: mergedConfig.crawler.allow_query_params,
        dropQueryPrefixes: mergedConfig.crawler.drop_query_prefixes,
        allowedDomains: mergedConfig.project.domains,
        breadthFirst: mergedConfig.crawler.breadth_first,
        maxPrefixBudgetRatio: mergedConfig.crawler.max_prefix_budget,
        coverageMode,
        disableLinkDiscovery: isQuickMode,
        documentFetcher,
        onTlsEvent: (event: TlsEvent) => {
          // Surface TLS/status-0 failures + standard-fetch fallbacks so they
          // aren't silent (failed fallbacks at warn, the rest at debug).
          if (event.kind === "fallback_failed" || event.kind === "error") {
            logger.warn("tls fetch failed", event);
          } else {
            logger.debug("tls fetch event", event);
          }
        },
      };

      const crawler = await Effect.runPromise(
        createCrawler({
          config: crawlerConfig,
          storage,
          parsedPageCache,
        })
      );

      logger.debug("step 1: crawling", url);
      onProgress({ phase: "crawling" });

      // Detect redirects first so we can look up by final URL
      // (before subscribing to events to avoid counting redirect requests)
      const finalUrl = await Effect.runPromise(crawler.detectRedirects(url));

      // Subscribe to crawler events to emit progress updates
      let pagesProcessed = 0;
      // Queue-wait vs render-time samples for rendered pages only (#826) —
      // summarized into a debug log once the crawl phase completes.
      const renderTimingSamples: {
        renderTimeMs: number;
        queueWaitMs: number;
      }[] = [];
      const onEvent = options.onEvent;
      eventsFiber = Effect.runFork(
        Stream.runForEach(crawler.events, (event) =>
          Effect.sync(() => {
            // Forward event to callback if provided
            if (onEvent) {
              onEvent(event);
            }

            switch (event.type) {
              case "page:fetching": {
                // Surface the in-flight URL so a slow render upgrade (quick-mode
                // HTTP-first hybrid) reads as progress, not a frozen counter.
                let detail = event.url;
                try {
                  detail = new URL(event.url).pathname || event.url;
                } catch {
                  // keep the raw url
                }
                onProgress({
                  phase: "crawling",
                  current: pagesProcessed,
                  total: crawlerConfig.maxPages,
                  detail,
                });
                break;
              }
              case "page:fetched":
                if (
                  event.renderTimeMs !== undefined &&
                  event.queueWaitMs !== undefined
                ) {
                  renderTimingSamples.push({
                    renderTimeMs: event.renderTimeMs,
                    queueWaitMs: event.queueWaitMs,
                  });
                }
                pagesProcessed++;
                onProgress({
                  phase: "crawling",
                  current: pagesProcessed,
                  total: crawlerConfig.maxPages,
                });
                break;
              case "page:failed":
              case "page:unchanged":
                pagesProcessed++;
                onProgress({
                  phase: "crawling",
                  current: pagesProcessed,
                  total: crawlerConfig.maxPages,
                });
                break;
              case "progress":
                pagesProcessed =
                  event.fetched +
                  event.failed +
                  event.skipped +
                  (event.unchanged ?? 0);
                onProgress({
                  phase: "crawling",
                  current: pagesProcessed,
                  total: crawlerConfig.maxPages,
                });
                break;
            }
          })
        )
      );

      // Check for existing crawl to determine resume vs new crawl
      const baseUrl = new URL(finalUrl).origin;
      const existingCrawl = await Effect.runPromise(
        storage.getCrawlByUrl(baseUrl)
      );

      // Resume decision logic
      const shouldResume =
        options.resume && // User explicitly requested resume
        !!existingCrawl &&
        !options.refresh && // Can't resume if refresh requested
        // "stopped" = interrupted mid-frontier by the crawl-phase backstop
        // (#969); the frontier still has pending URLs, so resume continues it.
        (existingCrawl.status === "running" ||
          existingCrawl.status === "paused" ||
          existingCrawl.status === "stopped") &&
        !isDirtyConfig(existingCrawl.config, crawlerConfig);

      // Crawl-phase wall-clock backstop: a wedged fetch (e.g. a cloud render
      // that never returns) must never hang the audit. On expiry stop the
      // crawler and continue with whatever pages were collected. The per-URL
      // watchdog inside the crawler does the real self-heal; this is the cap.
      // If it somehow fires during start()'s init (robots/sitemap, before the
      // pool), stop() just sets isRunning=false and the crawl ends with 0 pages
      // → the "no pages collected" branch below reports it clearly. Safe.
      const crawlPhaseTimeoutMs = resolveCrawlPhaseTimeoutMs(
        options,
        crawlerConfig.maxPages,
        crawlConcurrency.concurrency
      );
      let crawlPhaseStopped = false;
      let crawlPhaseTimer: ReturnType<typeof setTimeout> | undefined;
      if (crawlPhaseTimeoutMs) {
        crawlPhaseTimer = setTimeout(() => {
          crawlPhaseStopped = true;
          logger.warn(
            "crawl phase timed out",
            `stopping after ${Math.round(crawlPhaseTimeoutMs / 1000)}s — continuing with collected pages`
          );
          // Fire-and-forget; guard against a synchronous throw from stop()/
          // runPromise so it can never escape the timer callback.
          try {
            void Effect.runPromise(crawler.stop()).catch(() => {});
          } catch {
            // already stopping / shutting down
          }
        }, crawlPhaseTimeoutMs);
      }

      let crawlId: string;
      try {
        if (shouldResume) {
          // Resume interrupted crawl
          logger.info(`resuming interrupted crawl ${existingCrawl.id}`);
          await Effect.runPromise(crawler.resumeFromStorage(existingCrawl.id));
          crawlId = existingCrawl.id;
        } else {
          // Create new crawl
          // Warn if resume conditions not met
          if (options.resume && !existingCrawl) {
            logger.warn("--resume requested but no previous crawl found");
          } else if (
            options.resume &&
            existingCrawl &&
            existingCrawl.status === "completed"
          ) {
            logger.warn(
              "--resume requested but previous crawl completed, starting new"
            );
          } else if (
            options.resume &&
            existingCrawl &&
            isDirtyConfig(existingCrawl.config, crawlerConfig)
          ) {
            logger.warn("--resume requested but config changed, starting new");
          } else if (options.resume && options.refresh) {
            logger.warn(
              "--resume and --refresh are mutually exclusive, using --refresh"
            );
          }

          // Log reason for new crawl
          if (options.refresh) {
            logger.debug("refresh requested, starting new crawl");
          } else if (!existingCrawl) {
            logger.debug("first crawl for domain");
          } else if (
            existingCrawl &&
            isDirtyConfig(existingCrawl.config, crawlerConfig)
          ) {
            logger.debug("config changed, starting fresh crawl");
          } else {
            logger.debug("starting new crawl (previous completed)");
          }

          crawlId = await Effect.runPromise(crawler.start(finalUrl, url));
        }
      } finally {
        if (crawlPhaseTimer) clearTimeout(crawlPhaseTimer);
      }

      // Show redirect if it occurred (user chose to show all redirects)
      const crawlMeta = await Effect.runPromise(storage.getCrawl(crawlId));
      if (
        crawlMeta?.originalUrl &&
        crawlMeta?.seedUrl &&
        crawlMeta.originalUrl !== crawlMeta.seedUrl
      ) {
        logger.info(
          `Following redirect: ${crawlMeta.originalUrl} → ${crawlMeta.seedUrl}`
        );
      }

      // Update status to "crawled"
      await Effect.runPromise(
        storage.updateCrawl(crawlId, { status: "crawled" })
      );

      // ============================================
      // BUILD SITE CONTEXT (parse once, use everywhere)
      // ============================================
      logger.debug("building site context", crawlId);
      const pages = await Effect.runPromise(
        storage
          .getPages(crawlId)
          .pipe(Effect.catchAll(() => Effect.succeed([])))
      );

      // If the crawl phase was force-stopped by the wall-clock backstop and
      // produced nothing, fail with a clear reason instead of analyzing an
      // empty site (which would surface as confusing all-pass/zero results).
      if (crawlPhaseStopped && pages.length === 0) {
        throw new Error(
          `Crawl phase timed out after ${Math.round((crawlPhaseTimeoutMs ?? 0) / 1000)}s with no pages collected`
        );
      }
      if (crawlPhaseStopped) {
        logger.warn(
          "partial crawl",
          `analyzing ${pages.length} page(s) collected before the crawl-phase timeout`
        );
      }

      const siteContext = await Effect.runPromise(
        buildSiteContext(pages, parsedPageCache)
      ).finally(() => {
        // siteContext owns the reused DOMs now; drop crawl-time refs on any path
        parsedPageCache.clear();
      });
      phaseTimer.mark("crawl");

      // Queue-wait vs render-time breakdown for the crawl just finished
      // (#826) — tells cloud render latency apart as browser-pool queueing
      // vs actual render cost. Debug-only; absent entirely on an all-HTTP
      // crawl (no rendered-page samples).
      const renderTimingSummary = summarizeRenderTimings(renderTimingSamples);
      if (renderTimingSummary) {
        logger.debug(
          "render timing (queue-wait vs render)",
          renderTimingSummary
        );
      }

      // ============================================
      // STEP 1.5: CHECK EXTERNAL LINKS
      // ============================================
      if (mergedConfig.external_links.enabled) {
        phaseTimer.enter("external_links");
        logger.debug("step 1.5: checking external links", crawlId);
        onProgress({ phase: "external-links" });

        // Cloud bulk dead-link checks (shared global cache) when authed and
        // the links/dead-links rule is enabled; null → plain local checking.
        // Gated behind the SAME spend confirmation as STEP 2.4 prefetch so the
        // dead_links charge (which happens here, before that confirm) can't be
        // a surprise: when the estimate exceeds [cloud].confirm_threshold and a
        // TTY confirm callback exists, the user is prompted first; a decline
        // falls back to local per-link checks.
        const deadLinksClient =
          options.cloudAvailable === false || isQuickMode
            ? null
            : createCloudClientFromSettings();
        const bulkChecker = await resolveDeadLinksBulkChecker({
          client: deadLinksClient,
          config: mergedConfig,
          auditId: crawlId,
          siteContext,
          getBalance: deadLinksClient
            ? async () => (await deadLinksClient.getBalance()).balance.total
            : undefined,
          confirm: options.confirmCloudSpend,
          onSpend: (units, credits) => {
            deadLinksUnits += units;
            deadLinksCredits += credits;
          },
        });

        await Effect.runPromise(
          checkExternalLinksOnStorage(
            storage,
            crawlId,
            siteContext,
            mergedConfig.external_links,
            (progress) => {
              logger.debug(
                "external links",
                `${progress.checked}/${progress.total}`,
                `(${progress.fromCache} cached)`
              );
              onProgress({
                phase: "external-links",
                current: progress.checked,
                total: progress.total,
              });
            },
            bulkChecker ?? undefined
          )
        );
        phaseTimer.mark("external_links");
      }

      // ============================================
      // STEP 2: FETCH RESOURCE ASSETS
      // ============================================
      phaseTimer.enter("assets");
      logger.debug("step 2: fetching resource assets", crawlId);
      onProgress({ phase: "rules" });

      const assets = await Effect.runPromise(
        fetchResourceAssets(storage, crawlId, siteContext, mergedConfig, {
          resourceCheckMaxItems: options.resourceCheckMaxItems,
          resourceCheckTimeoutMs: options.resourceCheckTimeoutMs,
          // Sub-resource cache reuse (#107): mirrors the crawler's incremental flag.
          incremental: incrementalEnabled,
        })
      );
      phaseTimer.mark("assets");

      // ============================================
      // STEP 2.4: CLOUD PREFETCH (the only networked enrichment step)
      // ============================================
      let cloudResult: CloudPrefetchResult | null = null;
      if (
        mergedConfig.cloud.enabled &&
        options.cloudAvailable !== false &&
        !isQuickMode
      ) {
        phaseTimer.enter("cloud_prefetch");
        logger.debug("step 2.4: cloud prefetch", crawlId);
        onProgress({ phase: "cloud" });
        try {
          cloudResult = await runCloudPrefetch({
            client: createCloudClientFromSettings(),
            cloudConfig: mergedConfig.cloud,
            config: mergedConfig,
            siteContext,
            baseUrl: url,
            auditId: crawlId,
            // Stage-1 gating policy (CLI-owned): Stage-0 metadata gates which
            // downstream cloud features run before the per-audit cap.
            gate: gateStage1,
            // Consented users skip THIS confirm (capped + disclosed up front);
            // dead-links/tech/editor keep their gate below.
            confirm: options.cloudConsented
              ? undefined
              : options.confirmCloudSpend,
            onProgress: (detail) => onProgress({ phase: "cloud", detail }),
            // Skip the raw-vs-rendered `render` service only when the crawl rendered EVERY page — i.e. the
            // resolved fetcher is the full-render one ("cloud-render"), NOT the "auto" hybrid ("hybrid-http-
            // first", most pages raw) or plain HTTP (undefined). #673.
            crawlRendered: documentFetcher?.id === "cloud-render",
            // Payloads built → nothing reads the DOMs again until the rules
            // phase (which re-parses on demand). Drop them so the cloud round
            // trips don't idle a GB-scale working set (#858).
            onPayloadsBuilt: () => releaseSiteContextDocuments(siteContext),
          });
          logger.debug(
            "cloud prefetch done",
            `spent=${cloudResult.totalSpent}`,
            `services=${cloudResult.spend.length}`
          );
        } catch (error) {
          // Defends the never-fail-the-audit invariant against anything the
          // prefetch path (incl. caller-supplied confirm/onProgress callbacks)
          // might throw. Rules see no store → skipped not-prefetched.
          cloudResult = null;
          logger.warn(
            `Cloud prefetch failed; continuing without cloud analysis: ${(error as Error).message}`
          );
        }
        phaseTimer.mark("cloud_prefetch");
      }

      // ============================================
      // STEP 2.6: CLOUD TECHNOLOGIES (report-only, credited; never-fail)
      // ============================================
      if (
        mergedConfig.cloud.enabled &&
        options.cloudAvailable !== false &&
        !isQuickMode &&
        mergedConfig.cloud.technologies
      ) {
        phaseTimer.enter("tech_detect");
        logger.debug("step 2.6: cloud tech-detect", crawlId);
        const techClient = createCloudClientFromSettings();
        techResult = await runCloudTechDetect({
          client: techClient,
          config: mergedConfig,
          auditId: crawlId,
          baseUrl: url,
          siteContext,
          scripts: assets.scripts,
          getBalance: techClient
            ? async () => (await techClient.getBalance()).balance.total
            : undefined,
          confirm: options.confirmCloudSpend,
          onProgress: (detail) => onProgress({ phase: "cloud", detail }),
          onSpend: (credits) => {
            techDetectCredits += credits;
          },
        });
        phaseTimer.mark("tech_detect");
      }

      // ============================================
      // STEP 2.5: RUN RULES (zero HTTP — uses pre-fetched assets)
      // ============================================
      phaseTimer.enter("rules");
      logger.debug("step 2.5: analyzing", crawlId);

      // Thread cloud results + the resolved Stage-0 profile into the rules phase
      // per audit run — no process-global singleton. The metadata drives
      // `appliesWhen` rule gating; undefined = run as today.
      const rulesEffect = runRulesOnStorage(
        storage,
        crawlId,
        siteContext,
        mergedConfig,
        assets,
        {
          cloudResults: cloudResult?.store,
          siteMetadata: cloudResult?.siteMetadata ?? undefined,
        }
      );
      const rulesPhaseTimeoutMs = options.rulesPhaseTimeoutMs;
      let ruleResults: Effect.Effect.Success<typeof rulesEffect>;
      ruleResults = rulesPhaseTimeoutMs
        ? await Effect.runPromise(
            Effect.timeoutFail(rulesEffect, {
              duration: Duration.millis(rulesPhaseTimeoutMs),
              onTimeout: () =>
                new Error(
                  `Rules phase timed out after ${Math.round(rulesPhaseTimeoutMs / 1000)}s`
                ),
            })
          )
        : await Effect.runPromise(rulesEffect);

      // Batch all rule results into one transaction (mirrors analyze.ts:309),
      // instead of a separate txn per (page, rule) pair.
      type RuleEntry = {
        ruleId: string;
        checks: import("@/types").CheckResult[];
      };
      const batchResults = new Map<string, RuleEntry[]>();
      for (const [url, ruleChecksMap] of ruleResults.pageRuleResults) {
        batchResults.set(
          url,
          Array.from(ruleChecksMap, ([ruleId, checks]) => ({ ruleId, checks }))
        );
      }
      const siteResultsList = Array.from(
        ruleResults.siteRuleResults,
        ([ruleId, checks]) => ({
          ruleId,
          checks,
        })
      );
      if (siteResultsList.length > 0) {
        batchResults.set("", siteResultsList);
      }

      if ("saveRuleResultsBatch" in storage) {
        await Effect.runPromise(
          (
            storage as import("@/crawler/storage/sqlite").SQLiteStorage
          ).saveRuleResultsBatch(crawlId, batchResults)
        );
      } else {
        for (const [url, results] of batchResults) {
          for (const { ruleId, checks } of results) {
            await Effect.runPromise(
              storage.saveRuleResults(crawlId, url, ruleId, checks)
            );
          }
        }
      }

      const resourceRecords = [
        ...ruleResults.resourceSizes.css.map((entry) => ({
          type: "css" as const,
          ...entry,
        })),
        ...ruleResults.resourceSizes.images.map((entry) => ({
          type: "image" as const,
          ...entry,
        })),
      ];
      await Effect.runPromise(
        storage.saveResourceSizes(crawlId, resourceRecords)
      );
      await Effect.runPromise(
        storage.saveSitemapUrlStatuses(crawlId, ruleResults.sitemapUrlStatuses)
      );

      // Update status to "analyzed"
      await Effect.runPromise(
        storage.updateCrawl(crawlId, { status: "analyzed" })
      );
      phaseTimer.mark("rules");

      // ============================================
      // STEP 2.7: SMART AUDITS (#110; #684: default ON signed-in, OFF anon/config-off)
      // ============================================
      // Merge this run into the site-scoped finding store, carry forward issues
      // on un-crawled pages, supersede re-crawled ones, stale 404/410, and score
      // over the UNION so a partial re-audit never inflates the score. Flag OFF
      // (the default) → this block is skipped and the report path is unchanged.
      let smartMerge:
        | import("@/reports/reconstruct").SmartMergeOverride
        | undefined;
      if (mergedConfig.smart_audits) {
        phaseTimer.enter("smart_merge");
        logger.debug("step 2.7: smart audits merge", crawlId);
        try {
          smartMerge = await Effect.runPromise(
            runSmartAudits({
              storage,
              crawlId,
              siteKey: baseUrl,
              ruleResults,
              pages: pages.map((p) => ({
                normalizedUrl: p.normalizedUrl,
                status: p.status,
              })),
            })
          );
        } catch (error) {
          // Never fail the audit on a merge error — degrade to the normal path.
          smartMerge = undefined;
          logger.warn(
            `Smart audits merge failed; reporting this run only: ${(error as Error).message}`
          );
        }
        phaseTimer.mark("smart_merge");
      }

      // ============================================
      // STEP 3: GENERATE REPORT (from DB, includes pageUrl on checks)
      // ============================================
      phaseTimer.enter("report");
      logger.debug("step 3: generating report", crawlId);

      const report = await Effect.runPromise(
        reconstructReport(
          storage as import("@/crawler/storage/sqlite").SQLiteStorage,
          crawlId,
          smartMerge
        )
      );

      // Scan scope disclosure (#1180): stamp where this audit ran and how much
      // it crawled so every surface (console, report, dashboard) renders the
      // score with its basis. REPORT-ONLY.
      {
        const scopeMaxPages = mergedConfig.crawler.max_pages;
        report.scanScope = {
          origin: detectRunner().ci ? "ci" : "cli",
          maxPages: scopeMaxPages,
          pagesCrawled: report.pages.length,
          capped: report.pages.length >= scopeMaxPages,
        };
      }

      // Report-only technologies section (never affects the health score).
      // Cloud tech-detect (credited, cross-scan diff) wins; otherwise fall back to
      // a free local scan so quick/logged-out audits still surface the stack (#407).
      if (techResult) {
        report.technologies = techResult.technologies;
      } else {
        const localTech = detectLocalTechnologies({
          baseUrl: url,
          siteContext,
          scripts: assets.scripts,
        });
        if (localTech) report.technologies = localTech;
      }

      // Persist the resolved Stage-0 profile for explainability — it records
      // which cloud features + rules applied this run. Report-only / non-scoring.
      if (cloudResult?.siteMetadata)
        report.siteMetadata = cloudResult.siteMetadata;
      phaseTimer.mark("report");

      // ============================================
      // STEP 3.1: CLOUD EDITOR'S SUMMARY (credited, report-only)
      // ============================================
      // Runs AFTER the report is built — it needs category scores + ranked
      // issues + the resolved site profile. The credit charge is
      // enforced server-side; the CLI degrades silently (logged out / no
      // credits → no summary). Never fails the audit.
      if (
        mergedConfig.cloud.enabled &&
        options.cloudAvailable !== false &&
        !isQuickMode &&
        mergedConfig.cloud.editor_summary
      ) {
        phaseTimer.enter("editor_summary");
        logger.debug("step 3.1: cloud editor-summary", crawlId);
        const summaryClient = createCloudClientFromSettings();
        const summaryResult = await runCloudEditorSummary({
          client: summaryClient,
          config: mergedConfig,
          auditId: crawlId,
          report,
          getBalance: summaryClient
            ? async () => (await summaryClient.getBalance()).balance.total
            : undefined,
          confirm: options.confirmCloudSpend,
          onProgress: (detail) => onProgress({ phase: "cloud", detail }),
          onSpend: (credits) => {
            editorSummaryCredits += credits;
          },
        });
        if (summaryResult) report.editorSummary = summaryResult.editorSummary;
        phaseTimer.mark("editor_summary");
      }

      // ============================================
      // STEP 3.2: CLOUD DOMAIN STATS (credited, report-only)
      // ============================================
      // Backlink summary + traffic + keyword distribution from ONE DataForSEO
      // whois/overview lookup. The credit charge + 30-day cache are
      // enforced server-side; the CLI degrades silently (logged out / no
      // credits / no data → no section). Never fails the audit.
      if (
        mergedConfig.cloud.enabled &&
        options.cloudAvailable !== false &&
        !isQuickMode &&
        mergedConfig.cloud.domain_stats
      ) {
        phaseTimer.enter("domain_stats");
        logger.debug("step 3.2: cloud domain-stats", crawlId);
        const statsClient = createCloudClientFromSettings();
        const statsResult = await runCloudDomainStats({
          client: statsClient,
          config: mergedConfig,
          auditId: crawlId,
          baseUrl: url,
          getBalance: statsClient
            ? async () => (await statsClient.getBalance()).balance.total
            : undefined,
          confirm: options.confirmCloudSpend,
          onProgress: (detail) => onProgress({ phase: "cloud", detail }),
          onSpend: (credits) => {
            domainStatsCredits += credits;
          },
        });
        if (statsResult) report.domainStats = statsResult.domainStats;
        phaseTimer.mark("domain_stats");
      }

      // Merge ALL cloud spend for this audit: render submits (charged per
      // page during the crawl), dead-links bulk calls (charged during the
      // external-links phase), and the prefetch services. Server-refunded
      // calls (total provider failures) are never counted — each counter only
      // increments on a successful, charged call.
      const spendLines = [
        // render misses + render_cached hits, at the actual server debit #279.
        ...foldRenderSpendLines(renderCharges),
        ...(deadLinksUnits > 0
          ? [
              {
                service: "dead-links",
                feature: "dead_links",
                units: deadLinksUnits,
                // Accumulated per call — the server rounds ceil(urls/100)
                // per call, so recomputing from total units would undercount.
                credits: deadLinksCredits,
              },
            ]
          : []),
        ...(techDetectCredits > 0
          ? [
              {
                service: "tech-detect",
                feature: "tech_detect",
                units: 1,
                credits: techDetectCredits,
              },
            ]
          : []),
        ...(editorSummaryCredits > 0
          ? [
              {
                service: "editor-summary",
                feature: "editor_summary",
                units: 1,
                credits: editorSummaryCredits,
              },
            ]
          : []),
        ...(domainStatsCredits > 0
          ? [
              {
                service: "domain-stats",
                feature: "domain_stats",
                units: 1,
                credits: domainStatsCredits,
              },
            ]
          : []),
        ...(cloudResult?.spend ?? []),
      ];
      const totalSpent = spendLines.reduce((sum, l) => sum + l.credits, 0);
      if (totalSpent > 0) {
        report.cloudSpend = {
          lines: spendLines,
          totalSpent,
          // Render + dead-links debits land BEFORE the prefetch preflight
          // reads the balance, so its estimate already reflects them.
          balanceAfter: cloudResult?.balanceAfter ?? null,
        };
      }

      // Surface failed cloud calls: a failed batch is uncharged AND produces
      // no spend line, so without this the run looks fine while coverage is
      // silently partial (the nytimes 40-page incident).
      if (cloudResult && cloudResult.failures.length > 0) {
        report.cloudFailures = cloudResult.failures.map((f) => ({
          service: f.service,
          failedUnits: f.failedUnits,
          attemptedUnits: f.attemptedUnits,
          failedBatches: f.failedBatches,
          detail: f.detail,
        }));
      }

      logger.debug("audit complete", `pages=${report.pages.length}`);

      // #857: report.phaseTimingsMs so bench-audit.ts / callers can read the
      // breakdown programmatically; `publish` (outside this function, in the
      // CLI command layer) is merged in by that caller before it forwards this
      // map to telemetry.
      report.phaseTimingsMs = phaseTimer.timingsMs;
      logger.debug("phase timings", formatPhaseTimings(phaseTimer.timingsMs));

      onProgress({
        phase: "complete",
        current: report.pages.length,
        total: report.pages.length,
      });

      return ok(report);
    } finally {
      // Clean up event subscription fiber if it was started
      if (eventsFiber) {
        await Effect.runPromise(Fiber.interrupt(eventsFiber));
      }
      await Effect.runPromise(storage.close());
    }
  } catch (error) {
    // Whatever phases completed before the failure — cheap, and often the
    // whole point (e.g. a wedged crawl phase that never reached rules).
    // attributeInFlight() covers a crash INSIDE the in-flight phase itself
    // (the common case — a wedged crawl fetch never reaches its own mark()
    // call), which is exactly the field case that motivated #857/#871.
    phaseTimer.attributeInFlight();
    logger.debug("phase timings", formatPhaseTimings(phaseTimer.timingsMs));
    logger.debug("audit error", error);
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Audit failed: ${(error as Error).message}`,
        // #871: the same partial breakdown logged above, plumbed through the
        // error result so the CLI command layer can still forward it to
        // agent-runs config telemetry — a failed run has no `report` object
        // (the success path's carrier for phaseTimingsMs), so `details` is
        // the only channel out of this function on the error path.
        Object.keys(phaseTimer.timingsMs).length > 0
          ? ({
              phaseTimingsMs: phaseTimer.timingsMs,
            } satisfies AuditFailureDetails)
          : undefined
      )
    );
  }
}

/**
 * Merge CLI options into config
 */
export function mergeOptionsToConfig(
  config: Config,
  options: RunAuditOptions
): Config {
  const nextExternalLinks = {
    ...config.external_links,
    ...(typeof options.externalLinksEnabled === "boolean"
      ? { enabled: options.externalLinksEnabled }
      : {}),
    ...(typeof options.externalLinksConcurrency === "number"
      ? {
          concurrency: Math.max(
            1,
            Math.floor(options.externalLinksConcurrency)
          ),
        }
      : {}),
    ...(typeof options.externalLinksTimeoutMs === "number"
      ? {
          timeout_ms: Math.max(
            1000,
            Math.floor(options.externalLinksTimeoutMs)
          ),
        }
      : {}),
  };

  return {
    ...config,
    // Smart audits (#684): the command resolves signed-in → on / anon → off and
    // passes an explicit boolean; when unset, keep whatever config declared.
    smart_audits: options.smartAudits ?? config.smart_audits,
    // --rule-include/--rule-exclude (#1066): same merge the CLI command uses to
    // pre-validate --fail-on against excluded categories (resolveRulesConfig).
    rules: resolveRulesConfig(config.rules, {
      enable: options.ruleInclude ?? [],
      disable: options.ruleExclude ?? [],
    }),
    crawler: {
      ...config.crawler,
      max_pages: Math.min(
        options.maxPages ?? config.crawler.max_pages,
        MAX_PAGES_CAP
      ),
      ...(typeof options.maxDepth === "number"
        ? { max_depth: Math.max(1, Math.floor(options.maxDepth)) }
        : {}),
      ...(typeof options.crawlerTimeoutMs === "number"
        ? { timeout_ms: Math.max(1000, Math.floor(options.crawlerTimeoutMs)) }
        : {}),
      // CLI --concurrency / --per-host override [crawler] knobs (#1068);
      // validated positive in the command layer, floored here belt-and-suspenders.
      ...(typeof options.concurrency === "number"
        ? { concurrency: Math.max(1, Math.floor(options.concurrency)) }
        : {}),
      ...(typeof options.perHostConcurrency === "number"
        ? {
            per_host_concurrency: Math.max(
              1,
              Math.floor(options.perHostConcurrency)
            ),
          }
        : {}),
      // CLI --header values override matching [crawler] headers from TOML (#494).
      ...(options.headers && Object.keys(options.headers).length > 0
        ? { headers: { ...config.crawler.headers, ...options.headers } }
        : {}),
    },
    // --offline promises no network beyond the audited site itself, so
    // external-link probing (fetches to third-party URLs) is disabled too.
    external_links: options.offline
      ? { ...nextExternalLinks, enabled: false }
      : nextExternalLinks,
    // --offline forces cloud off regardless of config/flags: no prefetch, no
    // bulk dead-link checks, no browser rendering (resolveDocumentFetcher
    // checks cloud.enabled first).
    cloud: options.offline
      ? { ...config.cloud, enabled: false }
      : {
          ...config.cloud,
          ...(options.cloudRendering
            ? { rendering: options.cloudRendering }
            : {}),
        },
  };
}
