// squirrelscan audit <url> - CLI wrapper

import type { ReportBranding } from "@squirrelscan/core-contracts";

import { CloudClientError } from "@squirrelscan/cloud-client";
import {
  auditStatusToLifecycle,
  computeCost,
} from "@squirrelscan/core-contracts";
import { fullScanHint } from "@squirrelscan/report";
import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { platform } from "node:os";

import type { AuditFailureDetails, CrawlerEvent } from "@/controllers/audit";
import type { UserSettings } from "@/self/types";
import type { AuditOptions } from "@/types";

import {
  normalizeFailOnArgs,
  parseFailOn,
  evaluateFailOn,
  formatFailOnSummary,
} from "@/audit/fail-on";
import {
  normalizeHeaderArgs,
  parseHeaders,
  redactHeaders,
} from "@/audit/headers";
import {
  generateConsoleReport,
  generateTextReport,
  generateJsonReport,
  generateHtmlReport,
  generateMarkdownReport,
  generateXmlReport,
  generateLlmReport,
} from "@/audit/report";
import {
  filterResolvesToZeroCategories,
  isCategoryExcluded,
  parseRuleFilters,
  resolveRulesConfig,
} from "@/audit/rule-filter";
import { findConfigFile, getGlobalConfigPath, loadConfig } from "@/config";
import {
  DASHBOARD_URL,
  MAX_PAGES_CAP,
  MAX_CRAWL_CONCURRENCY,
  COVERAGE_QUICK_MAX_PAGES,
  COVERAGE_SURFACE_MAX_PAGES,
  COVERAGE_FULL_MAX_PAGES,
  STATUS_REQUEST_TIMEOUT_MS,
} from "@/constants";
import { runAudit } from "@/controllers/audit";
import {
  publishReport,
  savePublishedReportInfo,
  type ReportVisibility,
} from "@/controllers/report/publish";
import {
  createRunFinalizer,
  type FinalizeRunInput,
  markRunning,
  registerRun,
  reportProgress,
  type RegisteredRun,
  resolveRunFinalizeScore,
} from "@/lib/run-tracker";
import { syncTechnologies } from "@/lib/technology-sync";
import { getApiUrl } from "@/self/api";
import {
  API_TOKEN_ENV_VAR,
  activeEnvTokenVar,
  describeEnvToken,
  envTokenRejectedMessage,
  getEnvApiToken,
  warnIfSessionUnreadable,
} from "@/self/credentials";
import { detectRunner } from "@/self/install-meta";
import {
  loadUserSettings,
  loadSettings,
  updateSettings,
} from "@/self/settings";
import { trackTelemetryEvent, trackError } from "@/self/telemetry";
import { safeExit } from "@/self/updater";
import { configureLogger, logger, setLogInterceptor } from "@/utils/logger";
import { getProjectNameContext, parseUserUrl } from "@/utils/url";

import { version as packageVersion } from "../../../package.json";
import {
  printHeader,
  printUpdateNotification,
  printEndOfRunUpdateReminder,
  shouldShowAutoUpdateDisabledReminder,
  printAutoUpdateDisabledReminder,
  promptForUpdate,
  printFooter,
  printAutoUpdateAppliedNotice,
  lockedRulesFooterLine,
} from "../banner";
import {
  COVERAGE_MODES,
  coverageMaxPages,
  defaultCoverageMode,
  defaultSmartAudits,
  normalizeCoverageMode,
} from "../coverage";
import { printDatabaseLockWarningIfNeeded } from "../db-lock-warning";
import { fmt, pageLimitHint } from "../format";
import { createProgress } from "../progress";
import { promptForProjectName } from "../prompt";
import { pickTip, shouldShowTip, tipLabel } from "../tips";

/** Operator-facing labels for cloud services in coverage warnings. */
const CLOUD_SERVICE_LABELS: Record<string, string> = {
  "ai-parse": "AI analysis",
  "authority-signals": "Authority analysis",
  "blocklist-check": "Blocklist check",
  "keyword-gaps": "Keyword gap analysis",
  "content-gaps": "Content gap analysis",
};

/** Up-front estimate shown in the one-time cloud-consent prompt. */
export interface CloudConsentEstimate {
  maxPages: number;
  balance: number | null;
  maxCredits: number;
}

/** The single up-front spend disclosure (pricing v10): flat audit base + render
 * rate × page ceiling, everything else included. Accepting it skips the later
 * post-crawl prompt. */
export function consentEstimateLine(est: CloudConsentEstimate): string {
  const base = computeCost("audit_base", 1);
  const renderEst = computeCost("render", est.maxPages);
  const cap =
    est.maxCredits > 0 ? `, up to ${est.maxCredits} credits/audit` : "";
  const bal =
    est.balance != null
      ? ` Balance: ${est.balance.toLocaleString("en-US")} credits.`
      : "";
  const pages = est.maxPages === 1 ? "page" : "pages";
  return `About ${base + renderEst} credits: ${base} audit base + ${renderEst} to render up to ${est.maxPages} ${pages}, all analysis included${cap}.${bal}`;
}

/** #1169 preflight affordability estimate + warning copy. */
export interface PreflightAffordability {
  /** Flat audit base (pricing v10). */
  base: number;
  /** Up-to-maxPages render cost — 0 when cloud rendering is off. */
  renderCost: number;
  /** base + renderCost — an UPPER bound (the crawl may find fewer pages). */
  estimate: number;
  /** balance < estimate → the org can't cover the planned audit. */
  shortfall: boolean;
  /** Two-line (uncoloured) warning when `shortfall`, else empty. */
  warningLines: string[];
}

/**
 * #1169: predict a signed-in audit's up-front cost and whether the balance falls
 * short. A signed-in audit debits the flat base at register + a per-rendered-page
 * charge as pages render (render charge only when cloud rendering is on), so the
 * cost is trivially predictable: `base + min(maxPages) × render`. Pricing comes
 * from the shared v10 source, never hardcoded. Extracted from the command body so
 * the estimate math + message copy are unit-testable (mirrors consentEstimateLine).
 */
export function computePreflightAffordability(opts: {
  balance: number;
  maxPages: number;
  cloudRendering: "http" | "browser";
  topUpUrl: string;
}): PreflightAffordability {
  const base = computeCost("audit_base", 1);
  const renderCost =
    opts.cloudRendering === "browser"
      ? computeCost("render", opts.maxPages)
      : 0;
  const estimate = base + renderCost;
  const shortfall = opts.balance < estimate;
  const warningLines = shortfall
    ? [
        `⚠ This audit may cost up to ${estimate.toLocaleString("en-US")} credits ` +
          `(${base} base + up to ${renderCost.toLocaleString("en-US")} to render ${opts.maxPages} pages), ` +
          `but your balance is ${opts.balance.toLocaleString("en-US")}.`,
        `  Charging stops when credits run out — later pages won't render. Top up: ${opts.topUpUrl}`,
      ]
    : [];
  return { base, renderCost, estimate, shortfall, warningLines };
}

/**
 * #1169: whether to interactively prompt on a preflight shortfall. Requires BOTH
 * stdin AND stdout to be TTYs (a piped/redirected stdin makes readline hit EOF →
 * resolve false → a silent abort, so a non-interactive stdin must fall through to
 * warn-and-continue), and no `--yes`. Mirrors the coverage-mode / cloud-outage
 * prompts in this file (the older confirmCloudSpend checks stdout only — that
 * drift is tracked in #1171).
 */
export function preflightPromptEligible(opts: {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  yes: boolean;
}): boolean {
  return opts.stdinIsTTY && opts.stdoutIsTTY && !opts.yes;
}

/**
 * Extracts the partial phase-timing breakdown runAudit() attaches to a failed
 * result's CommandError.details (#871) — undefined when no phase completed
 * before the failure, or on any other error shape. Exported for tests.
 */
export function phaseTimingsFromError(
  details: unknown
): Record<string, number> | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const candidate = (details as AuditFailureDetails).phaseTimingsMs;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !Object.values(candidate).every(
      (ms) => typeof ms === "number" && Number.isFinite(ms)
    )
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * The post-audit cloud-spend disclosure line: total + per-service breakdown +
 * remaining balance. The breakdown reflects the ACTUAL server charges (pricing
 * v10: audit base + renders; folded services charge nothing). Exported for
 * tests. #279
 */
export function formatCloudSpendSummary(spend: {
  lines: Array<{ service: string; credits: number }>;
  totalSpent: number;
  balanceAfter: number | null;
}): string {
  const byService = spend.lines
    .map((l) => `${l.service} ${l.credits}`)
    .join(", ");
  const balance =
    spend.balanceAfter != null ? ` · balance ~${spend.balanceAfter}` : "";
  return `☁ Cloud credits used: ${spend.totalSpent} (${byService})${balance}`;
}

/** TTY guard when cloud is expected but unusable. true = proceed local-only,
 * false = cancel. Default (Enter) and stdin close/error both proceed. */
async function promptContinueLocalOnly(
  reason: "expired" | "unreachable"
): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const why =
    reason === "expired"
      ? "Your session has expired"
      : "The cloud API is unreachable";
  try {
    return await new Promise<boolean>((resolve) => {
      rl.on("close", () => resolve(true));
      rl.on("error", () => resolve(true));
      rl.question(
        `${why} — cloud features (renders, AI summary, tech detection) are unavailable.\nContinue with local-only checks? [Y/n] `,
        (answer) => {
          const a = answer.trim();
          resolve(a === "" || /^y(es)?$/i.test(a));
        }
      );
    });
  } finally {
    rl.close();
  }
}

export type RenderMode = "off" | "auto" | "all";

/**
 * Resolve the explicit render strategy from flags + config, or undefined to
 * fall back to the coverage-driven default (#294). Precedence (highest first):
 *   --render-mode  >  --render / --http  >  [cloud].render  >  [cloud].rendering
 * `off` → never render, `auto` → HTTP-first (render only CSR shells),
 * `all` → render every HTML page. Exported for tests.
 */
export function resolveExplicitRenderMode(
  args: { http?: boolean; render?: boolean; renderMode?: string },
  config: { cloud: { render?: RenderMode; rendering?: "http" | "browser" } }
): RenderMode | undefined {
  if (
    args.renderMode === "off" ||
    args.renderMode === "auto" ||
    args.renderMode === "all"
  ) {
    return args.renderMode;
  }
  if (args.http) return "off";
  if (args.render) return "all";
  if (config.cloud.render) return config.cloud.render;
  if (config.cloud.rendering === "http") return "off";
  if (config.cloud.rendering === "browser") return "all";
  return undefined;
}

/** Outcome of the cloud-rendering / consent resolution. */
export interface CloudRenderingDecision {
  mode: "http" | "browser";
  /** User accepted the cost-disclosing prompt AND a per-audit cap bounds it →
   * caller may skip the prefetch confirm. False for legacy/uncapped/--render. */
  consented: boolean;
}

/**
 * Resolve the crawl fetch mode for this run. Precedence:
 *   1. --http / --render flags (explicit, one-off)
 *   2. [cloud].rendering in config (explicit opt-in/out)
 *   3. auto — signed-in users default to cloud rendering. Login implies cloud
 *      consent (#368): no blocking prompt, even for --yes / non-TTY / CI. A
 *      prior explicit decline or a signed-out run stays on plain HTTP.
 * Returns the concrete mode plus whether blanket cloud-spend consent applies.
 */
export async function resolveCloudRendering(opts: {
  // `yes` is accepted but intentionally NOT read here (#368): login implies
  // consent, so --yes no longer forces plain HTTP. It's still consumed at the
  // command layer (the post-crawl spend confirm). Kept in the shape so the call
  // site can spread the raw citty args.
  args: { http?: boolean; render?: boolean; offline?: boolean; yes?: boolean };
  configRendering: "http" | "browser" | undefined;
  signedIn: boolean;
  consent: "accepted" | "declined" | null | undefined;
  /** Whether the user has acknowledged the spend disclosure (cloud_spend_ack). */
  spendAck?: boolean | null;
  log: (msg: string) => void;
  estimate: CloudConsentEstimate;
  /** Persist settings; injectable so tests don't touch the real settings file. */
  persist?: (updates: Partial<UserSettings>) => { ok: boolean };
}): Promise<CloudRenderingDecision> {
  const {
    args,
    configRendering,
    signedIn,
    consent,
    spendAck,
    log,
    estimate,
    persist = updateSettings,
  } = opts;

  // Skipping the prefetch confirm is only safe under a per-audit cap; an uncapped
  // run (cap = 0) keeps it. Baked into `consented` so no call site can forget it.
  const capped = estimate.maxCredits > 0;

  if (args.http) return { mode: "http", consented: false };
  if (args.render) return { mode: "browser", consented: false };
  if (configRendering === "http" || configRendering === "browser") {
    return { mode: configRendering, consented: false };
  }

  // auto: only signed-in, online runs default to cloud rendering.
  if (args.offline || !signedIn) return { mode: "http", consented: false };

  // A prior explicit decline is a standing opt-out — never silently flip a user
  // who said "no" back into spending. Re-enable with --render or [cloud]
  // rendering = "browser".
  if (consent === "declined") return { mode: "http", consented: false };

  // #368: login implies cloud consent. Signed-in runs render + prefetch by
  // default with NO blocking prompt — the per-audit credit cap + the post-run
  // "credits used" summary are the guardrails (replacing the old one-time
  // consent prompt). This holds for --yes / non-TTY / CI too. Opt out with
  // --http or [cloud] rendering = "http".
  //
  // Disclose the cost ONCE (gated on cloud_spend_ack) so the user sees it the
  // first time, then never again — non-blocking (printed, not prompted). On a
  // failed persist we keep the prefetch confirm this run and re-notify next run.
  // `consented` (skip the capped prefetch confirm) still requires a real cap; an
  // uncapped run keeps the confirm so unbounded spend is never silent.
  if (spendAck !== true) {
    log(
      fmt.dim(
        `Cloud audits are on for your account. ${consentEstimateLine(estimate)}${
          capped ? ` Disable with --http or [cloud] rendering = "http".` : ""
        }`
      )
    );
    const saved = persist({ cloud_spend_ack: true });
    if (!saved.ok) {
      logger.debug(
        "could not persist cloud_spend_ack; will re-notify next run"
      );
      return { mode: "browser", consented: false };
    }
  }
  return { mode: "browser", consented: capped };
}

/**
 * Decide whether to auto-publish this run's report to the dashboard.
 * Signed-in + online ⇒ publish unlisted by default; opt out per-run with
 * --no-publish/--offline or persistently via [cloud] publish = false.
 */
export function resolvePublishDecision(opts: {
  signedIn: boolean;
  offline: boolean;
  explicitPublish: boolean; // args.publish
  noPublish: boolean; // args["no-publish"]
  configPublish: boolean; // config.cloud.publish
  // #1066: a --rule-include/--rule-exclude run produces a partial report
  // (fewer categories, no partial marker on the publish payload yet — #1082
  // tracks that). Auto-publishing it would silently replace the site's full
  // report in the dashboard, so treat it like an implicit --no-publish
  // unless the user explicitly asks with --publish.
  ruleFilterActive?: boolean;
}): boolean {
  if (opts.offline) return false;
  if (opts.explicitPublish) return true; // explicit --publish overrides opt-outs (still needs login; publishReport errors otherwise)
  if (opts.ruleFilterActive) return false;
  if (opts.noPublish || !opts.configPublish) return false;
  return opts.signedIn; // default: publish when signed in
}

/**
 * Validate mutually-exclusive audit flags. Returns a human-readable error to
 * print (then exit 1), or null when the combination is valid.
 */
export function validateAuditFlags(args: {
  offline?: boolean;
  publish?: boolean;
  no_publish?: boolean;
  noPublish?: boolean;
  render?: boolean;
  http?: boolean;
}): string | null {
  const noPublish = args.no_publish || args.noPublish;
  // --offline conflicts with flags that require the cloud API.
  if (args.offline && (args.publish || args.render)) {
    const conflicting = args.publish ? "--publish" : "--render";
    return `--offline cannot be combined with ${conflicting} (requires login and cloud access)`;
  }
  // --no-publish (skip publishing) contradicts --publish (force publishing).
  if (noPublish && args.publish) {
    return "--no-publish cannot be combined with --publish";
  }
  // --render and --http are opposite overrides; refuse the contradiction
  // rather than silently picking one.
  if (args.render && args.http) {
    return "--render and --http cannot be combined";
  }
  return null;
}

/**
 * Parse + validate a positive-integer CLI flag (--concurrency / --per-host on
 * `audit` and `crawl`), clamping to MAX_CRAWL_CONCURRENCY (#1068). Returns
 * `undefined` when the flag wasn't passed, `null` to signal a validation
 * failure (caller should print nothing further and exit 1 — the error is
 * already printed here), or the parsed/clamped number.
 * Exported for reuse by `crawl` (#1084) and for tests.
 */
export function parsePositiveIntFlag(
  raw: string | undefined,
  label: string
): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(
      `${fmt.red("Error:")} ${label} must be a positive integer (got '${raw}').`
    );
    return null; // signal validation failure
  }
  if (parsed > MAX_CRAWL_CONCURRENCY) {
    logger.warn(
      `${label} clamped to ${MAX_CRAWL_CONCURRENCY} (max); got ${parsed}.`
    );
    return MAX_CRAWL_CONCURRENCY;
  }
  return parsed;
}

export const audit = defineCommand({
  meta: {
    name: "audit",
    description: "Run audit on a URL",
  },
  args: {
    url: {
      type: "positional",
      description: "URL to audit",
      required: true,
    },
    "max-pages": {
      type: "string",
      alias: "m",
      description: `Maximum pages to crawl (default: coverage mode — quick ${COVERAGE_QUICK_MAX_PAGES}, surface ${COVERAGE_SURFACE_MAX_PAGES}, full ${COVERAGE_FULL_MAX_PAGES}; cap ${MAX_PAGES_CAP})`,
    },
    "max-depth": {
      type: "string",
      description:
        "Maximum crawl depth from the seed (seed = 0; default: unlimited)",
    },
    concurrency: {
      type: "string",
      description:
        "Global crawl worker pool size (overrides [crawler] concurrency; suppresses the localhost fast path)",
    },
    "per-host": {
      type: "string",
      description:
        "Max concurrent requests per host (overrides [crawler] per_host_concurrency; suppresses the localhost fast path)",
    },
    coverage: {
      type: "string",
      alias: "C",
      description:
        "Coverage mode (default: quick if signed out, surface if signed in): quick (fast/local/free), surface (one per pattern), full (comprehensive)",
    },
    format: {
      type: "string",
      alias: "f",
      description:
        "Output format: console, text, json, html, markdown, xml, llm (default: console)",
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path",
    },
    refresh: {
      type: "boolean",
      alias: "r",
      description: "Ignore cache, fetch all pages fresh (full re-scan)",
    },
    "fresh-ua": {
      type: "boolean",
      description:
        "Re-roll this project's pinned random user-agent (the new one is pinned for later runs)",
    },
    incremental: {
      type: "boolean",
      description:
        "Re-scan changed pages via conditional GET (the default; use to override [crawler] incremental = false). --no-incremental or --refresh forces a full fetch",
    },
    resume: {
      type: "boolean",
      description: "Resume interrupted crawl for this domain",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Verbose output",
    },
    debug: {
      type: "boolean",
      description: "Enable debug logging",
    },
    trace: {
      type: "boolean",
      description: "Enable performance tracing to ~/.squirrel/logs/trace.log",
    },
    "project-name": {
      type: "string",
      alias: "n",
      description: "Project name (overrides config and prompts)",
    },
    publish: {
      type: "boolean",
      alias: "p",
      description:
        "Publish report to reports.squirrelscan.com (now the default when signed in)",
    },
    "no-publish": {
      type: "boolean",
      description:
        "Skip auto-publishing this run (stay online, just don't publish)",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Skip confirmation prompts; proceeds with cloud spend up to [cloud] max_credits_per_audit (default 1000)",
    },
    render: {
      type: "boolean",
      description:
        "Force cloud browser rendering for this run (alias of --render-mode all; uses credits; requires login)",
    },
    "render-mode": {
      type: "string",
      description:
        "Render strategy: off (HTTP only) | auto (render only client-rendered pages) | all (render every page). Overrides [cloud].render.",
    },
    http: {
      type: "boolean",
      description:
        "Force plain HTTP fetch for this run (alias of --render-mode off)",
    },
    offline: {
      type: "boolean",
      description:
        "Run fully offline: skip cloud features, publishing, and telemetry",
    },
    visibility: {
      type: "string",
      description:
        "Visibility for published reports: public, unlisted, private (default: unlisted)",
    },
    "fail-on": {
      type: "string",
      description:
        "Exit 2 when a threshold trips: score<90, score:perf<80, severity>=error, errors>0, warnings>0 (repeatable or comma-separated)",
    },
    header: {
      type: "string",
      alias: "H",
      description:
        'Custom HTTP header on every crawl request (repeatable), format "Name: Value"; merges over [crawler] headers. Values are secrets (redacted in output)',
    },
    "rule-include": {
      type: "string",
      description:
        "Only run these rule categories or rules (repeatable or comma-separated), e.g. ax,perf or core/meta-title. Replaces [rules] enable for this run",
    },
    "rule-exclude": {
      type: "string",
      description:
        "Skip these rule categories or rules (repeatable or comma-separated), e.g. images,social. Adds to [rules] disable for this run",
    },
    summary: {
      type: "boolean",
      description:
        "Print only the score, category breakdown, and issue counts — no per-issue detail (console format only)",
    },
  },
  async run({ args }) {
    // Configure logging before any output
    configureLogger({ debug: args.debug, trace: args.trace });

    const commandStart = Date.now();
    logger.commandStart("audit", {
      url: args.url,
      maxPages: args["max-pages"],
      format: args.format,
      output: args.output,
      refresh: args.refresh,
      verbose: args.verbose,
      debug: args.debug,
      trace: args.trace,
      cwd: process.cwd(),
      version: packageVersion,
      bunVersion: Bun.version,
      platform: platform(),
      arch: process.arch,
    });

    const flagError = validateAuditFlags({
      ...args,
      no_publish: args["no-publish"],
    });
    if (flagError) {
      console.error(flagError);
      process.exitCode = 1;
      return;
    }

    // Parse --fail-on early so a malformed expression fails before crawling.
    // citty accumulates repeated string flags into an array at runtime (see
    // toVal in citty/dist) even though its type says `string`, so widen the cast.
    const failOn = parseFailOn(
      normalizeFailOnArgs(args["fail-on"] as string | string[] | undefined)
    );
    if (failOn.errors.length > 0) {
      for (const e of failOn.errors) console.error(e);
      process.exitCode = 1;
      return;
    }

    // Parse --header early so a malformed spec fails before crawling. citty
    // accumulates the repeated flag into an array (same widening as --fail-on).
    const headerParse = parseHeaders(
      normalizeHeaderArgs(args.header as string | string[] | undefined)
    );
    if (headerParse.errors.length > 0) {
      for (const e of headerParse.errors) console.error(e);
      process.exitCode = 1;
      return;
    }
    const customHeaders = headerParse.headers;

    // Parse --rule-include/--rule-exclude early so an unknown category fails
    // before crawling (same widening as --fail-on/--header). #1066
    const ruleFilter = parseRuleFilters(
      args["rule-include"] as string | string[] | undefined,
      args["rule-exclude"] as string | string[] | undefined
    );
    if (ruleFilter.errors.length > 0) {
      for (const e of ruleFilter.errors) console.error(e);
      process.exitCode = 1;
      return;
    }
    const ruleFilterActive =
      ruleFilter.enable.length > 0 || ruleFilter.disable.length > 0;

    // --summary is console-only (#1067) — a machine format has no per-issue
    // detail to trim, so a non-console format + --summary is a user error.
    if (args.summary && args.format && args.format !== "console") {
      console.error(
        `--summary only applies to console output, got --format ${args.format}`
      );
      process.exitCode = 1;
      return;
    }

    let commandResult: "success" | "error" = "success";
    const settings = loadUserSettings();
    const effectiveSettings = settings.ok ? settings.data : undefined;
    // loadUserSettings() only returns err() when a settings file EXISTS but
    // failed to load/parse (a missing file short-circuits to DEFAULT_SETTINGS,
    // ok:true) — so this is never the genuinely-logged-out case, only a
    // corrupt/unreadable session. Surface it loudly instead of silently
    // running anonymous (#805). Shared across every command entry, not just
    // audit (#1062) — reuses this already-loaded result instead of reading twice.
    warnIfSessionUnreadable(settings);
    // #332: hoisted so the outer catch/finally can finalize a tracked run even when something throws pre-register (no-op then).
    let finalizeTracked: (
      input: FinalizeRunInput
    ) => Promise<void> = async () => {};
    let removeSignalHandlers: () => void = () => {};
    try {
      if (!args.offline) {
        trackTelemetryEvent("audit", effectiveSettings);
      }
      printHeader(settings.ok ? settings.data.channel : "stable");
      if (settings.ok && !args.offline) {
        await printAutoUpdateAppliedNotice(settings.data);
        printUpdateNotification(settings.data);
        if (shouldShowAutoUpdateDisabledReminder(settings.data)) {
          updateSettings({
            auto_update_disabled_reminder: new Date().toISOString(),
          });
          printAutoUpdateDisabledReminder();
        }
        await promptForUpdate(settings.data, args);
      }

      // Load config silently — the preamble below prints the config source
      const configPath = getGlobalConfigPath() ?? findConfigFile() ?? undefined;
      const config = await loadConfig(configPath, { silent: true });

      // --fail-on score:<category> against a category the --rule-include/
      // --rule-exclude filter excludes can never trip (no data that run) —
      // reject it before crawling rather than silently no-op the gate. #1066
      if (ruleFilterActive) {
        const resolvedRules = resolveRulesConfig(config.rules, ruleFilter);
        // --rule-include X --rule-exclude X would crawl everything and score
        // nothing — reject the contradiction before the crawl starts.
        if (filterResolvesToZeroCategories(ruleFilter.enable, resolvedRules)) {
          console.error(
            "--rule-include/--rule-exclude contradict each other: every included category is also excluded, so no rules would run"
          );
          process.exitCode = 1;
          return;
        }
        for (const c of failOn.conditions) {
          if (
            c.metric === "category-score" &&
            c.category &&
            isCategoryExcluded(c.category, resolvedRules)
          ) {
            console.error(
              `--fail-on "${c.raw}": category "${c.category}" is excluded by --rule-include/--rule-exclude this run`
            );
            process.exitCode = 1;
            return;
          }
        }
      }

      // Route progress messages to stderr for non-console formats to keep stdout
      // clean. Derived from `args.format` (not the AuditOptions built below) so
      // account status + the coverage default can resolve before that object.
      const isConsoleFormat = !args.format || args.format === "console";
      const log = isConsoleFormat ? console.log : console.error;
      // Preamble — aligned key/value block (dim labels, plain values)
      const kv = (label: string, value: string) =>
        log(`${fmt.dim(label.padEnd(10))}${value}`);

      // Account status: who's authenticated + credit balance + plan tier; offline
      // when not (cloud features skip as not-authenticated). Resolved BEFORE
      // coverage because the plan decides the default coverage mode (paid →
      // surface with cloud rules + summary, free/anon → quick). Balance is
      // informational — short timeout, single attempt, never stalls the audit.
      //
      // Credential precedence: SQUIRRELSCAN_API_KEY env (or its
      // SQUIRREL_API_TOKEN alias) → settings.json login. When the env var
      // supplies the token it is AUTHORITATIVE / fail-closed — an invalid env
      // token errors the audit (no silent fall-back to local).
      const { createCloudClientWithSource } = await import("@/tools/cloud");
      const resolved = args.offline
        ? null
        : createCloudClientWithSource({
            timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
            // This single GET /v1/credits gates cloud for the WHOLE run, so a transient blip
            // must not silently drop cloud to local-only. The client retries idempotent GETs on
            // transport throws and transient 5xx/408 (timeout stays terminal); 3 attempts absorb
            // a blip while a hang/outage fast-fails within one STATUS_REQUEST_TIMEOUT_MS.
            maxAttempts: 3,
          });
      const statusClient = resolved?.client ?? null;
      const credentialSource = resolved?.source ?? null;
      // Display identity for the Account line. Env tokens are opaque (no email)
      // so we label them by source/kind; the login session has a cached email.
      // Read the env token only when it's actually the active source.
      const authEmail = settings.ok ? settings.data.auth?.email : undefined;
      const accountLabel =
        credentialSource === "env"
          ? `${activeEnvTokenVar() ?? API_TOKEN_ENV_VAR} (${describeEnvToken(getEnvApiToken() ?? "")})`
          : authEmail;
      // Auth resolves to ONE coherent state for the whole run: signed-in (cloud
      // usable) or not (cloud skipped). `signedIn` flips true ONLY after a
      // balance call succeeds — a cached email whose token is expired/revoked OR
      // an unreachable API both read as signed-out, so cloud never half-runs.
      let signedIn = false;
      let startingBalance: number | null = null;
      // Plan tier of the signed-in account, captured from the balance preflight.
      // Drives the report's locked-rules messaging (#368): "free" → soft Pro hint,
      // "paid" → genuinely-unavailable framing, "anonymous" → free-account upsell.
      // Also picks the default coverage mode below (signed-in → surface).
      let accountPlan: "anonymous" | "free" | "paid" = "anonymous";
      // White-label branding for local html/markdown/text/xml exports (#810).
      // Present only when the signed-in org is on the Team plan (API decides).
      let reportBranding: ReportBranding | undefined;
      // Did the user EXPECT cloud (had a token) but we can't use it this run?
      // Drives the interactive guard below. null = no outage (clean state).
      let cloudOutage: "expired" | "unreachable" | null = null;
      if (args.offline) {
        kv("Account", fmt.dim("offline (--offline) — cloud features disabled"));
      } else if (statusClient && accountLabel) {
        try {
          const { balance, plan, branding } = await statusClient.getBalance();
          startingBalance = balance.total;
          accountPlan = plan.id === "free" ? "free" : "paid";
          reportBranding = branding;
          // Pricing v10 (#391): every cloud audit debits a flat base at
          // registration. A balance below it can't start one — run local-only
          // (no register, no cloud calls, no publish) instead of letting the
          // server 402 the register mid-crawl.
          const auditBase = computeCost("audit_base", 1);
          if (balance.total < auditBase) {
            kv(
              "Account",
              `${accountLabel} · ${fmt.yellow(`${balance.total.toLocaleString("en-US")} credits — below the ${auditBase}-credit audit base, running local-only`)} · top up: ${fmt.cyan(DASHBOARD_URL)}`
            );
          } else {
            signedIn = true;
            kv(
              "Account",
              `${accountLabel} · ${fmt.bold(balance.total.toLocaleString("en-US"))} credits`
            );
          }
        } catch (error) {
          const invalidCredential =
            error instanceof CloudClientError &&
            error.code === "not_authenticated";
          // FAIL-CLOSED: an env-supplied token that the server rejects is a
          // hard error — we do NOT degrade to local-only or fall back to a
          // login session. This keeps CI predictable and avoids the silent
          // "I exported a token but it used my personal session" surprise.
          if (invalidCredential && credentialSource === "env") {
            log("");
            console.error(envTokenRejectedMessage());
            process.exitCode = 1;
            return;
          }
          // 401 → token expired/revoked server-side; anything else (timeout,
          // 5xx, DNS) → API unreachable. Either way cloud is unusable this run,
          // so every cloud step is skipped (cloudAvailable=false below).
          if (invalidCredential) {
            cloudOutage = "expired";
            kv(
              "Account",
              `${accountLabel} · ${fmt.yellow("session expired")} — run ${fmt.bold("squirrel auth login")} to re-enable cloud`
            );
          } else {
            cloudOutage = "unreachable";
            kv(
              "Account",
              `${accountLabel} · ${fmt.yellow("cloud unavailable")} — couldn't reach ${getApiUrl()}`
            );
          }
        }
        kv("Dashboard", fmt.cyan(DASHBOARD_URL));
      } else {
        kv(
          "Account",
          `not signed in — run ${fmt.bold("squirrel auth login")} to unlock cloud features`
        );
        kv("Dashboard", fmt.cyan(DASHBOARD_URL));
      }

      // Resolve coverage mode: CLI flag > config override > auth-aware default.
      // Any signed-in plan (free OR paid) defaults to `surface` (cloud rules +
      // editor summary on a page sample, pro-parity demo #684); only anonymous
      // defaults to `quick` (fast, no cloud, no spend). The CLI `--coverage`/`-C` flag is an unvalidated free string
      // (citty has no enum), so normalize + validate it (see normalizeCoverageMode).
      // An unknown value would otherwise make the page budget `undefined` → a NaN
      // cap → an unbounded crawl (every `pages.length >= NaN` check is false).
      // Transient outage: keep the signed-in user's coverage (no spend while cloud is down); expired token stays anon.
      const coverageAccountPlan =
        cloudOutage === "unreachable" ? "paid" : accountPlan;
      const coverageInput = (
        args.coverage ??
        config.crawler.coverage ??
        defaultCoverageMode(coverageAccountPlan)
      ).toString();
      const coverageMode = normalizeCoverageMode(coverageInput);
      if (coverageMode === null) {
        console.error(
          `${fmt.red("Error:")} unknown coverage mode '${coverageInput}'. Valid: ${COVERAGE_MODES.join(", ")} (or 'fast' = quick).`
        );
        process.exitCode = 1;
        return;
      }

      // Smart audits (#684): explicit `smart_audits` config always wins; the
      // default matrix (signed-in/expired/unreachable → on, anonymous → off)
      // lives in defaultSmartAudits (coverage.ts) with its own tests.
      const smartAudits =
        config.smart_audits ?? defaultSmartAudits(accountPlan, cloudOutage);

      // Validate --render-mode early (before any cloud work).
      const renderModeArg =
        typeof args["render-mode"] === "string"
          ? args["render-mode"]
          : undefined;
      if (
        renderModeArg !== undefined &&
        renderModeArg !== "off" &&
        renderModeArg !== "auto" &&
        renderModeArg !== "all"
      ) {
        console.error(
          `${fmt.red("Error:")} unknown --render-mode '${renderModeArg}'. Valid: off, auto, all.`
        );
        process.exitCode = 1;
        return;
      }

      // CLI --max-pages > config max_pages (if non-default) > coverage mode default
      const configMaxPagesIsDefault = config.crawler.max_pages === 100;
      const requestedMaxPages = args["max-pages"]
        ? Number.parseInt(args["max-pages"], 10)
        : configMaxPagesIsDefault
          ? coverageMaxPages(coverageMode)
          : config.crawler.max_pages;
      // A non-numeric --max-pages (e.g. "abc") parses to NaN; reject it rather
      // than silently crawling unbounded (NaN fails every `>= maxPages` check).
      if (
        args["max-pages"] !== undefined &&
        (!Number.isInteger(requestedMaxPages) || requestedMaxPages < 1)
      ) {
        console.error(
          `${fmt.red("Error:")} --max-pages must be a positive integer (got '${args["max-pages"]}').`
        );
        process.exitCode = 1;
        return;
      }
      const maxPages = Math.min(requestedMaxPages, MAX_PAGES_CAP);

      // CLI --max-depth > config crawler.max_depth > unset (unlimited).
      let maxDepth: number | undefined;
      if (args["max-depth"] !== undefined) {
        const parsed = Number.parseInt(args["max-depth"], 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error(
            `${fmt.red("Error:")} --max-depth must be a positive integer (got '${args["max-depth"]}').`
          );
          process.exitCode = 1;
          return;
        }
        maxDepth = parsed;
      } else if (typeof config.crawler.max_depth === "number") {
        maxDepth = config.crawler.max_depth;
      }

      // --concurrency / --per-host: positive-integer crawl parallelism overrides (#1068).
      const concurrency = parsePositiveIntFlag(
        args.concurrency,
        "--concurrency"
      );
      const perHostConcurrency = parsePositiveIntFlag(
        args["per-host"],
        "--per-host"
      );
      if (concurrency === null || perHostConcurrency === null) {
        process.exitCode = 1;
        return;
      }

      // Determine project name (priority: CLI flag > config > prompt > auto-derive)
      let projectName: string | undefined;
      if (args["project-name"]) {
        projectName = args["project-name"];
      } else {
        const urlParsed = parseUserUrl(args.url);
        if (urlParsed.ok) {
          const nameContext = getProjectNameContext(
            urlParsed.url,
            config.project.name
          );
          if (nameContext.needsCustomName && process.stdout.isTTY) {
            projectName = await promptForProjectName(
              nameContext.suggestedName,
              urlParsed.url
            );
          } else if (config.project.name) {
            projectName = config.project.name;
          }
        }
      }

      const options: AuditOptions = {
        url: args.url,
        maxPages,
        maxDepth,
        outputFormat: args.format as
          | "console"
          | "text"
          | "json"
          | "html"
          | "markdown"
          | "xml"
          | "llm"
          | undefined,
        outputPath: args.output,
        refresh: args.refresh,
        freshUa: args["fresh-ua"],
        incremental: args.incremental,
        resume: args.resume,
        verbose: args.verbose,
        debug: args.debug,
        projectName,
        coverageMode,
        smartAudits,
        offline: args.offline,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(perHostConcurrency !== undefined ? { perHostConcurrency } : {}),
        ...(Object.keys(customHeaders).length > 0
          ? { headers: customHeaders }
          : {}),
        ...(ruleFilter.enable.length > 0
          ? { ruleInclude: ruleFilter.enable }
          : {}),
        ...(ruleFilter.disable.length > 0
          ? { ruleExclude: ruleFilter.disable }
          : {}),
      };

      // Preamble — aligned key/value block (Account, and Dashboard when online,
      // already printed above during status resolution; kv defined there).
      kv("Auditing", fmt.bold(options.url));
      kv("Coverage", `${coverageMode} ${fmt.dim(`· max ${maxPages} pages`)}`);
      // loadConfig falls back to defaults when the path doesn't exist — the
      // label must say so rather than print a missing (e.g. mistyped) path.
      kv(
        "Config",
        configPath && existsSync(configPath) ? configPath : fmt.dim("defaults")
      );
      if (options.refresh) {
        kv("Mode", "fresh crawl (ignoring cache)");
      }
      // Names only — header values may carry signed credentials (#494).
      if (options.headers && Object.keys(options.headers).length > 0) {
        kv("Headers", redactHeaders(options.headers));
      }
      log("");

      // Chrome for a human watching, so always stderr regardless of format —
      // never `log`, which follows stdout for console runs (#819). Merged
      // (user + local) settings, unlike `effectiveSettings` above, so a
      // project's .squirrel/settings.json can turn tips off too.
      const mergedSettings = loadSettings();
      if (
        shouldShowTip({
          tipsEnabled: mergedSettings.ok ? mergedSettings.data.tips : true,
          stderrIsTTY: process.stderr.isTTY === true,
          isConsoleFormat,
          outputPath: options.outputPath,
        })
      ) {
        console.error(`${fmt.dim(tipLabel())}${pickTip()}`);
        console.error("");
      }

      // Resolve the crawl fetch mode (flags > config > authed-default-with-consent).
      // Only prompt when both stdin and stdout are interactive AND stdout isn't
      // carrying the report: machine formats (json/text/markdown/xml/llm) print
      // to stdout unless redirected, but console renders inline and html always
      // writes a file, so both leave stdout free for a prompt.
      const reportGoesToStdout =
        !isConsoleFormat &&
        options.outputFormat !== "html" &&
        !options.outputPath;
      const canPrompt =
        process.stdin.isTTY && process.stdout.isTTY && !reportGoesToStdout;

      // Guard: cloud was expected (signed in, cloud on, not --offline) but is
      // unusable this run — expired session or unreachable API. Interactive
      // users get to choose rather than silently dropping to a degraded
      // local-only audit. Non-interactive (agents/CI/--yes/piped output)
      // proceeds local-only: the Account line already said why, and blocking
      // automation on a prompt would be worse than a clean degraded run.
      if (
        cloudOutage &&
        config.cloud.enabled &&
        !args.offline &&
        canPrompt &&
        !args.yes
      ) {
        const proceed = await promptContinueLocalOnly(cloudOutage);
        if (!proceed) {
          log("");
          log(
            cloudOutage === "expired"
              ? `Cancelled. Run ${fmt.bold("squirrel auth login")} to re-enable cloud features.`
              : "Cancelled — the cloud API was unreachable."
          );
          await safeExit(0);
        }
        log("");
      }

      // Resolve the render strategy (#294). `off`/`auto`/`all` is funneled into
      // the existing http/browser consent decision (off→http, auto|all→browser)
      // so the spend-consent flow is unchanged; the auto-vs-all *strategy* is
      // passed separately to the controller (hybrid vs render-all). Unset →
      // coverage-driven default, decided in the controller.
      const explicitRenderMode = resolveExplicitRenderMode(
        { http: args.http, render: args.render, renderMode: renderModeArg },
        config
      );
      if (config.cloud.rendering && !config.cloud.render) {
        logger.debug(
          `[cloud] rendering = "${config.cloud.rendering}" is deprecated; prefer render = "${config.cloud.rendering === "http" ? "off" : "all"}"`
        );
      }
      const renderStrategy =
        explicitRenderMode === "auto" || explicitRenderMode === "all"
          ? explicitRenderMode
          : undefined;

      const { mode: cloudRendering, consented: cloudConsented } =
        await resolveCloudRendering({
          // Mirror the resolved on/off into the existing flag inputs so
          // --render-mode and [cloud].render route through the unchanged path.
          args: {
            ...args,
            http: explicitRenderMode === "off",
            render:
              explicitRenderMode === "auto" || explicitRenderMode === "all",
          },
          configRendering:
            explicitRenderMode === "off"
              ? "http"
              : explicitRenderMode
                ? "browser"
                : config.cloud.rendering,
          signedIn,
          consent: effectiveSettings?.cloud_render_consent,
          spendAck: effectiveSettings?.cloud_spend_ack,
          log,
          // Cost shown up front so the user can decline before the crawl.
          estimate: {
            maxPages,
            balance: startingBalance,
            maxCredits: config.cloud.max_credits_per_audit,
          },
        });

      // #1169: preflight affordability check. A signed-in audit debits the flat
      // base at register + a per-rendered-page charge as pages render, so an org
      // whose balance can't cover the planned audit would otherwise only find out
      // mid-run (charging stops / coverage degrades). Predict it up front:
      // estimate = base + up-to-maxPages renders (render charge only when cloud
      // rendering is on). plannedPages is an UPPER bound (the crawl may find fewer),
      // so it's worded "up to". TTY → prompt continue/abort; non-TTY/--yes → warn +
      // continue (never block CI). Pricing comes from the shared source, not hardcoded.
      if (signedIn && startingBalance != null) {
        const preflight = computePreflightAffordability({
          balance: startingBalance,
          maxPages,
          cloudRendering,
          topUpUrl: DASHBOARD_URL,
        });
        if (preflight.shortfall) {
          log("");
          log(fmt.yellow(preflight.warningLines[0]!));
          log(fmt.dim(preflight.warningLines[1]!));
          const canPrompt = preflightPromptEligible({
            stdinIsTTY: !!process.stdin.isTTY,
            stdoutIsTTY: !!process.stdout.isTTY,
            yes: !!args.yes,
          });
          if (canPrompt) {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const proceed = await new Promise<boolean>((resolve) => {
              rl.on("close", () => resolve(false));
              rl.on("error", () => resolve(false));
              rl.question("Continue anyway? [y/N] ", (answer) => {
                resolve(/^y(es)?$/i.test(answer.trim()));
              });
            }).finally(() => rl.close());
            if (!proceed) {
              log("Aborted. No credits were charged.");
              return;
            }
          }
        }
      }

      const startTime = Date.now();
      // #271 phase 6: capture the runner context once (env reads) and reuse it for
      // both the register config and the end-of-run CI echo.
      const runnerInfo = detectRunner();

      // #271: register this run so it appears live in the dashboard the instant
      // it starts (status pending → running → completed). Signed-in + online
      // only; --offline opts out, --no-publish does NOT (the run still shows in
      // YOUR dashboard — publishing only governs the shareable report).
      //
      // Kicked off WITHOUT awaiting, so the register round-trip overlaps the
      // crawl instead of delaying audit start. markRunning chains off it (fires
      // once the run exists, during the crawl); the id is awaited below for the
      // terminal PATCH + publish linkage. Best-effort: failure → null → the
      // audit runs untracked, never blocked.
      // Captures a loud, actionable register failure (#816) — e.g. at the
      // website limit — surfaced once after the crawl (progress stopped) so it
      // isn't clobbered mid-crawl. Only set for definitive 4xx, not transient.
      let registerWarning: string | null = null;
      const registerPromise: Promise<RegisteredRun | null> =
        signedIn && !args.offline
          ? registerRun(
              {
                url: args.url,
                mode: "audit",
                // #271 phase 6: runner metadata (who/where ran it) stored on the
                // run's config jsonb; surfaced in the dashboard audit-detail header.
                config: {
                  maxPages,
                  coverageMode,
                  cliVersion: packageVersion,
                  runner: runnerInfo,
                },
              },
              (msg) => {
                registerWarning = msg;
              }
            )
          : Promise.resolve(null);
      // Captured for the in-crawl progress emits below: register resolves a beat
      // after this (fast round-trip), so by the time pages start landing the id
      // is set. Null until then → those early ticks simply no-op.
      let trackedRunId: string | null = null;
      // Base path resolved once at register; reused so the lifecycle stays consistent.
      let trackedBase: string | undefined;
      void registerPromise.then((run) => {
        if (run) {
          trackedRunId = run.runId;
          trackedBase = run.lifecycleBase;
          void markRunning(
            run.runId,
            new Date(startTime).toISOString(),
            run.lifecycleBase
          );
        }
      });

      // #332: one guarded finalizer for every exit path (--no-publish, error, Ctrl-C, crash) so none leaves the run pending to be reaped.
      finalizeTracked = createRunFinalizer(registerPromise);

      // #332: on interrupt, await a "cancelled" PATCH before re-raising so it lands instead of being reaped as a failure.
      const onSignal = (signal: NodeJS.Signals): void => {
        // Note the cancel so the user isn't left wondering during the PATCH (stderr keeps piped stdout clean).
        if (trackedRunId) process.stderr.write("\nCancelling run…\n");
        void finalizeTracked({
          status: "cancelled",
          completedAt: new Date().toISOString(),
          completionReason: "user_cancel",
        }).finally(() => {
          removeSignalHandlers();
          process.kill(process.pid, signal);
        });
      };
      removeSignalHandlers = (): void => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      // #271 phase 5: coarse page-progress, throttled to ≤1/s. `crawlPagesFailed`
      // is tallied from the raw crawler events (onEvent) since onProgress only
      // carries the processed count.
      let lastProgressAt = 0;
      let crawlPagesFailed = 0;
      const PROGRESS_MIN_INTERVAL_MS = 1_000;

      const progress = createProgress("Initializing");
      let currentPhase = "init";
      let discoveredCount = 0;
      let sitemapUrlCount = 0;
      let result: Awaited<ReturnType<typeof runAudit>>;

      // Route logs through progress to keep progress line at bottom
      setLogInterceptor((msg) => progress.log(msg));

      try {
        // Run the audit with progress + event callbacks.
        // TTY-only spend confirmation; --yes (or piped output) proceeds silently.
        // Built for interactive TTY runs — it still gates the UNCAPPED dead-links
        // spend. The capped prefetch confirm is skipped for consented users in the
        // controller via `cloudConsented`, not by nulling this callback.
        const confirmCloudSpend =
          process.stdout.isTTY && !args.yes
            ? async (estimate: number, balance: number): Promise<boolean> => {
                progress.stop();
                const { createInterface } = await import("node:readline");
                const rl = createInterface({
                  input: process.stdin,
                  output: process.stdout,
                });
                const proceed = await new Promise<boolean>((resolve) => {
                  // stdin EOF/error before an answer → decline the spend rather
                  // than hang or silently charge credits.
                  rl.on("close", () => resolve(false));
                  rl.on("error", () => resolve(false));
                  rl.question(
                    `Cloud analysis will use ~${estimate} credits (balance: ${balance}). Continue? [Y/n] `,
                    (answer) => {
                      const a = answer.trim();
                      resolve(a === "" || /^y(es)?$/i.test(a));
                    }
                  );
                }).finally(() => rl.close());
                // Only resume the cloud spinner when proceeding — a declined
                // run jumps straight to the rules phase, which starts its own.
                if (proceed) {
                  progress.start("Fetching cloud analysis");
                }
                return proceed;
              }
            : undefined;

        result = await runAudit({
          ...options,
          confirmCloudSpend,
          // #1134: resolver so render debits during the crawl are tagged with the
          // async-registered run id (null until register resolves a beat in).
          getRunId: () => trackedRunId ?? undefined,
          // Skips ONLY the capped, pre-disclosed prefetch confirm; the controller
          // keeps confirmCloudSpend for uncapped dead-links. The cap check is
          // already baked into `cloudConsented` (resolveCloudRendering).
          cloudConsented,
          // Single source of truth: every cloud step skips cleanly when false.
          cloudAvailable: signedIn,
          // Concrete fetch mode resolved above: explicit flags/config, or the
          // authed default (cloud rendering) after one-time consent.
          cloudRendering,
          // Render strategy when rendering is on: auto = HTTP-first hybrid,
          // all = render every page. Undefined → controller's coverage default.
          renderStrategy,
          configPath: getGlobalConfigPath(),
          onEvent: (event: CrawlerEvent) => {
            switch (event.type) {
              case "started":
                progress.log(`New crawl: ${event.baseUrl}`);
                break;
              case "resumed":
                progress.log("Resuming interrupted crawl");
                break;
              case "url:enqueued":
                if (event.source === "sitemap") {
                  sitemapUrlCount++;
                }
                break;
              case "url:discovered":
                discoveredCount++;
                break;
              case "page:failed":
                crawlPagesFailed++;
                break;
            }
          },
          onProgress: (p) => {
            switch (p.phase) {
              case "crawling":
                // Only switch to "Crawling" once we have progress
                // This keeps "Initializing" during redirect/robots/sitemap discovery
                if (p.current !== undefined && p.current > 0) {
                  if (currentPhase !== "crawling") {
                    // Log sitemap summary if any URLs found
                    if (sitemapUrlCount > 0) {
                      progress.log(`Found ${sitemapUrlCount} URLs in sitemap`);
                    }
                    progress.stop();
                    progress.start("Crawling");
                    currentPhase = "crawling";
                  }
                  // Show discovered count + the in-flight URL (live per-page
                  // progress so a slow render upgrade doesn't look frozen).
                  const found =
                    discoveredCount > 0 ? ` [${discoveredCount} found]` : "";
                  const active = p.detail ? ` ${fmt.dim(p.detail)}` : "";
                  progress.update(p.current, maxPages, `${found}${active}`);

                  // Tee coarse progress to the dashboard (≤1/s). Best-effort and
                  // gated on a resolved run id + base (both set together at
                  // register) — no-op for offline/untracked runs.
                  if (trackedRunId && trackedBase) {
                    const now = Date.now();
                    if (now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
                      lastProgressAt = now;
                      void reportProgress(
                        trackedRunId,
                        {
                          pagesFetched: p.current,
                          pagesTotal: p.total ?? maxPages,
                          pagesFailed: crawlPagesFailed,
                        },
                        trackedBase
                      );
                    }
                  }
                }
                break;
              case "external-links":
                if (currentPhase !== "external-links") {
                  progress.stop();
                  progress.start("Checking external links");
                  currentPhase = "external-links";
                }
                if (p.current !== undefined && p.total !== undefined) {
                  progress.update(p.current, p.total);
                }
                break;
              case "cloud":
                if (currentPhase !== "cloud") {
                  progress.stop();
                  progress.start("Fetching cloud analysis");
                  currentPhase = "cloud";
                }
                if (p.detail) {
                  progress.log(p.detail);
                }
                break;
              case "rules":
                if (currentPhase !== "rules") {
                  progress.stop();
                  progress.start("Analyzing audit rules");
                  currentPhase = "rules";
                }
                break;
              case "complete":
                break;
            }
          },
        });
      } finally {
        // Always clean up progress and log interceptor
        setLogInterceptor(undefined);
        progress.stop();
      }

      // #271: register ran concurrently with the crawl above; resolve it now (it
      // settled long ago in the common case, so this await is instant) for the
      // terminal PATCH + publish linkage. Best-effort → null on failure.
      const registeredRun: RegisteredRun | null = await registerPromise.catch(
        () => null
      );

      // #816: register failed with a definitive, actionable error (e.g. the
      // account is at its website limit). Warn loudly — the run ran locally but
      // is NOT tracked in the dashboard or attached to failure observability,
      // which used to be swallowed silently. Progress is stopped by now (finally
      // above), so this prints cleanly.
      if (registerWarning && !registeredRun) {
        log(`⚠ Run not tracked in your dashboard: ${registerWarning}`);
      }

      // Handle errors
      if (!result.ok) {
        commandResult = "error";
        logger.error("audit error", { error: result.error.message });
        log(`✗ ${result.error.message}`);
        printDatabaseLockWarningIfNeeded(result.error.message, log);
        // #271: mark the registered run failed so it doesn't hang on "Running".
        void finalizeTracked({
          status: "failed",
          completedAt: new Date().toISOString(),
          completionReason: "error",
          error: result.error.message,
          // #871: a failed run has no `report` (the success path's carrier
          // for phaseTimingsMs, see finalizeCompleted below) — runAudit's
          // error path plumbs the same partial breakdown through
          // CommandError.details instead, so a wedged phase is still
          // diagnosable from telemetry without prod-DB forensics.
          phaseTimingsMs: phaseTimingsFromError(result.error.details),
        });
        process.exitCode = 1;
        return;
      }

      const report = result.data;
      // Pricing v10 (#391): the audit base was debited at register, outside the
      // controller's spend accounting — fold it into the disclosed spend so the
      // summary/footer match the ledger (#876).
      if (registeredRun?.baseCharged) {
        const prior = report.cloudSpend;
        report.cloudSpend = {
          lines: [
            {
              service: "audit-base",
              feature: "audit_base",
              units: 1,
              credits: registeredRun.baseCharged,
            },
            ...(prior?.lines ?? []),
          ],
          totalSpent: (prior?.totalSpent ?? 0) + registeredRun.baseCharged,
          // Prefer the controller's post-services balance read; the register
          // response balance only covers the base debit.
          balanceAfter: prior?.balanceAfter ?? registeredRun.balanceAfterBase,
        };
      }
      // #368: stamp the account tier so the published report's locked-rules
      // section never shows the "get a free account" upsell to a signed-in user.
      report.cloudPlan = accountPlan;
      // #368: stamp the resolved cloud mode so an explicit --http opt-out reads as
      // a deliberate choice, not a "cloud temporarily unavailable" failure.
      report.cloudMode = cloudRendering;
      // #747: stamp the coverage mode so a quick run's locked cloud rules read as
      // a coverage choice ("re-run with -C surface/full"), never a cloud outage.
      report.coverageMode = coverageMode;

      // #1179: the server's AUTHORITATIVE post-merge score/issues from a
      // successful publish. The publish handler re-merges the payload against the
      // cross-audit finding store and can land a different score than the CLI's
      // local pre-publish estimate; when set, finalizeCompleted stamps THESE into
      // agent_runs so the dashboard "runs" history matches the published report.
      // Left undefined when publish didn't happen (--no-publish/offline/anon) or
      // an older server omitted them → the local estimate stands.
      let serverHealthScore: number | null | undefined;
      let serverIssuesFound: number | undefined;

      // #271: close the registered run out as completed. Called at every
      // success exit (here via the publish block, and the early-return explicit
      // --publish failure paths). reportId links the run to its published report
      // when one exists; null leaves the run completed without a shareable
      // report (e.g. --no-publish), which the API still surfaces as completed.
      // `publishError` (set on auto-publish failure) records an error audit, not
      // a silent success — the audit itself succeeded, only publish failed. #354
      const finalizeCompleted = (
        reportId: string | null,
        publishError?: string,
        publishErrorCode?: string | null
      ): void => {
        // Failed/blocked audit (#489): the audit didn't really happen (down/403/
        // 0-page) — finalize the tracked run as failed with no score so
        // agent_runs never records a bogus "completed / A-100%" (parity with the
        // report + DO-sync guards). A normal run stays completed with its score.
        const invalidAudit = auditStatusToLifecycle(report.status) === "failed";
        // #1179: prefer the server's post-merge score/issues (set on a successful
        // publish) so agent_runs matches the published report; fall back to the
        // local estimate for non-publish / older-server runs.
        const finalizeScore = resolveRunFinalizeScore({
          invalidAudit,
          localHealthScore: report.healthScore?.overall ?? null,
          localIssuesFound: report.failed + report.warnings,
          serverHealthScore,
          serverIssuesFound,
        });
        // Fire-and-forget: the report already printed; this dashboard sync must never block CLI exit.
        void finalizeTracked({
          status: invalidAudit ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          healthScore: finalizeScore.healthScore,
          issuesFound: finalizeScore.issuesFound,
          reportId,
          completionReason: publishError || invalidAudit ? "error" : "success",
          error:
            publishError ?? (invalidAudit ? report.statusReason : undefined),
          // #1168: only a PUBLISH failure carries a code — the API refunds the
          // whole audit for size/server-class publish failures. An invalid audit
          // (down/403/0-page) already auto-refunds via the failed-run sweep.
          ...(publishError && publishErrorCode
            ? { errorCode: publishErrorCode }
            : {}),
          // #857: forwards to the run's config jsonb for field-slowness triage
          // without prod-DB forensics; includes `publish` (timed below) since
          // that phase runs in this file, after runAudit() returns.
          phaseTimingsMs: report.phaseTimingsMs,
        });
      };
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

      log(`✓ Audited ${report.pages.length} pages in ${durationSec}s`);
      // #271 phase 6: echo the runner context on CI runs (which repo/branch/
      // commit triggered the audit). Local runs skip it — the dashboard surfaces
      // who/where for those, and a laptop's hostname is just noise in the terminal.
      if (runnerInfo.ci && runnerInfo.repo) {
        const ref = [runnerInfo.repo, runnerInfo.branch]
          .filter(Boolean)
          .join("@");
        const sha = runnerInfo.commit
          ? ` (${runnerInfo.commit.slice(0, 7)})`
          : "";
        log(fmt.dim(`  ${runnerInfo.provider ?? "ci"} · ${ref}${sha}`));
      }
      // Surface the page-cap override when the limit was the binding constraint
      // so users on big sites know how to scan more (the capability exists; this
      // is a discoverability gap). report.pages covers all stored pages (the cap
      // basis), so == maxPages means the cap stopped the crawl. #124
      const limitHint = pageLimitHint(
        report.pages.length >= maxPages,
        maxPages
      );
      if (limitHint) log(fmt.yellow(limitHint));
      // #1180: when the cap didn't bind but the union score still carries
      // un-recrawled pages (smart audits), say so — otherwise a partial
      // re-audit's score reads as a fresh full-site verdict.
      if (!limitHint) {
        const scanHint = fullScanHint(report);
        if (scanHint) log(fmt.yellow(`⚠ ${scanHint}`));
      }
      if (report.cloudSpend && report.cloudSpend.totalSpent > 0) {
        log(formatCloudSpendSummary(report.cloudSpend));
      }
      // Partial cloud coverage must be loud: failed batches are uncharged and
      // produce no spend line, so the credits line alone can look healthy
      // while half the cloud-backed checks silently skipped.
      for (const f of report.cloudFailures ?? []) {
        const label = CLOUD_SERVICE_LABELS[f.service] ?? f.service;
        if (f.attemptedUnits > 1) {
          const covered = Math.max(0, f.attemptedUnits - f.failedUnits);
          const batches = `${f.failedBatches} ${f.failedBatches === 1 ? "batch" : "batches"}`;
          log(
            `⚠ ${label} covered ${covered}/${f.attemptedUnits} pages (${batches} failed: ${f.detail})`
          );
        } else {
          log(`⚠ ${label} failed (${f.detail})`);
        }
      }
      log("");

      // Audit is stored in SQLite database
      log(
        "Audit stored in database. Use 'squirrel report' to view latest audit."
      );
      log("Use 'squirrel report --list' to see all stored audits.");

      log("");

      // Output
      // console, text, json: stdout by default (pipeable)
      // html: file by default (needs browser)
      const format = options.outputFormat ?? "console";
      // Only the console renderer carries the partial-audit notice today
      // (ConsoleReportOptions.ruleFilter) — machine formats don't have a
      // partial marker in their payload yet (#1082), so warn on stderr
      // rather than silently emit a filtered report with no distinguishing
      // signal. Printed to stderr regardless of format so it never pollutes
      // a piped stdout report.
      if (ruleFilterActive && format !== "console") {
        console.error(
          `⚠ --rule-include/--rule-exclude active — this ${format} report is partial and does not mark itself as such (see #1082)`
        );
      }
      if (format === "console") {
        generateConsoleReport(report, {
          summaryOnly: args.summary,
          ...(ruleFilterActive ? { ruleFilter } : {}),
        });
      } else if (format === "text") {
        generateTextReport(report, options.outputPath, reportBranding);
      } else if (format === "json") {
        // stdout by default, file if -o provided
        generateJsonReport(report, options.outputPath);
      } else if (format === "html") {
        // file by default - HTML needs a browser
        const hostname = new URL(report.baseUrl).hostname;
        const htmlPath = options.outputPath ?? `${hostname}-report.html`;
        generateHtmlReport(report, htmlPath, reportBranding);
      } else if (format === "markdown") {
        generateMarkdownReport(report, options.outputPath, reportBranding);
      } else if (format === "xml") {
        generateXmlReport(report, options.outputPath, reportBranding);
      } else if (format === "llm") {
        generateLlmReport(report, options.outputPath);
      }

      // Publish to the dashboard (auto when signed in + online, or forced with
      // --publish). Opt out per-run with --no-publish/--offline, persistently
      // with [cloud] publish = false. Still shows the console report above.
      const isAutoPublish = !args.publish;
      let publishedReportId: string | null = null;
      // Set when an auto-publish fails → finalizeCompleted records an error audit. #354
      let autoPublishError: string | null = null;
      // #1168: the publish error's structured code (PAYLOAD_TOO_LARGE, TOKEN_INVALID,
      // …), forwarded to finalizeTracked so the API can classify a publish failure —
      // refund the whole audit for size/server-class failures, never for auth/user ones.
      let autoPublishErrorCode: string | null = null;
      const shouldPublish = resolvePublishDecision({
        signedIn,
        offline: !!args.offline,
        explicitPublish: !!args.publish,
        noPublish: !!args["no-publish"],
        configPublish: config.cloud.publish,
        ruleFilterActive,
      });
      // Only claim the filter caused the skip when it's actually the deciding
      // factor — --no-publish/config/signed-out skips would misattribute.
      const wouldPublishWithoutFilter = resolvePublishDecision({
        signedIn,
        offline: !!args.offline,
        explicitPublish: !!args.publish,
        noPublish: !!args["no-publish"],
        configPublish: config.cloud.publish,
        ruleFilterActive: false,
      });
      if (!shouldPublish && wouldPublishWithoutFilter && ruleFilterActive) {
        log(
          fmt.dim(
            "Rule filter active — auto-publish skipped for this partial run (use --publish to publish anyway)."
          )
        );
      }
      // #857: publish runs here (after runAudit returns), not inside the
      // controller. recordPublishPhase() is called at every exit from the
      // block below — both early returns AND the normal fall-through — so
      // finalizeCompleted's telemetry attach always carries the full
      // breakdown. NOT a try/finally: the two early returns below already
      // call finalizeCompleted() synchronously before a finally would run,
      // so a finally-based approach would record it AFTER that read.
      const publishPhaseStart = performance.now();
      const recordPublishPhase = (): void => {
        report.phaseTimingsMs = {
          ...report.phaseTimingsMs,
          publish: performance.now() - publishPhaseStart,
        };
      };
      if (shouldPublish) {
        const validVisibilities: ReportVisibility[] = [
          "public",
          "unlisted",
          "private",
        ];
        const visibility =
          (args.visibility as ReportVisibility) ??
          config.cloud.visibility ??
          "unlisted";

        // Auto-publish runs as a side effect of a successful audit, so a publish
        // problem must NOT fail the whole run (the report already printed) —
        // warn and continue. Explicit --publish is the user's stated goal, so
        // its failures stay fatal (exit 1).
        if (!validVisibilities.includes(visibility)) {
          log(
            `Invalid visibility: ${visibility}. Use: public, unlisted, or private`
          );
          if (!isAutoPublish) {
            recordPublishPhase();
            finalizeCompleted(null);
            process.exitCode = 1;
            return;
          }
          autoPublishError = `Auto-publish skipped: invalid visibility "${visibility}"`;
        } else {
          const publishResult = await publishReport(report, {
            visibility,
            auditId: registeredRun?.auditId,
            runId: registeredRun?.runId,
            websiteId: registeredRun?.websiteId,
            // #1167: surface the degrade-pass clip notice on stderr-safe `log`.
            onWarn: (msg) => log(fmt.yellow(`⚠ ${msg}`)),
          });

          if (!publishResult.ok) {
            log(
              isAutoPublish
                ? `⚠ Could not auto-publish: ${publishResult.error.message}`
                : `Failed to publish: ${publishResult.error.message}`
            );
            printDatabaseLockWarningIfNeeded(publishResult.error.message, log);
            if (!isAutoPublish) {
              recordPublishPhase();
              finalizeCompleted(
                null,
                publishResult.error.message,
                publishResult.error.code
              );
              process.exitCode = 1;
              return;
            }
            autoPublishError = publishResult.error.message;
            autoPublishErrorCode = publishResult.error.code;
          } else {
            publishedReportId = publishResult.data.id;
            // #1179: the server re-merges the published payload against the
            // cross-audit finding store, so its score can differ from the local
            // estimate the console report above already printed. Adopt the
            // server's numbers for the run finalize (so agent_runs matches the
            // published report), and note the delta so the printed local score
            // doesn't look wrong.
            serverHealthScore = publishResult.data.healthScore;
            serverIssuesFound = publishResult.data.issuesFound;
            const localScore = report.healthScore?.overall ?? null;
            if (
              typeof serverHealthScore === "number" &&
              typeof localScore === "number" &&
              serverHealthScore !== localScore
            ) {
              log(
                fmt.dim(
                  `Published score: ${serverHealthScore} (local estimate ${localScore}; the dashboard reflects all known pages across audits).`
                )
              );
            }
            log("");
            log(publishResult.data.url);

            if (report.crawlId) {
              await savePublishedReportInfo(
                report.crawlId,
                publishResult.data.id,
                publishResult.data.url,
                publishResult.data.visibility
              );
            }

            // One-time, non-blocking TTY notice: tell users their audits sync
            // now and how to opt out. Only on auto-publish (explicit --publish
            // means they already opted in).
            if (
              isAutoPublish &&
              process.stdout.isTTY &&
              !effectiveSettings?.auto_publish_notice_shown
            ) {
              log(
                fmt.dim(
                  `Audits now sync to your dashboard (${visibility}). Opt out: --no-publish, --offline, or [cloud] publish = false.`
                )
              );
              // Non-fatal: a failed write just re-shows the notice next run.
              updateSettings({ auto_publish_notice_shown: true });
            }
          }
        }
        recordPublishPhase();
      }

      // Sync detected tech to the dashboard (per-website + global per-domain).
      // Non-published path only — a published run syncs in the report-publish
      // handler. Gate on presence not items.length: an empty [] is a real
      // "found nothing" that clears stale tech (mirrors the publish-side sync).
      if (
        registeredRun?.websiteId &&
        report.technologies &&
        !publishedReportId
      ) {
        await syncTechnologies({
          websiteId: registeredRun.websiteId,
          auditId: registeredRun.auditId,
          technologies: report.technologies.items,
        });
      }

      // #271: close out the registered run as completed. Runs for every
      // signed-in success path — published (reportId set), auto-publish-failed
      // (reportId null + autoPublishError → records as an error audit, #354),
      // and --no-publish (reportId null → completed without a shareable report).
      finalizeCompleted(
        publishedReportId,
        autoPublishError ?? undefined,
        autoPublishErrorCode
      );

      // Footer: credits used this run + dashboard link (or sign-in reminder),
      // then locked-rules count (#780 — signed-in runs with skips, e.g. quick
      // coverage or 0 credits, used to show nothing beyond "Credits used: 0"),
      // then issue link and feedback command
      const footerLines: string[] = [];
      if (!args.offline) {
        if (signedIn) {
          const spent = report.cloudSpend?.totalSpent ?? 0;
          const after =
            report.cloudSpend?.balanceAfter ??
            (spent === 0 ? startingBalance : null);
          const balancePart =
            after != null
              ? ` · balance ${spent > 0 ? "~" : ""}${after.toLocaleString("en-US")}`
              : "";
          footerLines.push(
            `${fmt.dim("Credits used:")} ${spent}${balancePart}  •  ${fmt.cyan(DASHBOARD_URL)}`
          );
          // #780: signed-in runs with skipped cloud rules (quick coverage, 0
          // credits) used to show nothing beyond "Credits used: 0" — surface
          // the count + why. Anonymous runs already get an equivalent signup
          // CTA below, so skip this line there to avoid printing two.
          const lockedLine = lockedRulesFooterLine(report);
          if (lockedLine) footerLines.push(lockedLine);
        } else {
          footerLines.push(
            `${fmt.dim("Unlock cloud features:")} squirrel auth login  •  ${fmt.cyan(DASHBOARD_URL)}`
          );
        }
      }
      printFooter(footerLines);

      // #1085: after a long audit the start-of-run update box has scrolled off;
      // reprint the loud-fallback reminder by the footer where the user is
      // actually looking. No-op unless in the #1074 silent-failure state, and
      // it fires no telemetry (printUpdateNotification already counted this run).
      // Re-read settings fresh: a POSIX detached / Windows inline updater may
      // have SUCCEEDED and cleared the counter during the audit, so the stale
      // start-of-command snapshot would falsely say "didn't complete".
      if (!args.offline) {
        const fresh = loadUserSettings();
        if (fresh.ok) printEndOfRunUpdateReminder(fresh.data);
      }

      // Failed/blocked audit (#489): the audit didn't really happen (down/403/
      // 0-page), so exit non-zero (1 = operational failure) even without an
      // explicit --fail-on gate, so CI doesn't read a down site as success.
      if (report.status === "failed" || report.status === "blocked") {
        process.exitCode = 1;
      }

      // CI/agent gating: evaluate --fail-on against the finished report and
      // set a non-zero exit code (2 = gate tripped) so CI can fail the build.
      // Report + footer already printed above so the gate never hides output.
      // (A failed/blocked audit already skips the gate — see evaluateFailOn.)
      if (failOn.conditions.length > 0) {
        const evaluation = evaluateFailOn(failOn.conditions, report);
        for (const line of formatFailOnSummary(evaluation)) log(line);
        if (evaluation.trips.length > 0) {
          process.exitCode = 2;
        }
      }
    } catch (e) {
      commandResult = "error";
      const errMessage = e instanceof Error ? e.message : String(e);
      logger.error("audit exception", { error: errMessage });
      // #332: a crash after register leaves the skeleton pending → finalize it.
      await finalizeTracked({
        status: "failed",
        completedAt: new Date().toISOString(),
        completionReason: "error",
        error: errMessage,
      }).catch(() => {});
      if (!args.offline) {
        trackError(e as Error, "audit", effectiveSettings);
      }
      throw e;
    } finally {
      removeSignalHandlers();
      logger.commandEnd("audit", commandResult, Date.now() - commandStart);
      // Flush logs even on error
      await logger.flush();
    }
  },
});
