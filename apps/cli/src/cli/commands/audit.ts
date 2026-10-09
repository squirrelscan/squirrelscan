// squirrelscan audit <url> - CLI wrapper

import type { ReportBranding } from "@squirrelscan/core-contracts";

import {
  CloudClientError,
  type UpgradeOffer,
} from "@squirrelscan/cloud-client";
import {
  formatProbeBudget,
  type ProbeFlags,
  type ProbeResolution,
  type ProbeRunContext,
  resolveProbeIntensity,
} from "@squirrelscan/config";
import {
  auditStatusToLifecycle,
  clampAuditPages,
  computeCost,
  CREDIT_PRICING_VERSION,
  estimateAuditCap,
  minimumAuditCredits,
} from "@squirrelscan/core-contracts";
import { AUDIT_LEVEL_PRESETS } from "@squirrelscan/core-contracts/audit-levels";
import { fullScanHint } from "@squirrelscan/report";
import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { platform } from "node:os";

import type { AuditFailureDetails, CrawlerEvent } from "@/controllers/audit";
import type { PreflightBalance } from "@/lib/balance";
import type { UserSettings } from "@/self/types";
import type { AuditOptions } from "@/types";

import { decodeFailureLines, isDecodeFailure } from "@/audit/decode-failures";
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
import { formatRetentionNotice } from "@/audit/retention";
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
  STATUS_REQUEST_TIMEOUT_MS,
} from "@/constants";
import {
  auditedPageCount,
  runAudit,
  withAuditPageSettlement,
} from "@/controllers/audit";
import {
  publishReport,
  savePublishedReportInfo,
  type ReportVisibility,
} from "@/controllers/report/publish";
import { ErrorCodes } from "@/controllers/types";
import { domainToProjectName } from "@/crawler/storage";
import {
  checkAuditStores,
  formatStoreProblems,
} from "@/crawler/storage/store-check";
import { formatBalance, isUnlimitedBalance } from "@/lib/balance";
import {
  cloudRenderSkippedLines,
  LOCAL_HOST_NOT_PUBLISHED_LINE,
  nonPublicHostLabel,
  SERVER_NON_PUBLIC_HOST_LINE,
} from "@/lib/non-public-host";
import { pageLimitNotice, resolvePageLimit } from "@/lib/page-limit";
import {
  createRunFinalizer,
  type FinalizeRunInput,
  markRunning,
  registerRun,
  reportProgress,
  type RegisteredRun,
  type RegisterFailure,
  resolveRunFinalizeScore,
  startRunHeartbeat,
} from "@/lib/run-tracker";
import { scheduleSummaryLine } from "@/lib/schedule-notice";
import { syncTechnologies } from "@/lib/technology-sync";
import {
  AUDIT_BASE_CREDITS,
  AUDIT_PAGE_CREDITS,
  AUDIT_PRICING_LINE,
  MIN_AUDIT_CREDITS,
  offerPitchLines,
  proPitchLines,
  resetDateLabel,
  upgradeUrl,
} from "@/lib/upgrade";
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
import { CWD_UNAVAILABLE, cwdOr } from "@/utils/cwd";
import { configureLogger, logger, setLogInterceptor } from "@/utils/logger";
import { getProjectNameContext, parseUserUrl } from "@/utils/url";

import { version as packageVersion } from "../../../package.json";
import {
  AUDIT_LEVELS,
  type AuditLevel,
  configLevelOverrides,
  defaultAuditLevel,
  defaultSmartAudits,
  levelBannerParts,
  levelCoverageMode,
  levelHelpList,
  levelMaxPages,
  parseAuditLevel,
  readLevelFlag,
  resolveLocalAuditLevel,
  unknownLevelMessage,
} from "../audit-level";
import {
  printHeader,
  printUpdateNotification,
  printEndOfRunUpdateReminder,
  shouldShowAutoUpdateDisabledReminder,
  printAutoUpdateDisabledReminder,
  promptForUpdate,
  printFooter,
  lockedRulesFooterLine,
} from "../banner";
import { printDatabaseLockWarningIfNeeded } from "../db-lock-warning";
import { hasFlag, hasNegatedFlag } from "../flags";
import { fmt, pageLimitHint } from "../format";
import { createProgress } from "../progress";
import { promptForProjectName } from "../prompt";
import {
  hasEverPublished,
  publishNudgeLine,
  shouldShowPublishNudge,
} from "../publish-nudge";
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
  /** Unmetered plan (enterprise): the balance sentence reads "unlimited". */
  unlimited?: boolean;
}

/** The single up-front spend disclosure (pricing v11, #2290): flat audit base
 * + 2 per audited page up to the page ceiling, everything else included.
 * Accepting it skips the later post-crawl prompt. */
export function consentEstimateLine(est: CloudConsentEstimate): string {
  const base = computeCost("audit_base", 1);
  const pagesEst = computeCost("audit_page", est.maxPages);
  const cap =
    est.maxCredits > 0 ? `, up to ${est.maxCredits} credits/audit` : "";
  const bal = est.unlimited
    ? " Balance: unlimited credits."
    : est.balance != null
      ? ` Balance: ${est.balance.toLocaleString("en-US")} credits.`
      : "";
  const pages = est.maxPages === 1 ? "page" : "pages";
  return `About ${estimateAuditCap({ maxPages: est.maxPages })} credits: ${base} audit base + ${pagesEst} for up to ${est.maxPages} audited ${pages} (${AUDIT_PAGE_CREDITS} each, however the page is fetched), all analysis included${cap}.${bal}`;
}

/** #1169 / #2290 preflight: what the audit will cost and the page cap its credits can pay for. */
export interface PreflightAffordability {
  /** Flat audit base. */
  base: number;
  /** 2 credits per page of the (possibly clamped) page cap. */
  pagesCost: number;
  /** base + pagesCost — an UPPER bound (the crawl may find fewer pages). */
  estimate: number;
  /** The page cap to crawl with. 0 ⇒ not even one page is affordable. */
  maxPages: number;
  /** The cap came down from what was asked for. */
  clamped: boolean;
  /** What bound it, when clamped: the balance, or `[cloud] max_credits_per_audit`. */
  limitedBy?: "balance" | "cap";
  /** Two-line (uncoloured) notice when `clamped`, else empty. */
  noticeLines: string[];
}

/**
 * #1169 / #2290: fit a signed-in audit's page cap to what it can pay for.
 *
 * Pricing v11 charges every audited page, however it was fetched, so the cost
 * is trivially predictable: `base + 2 × pages`. An audit priced past the balance
 * (or past the user's own `[cloud] max_credits_per_audit`) used to run anyway
 * and stop paying part-way; now the page cap comes DOWN to what the credits
 * cover, and the run says so, rather than refusing an audit a smaller crawl
 * could afford. The caller drops to local-only only when not even one page is
 * affordable (`maxPages === 0`). Pricing comes from the shared source, never
 * hardcoded. Extracted from the command body so the math + copy are
 * unit-testable (mirrors consentEstimateLine).
 */
export function computePreflightAffordability(opts: {
  balance: number;
  maxPages: number;
  /** `[cloud] max_credits_per_audit`; 0 = no cap. */
  maxCreditsPerAudit: number;
  topUpUrl: string;
  /**
   * The plan is not metered against `balance` (enterprise). The balance bounds
   * nothing, so only the user's own credit cap can clamp. Absent = metered.
   */
  unlimited?: boolean;
  /**
   * #2183: when the monthly grant comes back (`balance.periodEnd`). Waiting is
   * a real answer to a clamped audit, but only once it has a date on it.
   */
  resetAt?: string | null;
}): PreflightAffordability {
  const base = computeCost("audit_base", 1);
  const budget = clampAuditPages({
    maxPages: opts.maxPages,
    balance: opts.balance,
    unlimited: opts.unlimited,
    cap: opts.maxCreditsPerAudit,
  });
  const pagesCost = computeCost("audit_page", budget.maxPages);
  const estimate = base + pagesCost;
  const pricing = `${base} base + ${AUDIT_PAGE_CREDITS} per audited page`;
  const requested = budget.requestedMaxPages.toLocaleString("en-US");
  const covered = budget.maxPages.toLocaleString("en-US");
  const stopsAt = budget.maxPages === 1 ? "1 page" : `${covered} pages`;
  const resetOn = resetDateLabel(opts.resetAt);
  let noticeLines: string[] = [];
  if (budget.clamped && budget.limitedBy === "cap") {
    noticeLines = [
      `⚠ [cloud] max_credits_per_audit = ${opts.maxCreditsPerAudit.toLocaleString("en-US")} covers ${covered} of the ${requested} pages requested (${pricing}), so this audit stops at ${stopsAt}.`,
      "  Raise max_credits_per_audit (0 = no cap) to audit more.",
    ];
  } else if (budget.clamped) {
    noticeLines = [
      `⚠ Your balance of ${opts.balance.toLocaleString("en-US")} credits covers ${covered} of the ${requested} pages requested (${pricing}), so this audit stops at ${stopsAt}.`,
      // #2183: the same facts the other CLI walls carry. `topUpUrl` is the
      // server's org-scoped link when there is one, so one click lands on
      // checkout for the org that is short rather than the last-used one.
      (resetOn ? `  Credits reset ${resetOn}.` : " ") +
        ` Top up for a full audit: ${opts.topUpUrl}`,
    ];
  }
  return {
    base,
    pagesCost,
    estimate,
    maxPages: budget.maxPages,
    clamped: budget.clamped,
    ...(budget.limitedBy ? { limitedBy: budget.limitedBy } : {}),
    noticeLines,
  };
}

/**
 * Lines printed when register failed definitively and the run went untracked.
 *
 * Out of credits gets the full offer rather than the server's one sentence: the
 * CLI is the surface most of these users live in, and 12 of the 13 orgs that
 * ever ran out of credits never came back, having never been shown a price. The
 * other definitive codes (website limit, org locked) are not a plan problem, so
 * they keep the plain one-liner.
 *
 * Exported for tests. Returns plain lines; the caller does the printing.
 */
export function registerFailureLines(
  failure: RegisterFailure,
  /**
   * The account's plan is not metered. An unmetered account CANNOT genuinely be
   * out of credits, so this code can only mean the server disagrees with what
   * the preflight told us: a stale deploy, or a plan change mid-run. Report that
   * honestly instead of pitching Pro at someone on a contracted plan, which is
   * both wrong and leaks an internal plan's existence into a sales pitch.
   */
  unlimited = false,
  /**
   * The account is already on a paid plan, so there is no plan to sell it. An
   * absent offer from an OLD server still gets the Pro pitch (a free account
   * is the likely case), but a paid account is pointed at a top-up instead of
   * being pitched the plan it pays for.
   */
  paidPlan = false
): string[] {
  if (failure.code !== "INSUFFICIENT_CREDITS") {
    return [`⚠ Run not tracked in your dashboard: ${failure.message}`];
  }
  if (unlimited) {
    return [
      fmt.yellow(
        "⚠ Run not tracked in your dashboard: the server refused it as"
      ),
      `  ${fmt.yellow("insufficient credits, but this account is unmetered.")}`,
      `  ${fmt.dim("The server may be running an older build. The audit itself ran locally and its results below are complete.")}`,
    ];
  }
  // #2183: cost, remaining and reset date, all read off the refusal. `required`
  // is what the server actually refused, which is not always the flat base — a
  // future price change would otherwise have the CLI quoting a stale number
  // from a binary nobody can correct.
  const needed = failure.required ?? AUDIT_BASE_CREDITS;
  const balanceLine =
    failure.balance != null
      ? `You have ${failure.balance.toLocaleString("en-US")} credits and this audit needs ${needed.toLocaleString("en-US")}. ${AUDIT_PRICING_LINE}`
      : `This audit needs ${needed.toLocaleString("en-US")} credits. ${AUDIT_PRICING_LINE}`;
  // Waiting is a real answer to "out of credits", and it was never priced
  // against a date before — so nobody could weigh it against paying.
  const resetOn = resetDateLabel(failure.resetAt);
  return [
    fmt.yellow(
      "⚠ Out of cloud credits. This run is not tracked in your dashboard."
    ),
    `  ${balanceLine}`,
    ...(resetOn
      ? [`  ${fmt.dim(`Your monthly credits reset on ${resetOn}.`)}`]
      : []),
    // Say plainly that nothing was lost. A warning that reads like a failure is
    // why "the audit still ran" never landed.
    `  ${fmt.dim("The audit itself ran locally and its results below are complete.")}`,
    // The server's own offer when it sent one: its link already names the org
    // that hit the wall, so the upgrade is one click rather than a login, an
    // org switch and a hunt for billing.
    ...(paidPlan && !failure.upgrade
      ? [`  Top up: ${fmt.cyan(upgradeUrl("cli-audit"))}`]
      : offerPitchLines(failure.upgrade, "cli-audit")),
  ];
}

/**
 * Can this signed-in account start a CLOUD audit, given its balance preflight?
 *
 * Pricing v11 (#2290): every signed-in audit debits a flat base at registration
 * plus 2 per audited page, so a balance below the base plus ONE page cannot
 * start one and the run drops to local-only (no register, no cloud calls, no
 * publish) rather than letting the server 402 the register mid-crawl. Anything
 * above that runs, with its page cap fitted to the balance by
 * computePreflightAffordability.
 *
 * An unmetered plan is EXEMPT. Its stored total is frozen and usually 0, and the
 * server records the debit rather than deducting it, so comparing the number
 * here would silently drop an enterprise org to local-only on every run: #1588's
 * failure mode (eleven nights of anonymous audits misread as a rule regression)
 * reproduced on a perfectly healthy account.
 *
 * Extracted from the command body so this branch is unit-testable. The inline
 * version could only be reached by running a full audit, which is exactly why a
 * missing flag check here would go unnoticed.
 */
export function canStartCloudAudit(balance: {
  total: number;
  unlimited?: boolean;
}): boolean {
  if (isUnlimitedBalance(balance)) return true;
  return balance.total >= minimumAuditCredits();
}

/** Warn once the balance drops below this share of the plan's monthly grant. */
const LOW_BALANCE_FRACTION = 0.2;

/**
 * End-of-run low-balance warning, mirroring the dashboard's banner for people
 * who never open the dashboard.
 *
 * Fires at 20% of the plan's monthly grant — while there are still credits to
 * spend and a decision to make — and again, more sharply, once the balance is
 * under the smallest audit (base + one page) and can buy nothing. Free plans get the Pro offer; paid
 * plans get a top-up link, not a pitch for the plan they're already on.
 *
 * Exported for tests.
 */
export function lowBalanceFooterLines(opts: {
  balance: number | null;
  monthlyCredits: number;
  plan: "anonymous" | "free" | "paid";
  /**
   * The plan is not metered (enterprise). An unmetered account can never be low
   * on credits, so this warning — and the top-up/upgrade offer attached to it —
   * must never fire for one. Absent = metered.
   */
  unlimited?: boolean;
  /**
   * #2183: the server's offer for THIS org, off `GET /v1/credits`. Its link
   * already names the org, so the upgrade is one click from the terminal.
   * Absent on an older API; the pitch then falls back to the static URL.
   */
  upgrade?: UpgradeOffer | null;
  /** When the monthly grant comes back (`balance.periodEnd`). */
  resetAt?: string | null;
}): string[] {
  const { balance, monthlyCredits, plan } = opts;
  if (opts.unlimited) return [];
  if (balance == null || plan === "anonymous") return [];

  const minimum = MIN_AUDIT_CREDITS;
  const spent = balance < minimum;
  // A plan with no monthly grant (Team pools per seat) has no share to measure
  // against, so it only warns once the balance can't buy an audit.
  const threshold =
    monthlyCredits > 0
      ? Math.floor(monthlyCredits * LOW_BALANCE_FRACTION)
      : minimum;
  if (!spent && balance >= threshold) return [];

  const headline = spent
    ? fmt.yellow(
        `${balance.toLocaleString("en-US")} credits left, below the ${minimum} credits the smallest audit needs (${AUDIT_BASE_CREDITS} base + ${AUDIT_PAGE_CREDITS} for one page): the next cloud audit can't start.`
      )
    : fmt.yellow(
        `${balance.toLocaleString("en-US")} credits left. ${AUDIT_PRICING_LINE}`
      );

  const resetOn = resetDateLabel(opts.resetAt);
  const resetLine = resetOn
    ? [`  ${fmt.dim(`Your monthly credits reset on ${resetOn}.`)}`]
    : [];

  if (plan === "free")
    return [
      headline,
      ...resetLine,
      ...offerPitchLines(opts.upgrade ?? null, "cli-audit"),
    ];
  return [
    headline,
    ...resetLine,
    `  Top up: ${fmt.cyan(opts.upgrade?.url ?? upgradeUrl("cli-audit"))}`,
  ];
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
 * The balance to print after a signed-in audit (#2290), from the freshest read
 * the run made. The controller's post-services read (`prefetchRead`) already
 * reflects the crawl's render charges, so only the end-of-run page settlement
 * comes off it. Without one (quick coverage skips the prefetch), the register
 * response's balance is all there is, and it predates EVERYTHING but the base:
 * every later charge comes off it. An unmetered balance is frozen, so nothing
 * comes off at all. Exported for tests.
 */
export function estimateBalanceAfter(opts: {
  prefetchRead: number | null;
  afterBase: number | null;
  baseCharged: number;
  totalSpent: number;
  settled: number;
  unlimited?: boolean;
}): number | null {
  if (opts.unlimited) return opts.prefetchRead ?? opts.afterBase;
  if (opts.prefetchRead != null)
    return Math.max(0, opts.prefetchRead - opts.settled);
  if (opts.afterBase != null)
    return Math.max(0, opts.afterBase - (opts.totalSpent - opts.baseCharged));
  return null;
}

/**
 * The post-audit cloud-spend disclosure line: total + per-service breakdown +
 * remaining balance. The breakdown reflects the ACTUAL server charges (pricing
 * v11: audit base + 2 per audited page; folded services charge nothing), and
 * names the page count so the arithmetic is checkable at a glance. Exported for
 * tests. #279 #2290
 */
export function formatCloudSpendSummary(spend: {
  lines: Array<{
    service: string;
    credits: number;
    feature?: string;
    units?: number;
  }>;
  totalSpent: number;
  balanceAfter: number | null;
}): string {
  const byService = spend.lines
    .map((l) =>
      l.feature === "audit_page" && l.units != null
        ? `${l.units} audited ${l.units === 1 ? "page" : "pages"} ${l.credits}`
        : `${l.service} ${l.credits}`
    )
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
          // #2290: --http skips the browser, not the page charge.
          capped
            ? ` Skip the cloud browser with --http, or audit locally for free with --offline.`
            : ""
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
/**
 * Whether this run registers with the cloud at all (#271).
 *
 * Its own named predicate rather than an inline `&&` at the call site, because
 * the #1841 clause is an invariant with a test, not a convenience: registering
 * a local or private-network audit is what created the hosted website with a
 * weekly screenshot refresh that could never succeed. An inline condition can
 * be deleted without failing anything.
 */
export function resolveRegisterDecision(opts: {
  signedIn: boolean;
  offline: boolean;
  /** #1841: the audited host is loopback / RFC1918 / link-local / internal. */
  nonPublicHost: boolean;
  /**
   * The audit level's cloud checks setting. Off (the quick level) means local
   * rules only, and a local audit spends no credits, so the run does not
   * register: registering is what debits the audit base and settles the
   * pages. Undefined is treated as on, which is what every run did before
   * audit levels.
   */
  cloudChecks?: boolean;
}): boolean {
  // No cloud state for a host no hosted runner can reach, and no audit base
  // charged for cloud work that cannot happen.
  if (opts.nonPublicHost) return false;
  if (opts.offline) return false;
  if (opts.cloudChecks === false) return false;
  return opts.signedIn;
}

export function resolvePublishDecision(opts: {
  signedIn: boolean;
  offline: boolean;
  explicitPublish: boolean; // args.publish
  noPublish: boolean; // --no-publish, read from argv (see cli/flags.ts)
  configPublish: boolean; // config.cloud.publish
  // #1066: a --rule-include/--rule-exclude run produces a partial report
  // (fewer categories, no partial marker on the publish payload yet — #1082
  // tracks that). Auto-publishing it would silently replace the site's full
  // report in the dashboard, so treat it like an implicit --no-publish
  // unless the user explicitly asks with --publish.
  ruleFilterActive?: boolean;
  // #1841: the audited host is loopback / RFC1918 / link-local, so no hosted
  // service can ever reach it.
  nonPublicHost?: boolean;
}): boolean {
  // BEFORE explicitPublish, unlike every other opt-out here. The rest of this
  // function resolves a PREFERENCE, and an explicit --publish rightly wins
  // those. This one is a CAPABILITY: a hosted report for http://localhost:3000
  // is a dashboard card nothing in the cloud can screenshot, re-audit or
  // schedule, and creating one is exactly the recurring production failure
  // #1841 is about. The audit still runs and still prints its report.
  if (opts.nonPublicHost) return false;
  if (opts.offline) return false;
  if (opts.explicitPublish) return true; // explicit --publish overrides opt-outs (still needs login; publishReport errors otherwise)
  if (opts.ruleFilterActive) return false;
  if (opts.noPublish || !opts.configPublish) return false;
  return opts.signedIn; // default: publish when signed in
}

/**
 * A boolean flag's value as citty delivers it: undefined when absent, and an
 * array when the flag is repeated, in which case the last one wins.
 */
export function lastFlagValue(
  value: boolean | boolean[] | undefined
): boolean | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

/**
 * The probing flags as citty delivered them. Booleans repeat into arrays (the
 * last wins, like --disable-discovery-probes); a repeated `--probe` arrives as
 * an array of strings, and the last one wins too.
 */
export function probeFlagsFromArgs(args: Record<string, unknown>): ProbeFlags {
  const lastString = (value: unknown): string | undefined =>
    Array.isArray(value)
      ? (value.at(-1) as string | undefined)
      : typeof value === "string"
        ? value
        : undefined;
  return {
    probe: lastString(args.probe),
    passive: lastFlagValue(args.passive as boolean | boolean[] | undefined),
    aggressive: lastFlagValue(
      args.aggressive as boolean | boolean[] | undefined
    ),
    pentest: lastFlagValue(args.pentest as boolean | boolean[] | undefined),
    probeBudget: lastString(args["probe-budget"]),
  };
}

/**
 * Resolve probing intensity for a local CLI run (see resolveProbeIntensity in
 * @squirrelscan/config, which the hosted runner shares). Mirrors
 * resolveExplicitRenderMode: flags > config > the audit level's probe setting
 * > context default. A local run is never locked; the cloud inputs are the
 * hosted caller's to supply.
 */
export function resolveLocalProbeIntensity(opts: {
  flags: ProbeFlags;
  config: {
    crawler: { disable_discovery_probes?: boolean };
    security?: {
      probe?: "passive" | "active" | "aggressive";
      budget?: string | number;
    };
  };
  /** An account is behind the run (any plan, or signed in with the API unreachable). */
  signedIn: boolean;
  /** --disable-discovery-probes[=false]; undefined → config decides. */
  disableDiscoveryProbes?: boolean;
  /** The raw level flag, so --pentest can refuse a level other than full. */
  coverage?: string;
  /** The level the run resolved to; its probe setting is the default. */
  level?: AuditLevel;
}): ProbeResolution {
  const context: ProbeRunContext = {
    surface: "local",
    signedIn: opts.signedIn,
    discoveryProbesDisabled:
      opts.disableDiscoveryProbes ??
      opts.config.crawler.disable_discovery_probes === true,
  };
  const levelProbe =
    opts.level === undefined
      ? undefined
      : AUDIT_LEVEL_PRESETS[opts.level].probe;
  return resolveProbeIntensity({
    flags: opts.flags,
    config: opts.config.security,
    context,
    coverage: opts.coverage,
    // No level defaults to aggressive (core-contracts pins it), so this never drops a value.
    ...(levelProbe !== undefined && levelProbe !== "aggressive"
      ? { levelDefault: levelProbe }
      : {}),
  });
}

/** The run-banner line and notes for a resolved probing level. */
export function probeBannerLines(probe: {
  level: "passive" | "active" | "aggressive";
  budgetMs: number;
}): { value: string; note?: string } {
  if (probe.level === "passive") {
    return { value: "passive · no requests beyond the crawl" };
  }
  const value = `${probe.level} · budget ${formatProbeBudget(probe.budgetMs)}`;
  if (probe.level !== "aggressive") return { value };
  return {
    value,
    note: "Aggressive probing requests robots-disallowed paths on purpose and sends many requests that return 404, which can trip a WAF. Only run it against sites you own or are authorized to test.",
  };
}

/**
 * Validate mutually-exclusive audit flags. Returns a human-readable error to
 * print (then exit 1), or null when the combination is valid.
 */
export function validateAuditFlags(args: {
  offline?: boolean;
  publish?: boolean;
  noPublish?: boolean;
  render?: boolean;
  http?: boolean;
}): string | null {
  // --offline conflicts with flags that require the cloud API.
  if (args.offline && (args.publish || args.render)) {
    const conflicting = args.publish ? "--publish" : "--render";
    return `--offline cannot be combined with ${conflicting} (requires login and cloud access)`;
  }
  // --no-publish (skip publishing) contradicts --publish (force publishing).
  if (args.noPublish && args.publish) {
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
      description: `Maximum pages to crawl (default by level: ${AUDIT_LEVELS.map((l) => `${l} ${levelMaxPages(l)}`).join(", ")}; cap ${MAX_PAGES_CAP})`,
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
    level: {
      type: "string",
      description: `Audit level (default: quick if signed out, surface if signed in): ${levelHelpList()}. Flags such as --max-pages, --render-mode and --probe change single settings`,
    },
    coverage: {
      type: "string",
      alias: "C",
      description: "Old name for --level, still accepted (fast = quick)",
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
    // Declared for help and completions only: citty delivers --no-publish as
    // publish: false and never sets this arg, so run() reads it from rawArgs.
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
    "disable-discovery-probes": {
      type: "boolean",
      description:
        "Skip the pre-crawl discovery probes (llms.txt, /.well-known/*, /swagger.json, ...) for this run; overrides [crawler] disable_discovery_probes (=false sends them)",
    },
    probe: {
      type: "string",
      alias: "P",
      description:
        "Probing intensity: passive (no requests beyond the crawl) | active (quiet probes that look like normal traffic) | aggressive (loud probes, can trip a WAF). Default: active if signed in, passive if not. Overrides [security] probe",
    },
    passive: {
      type: "boolean",
      description: "Shortcut for --probe passive",
    },
    aggressive: {
      type: "boolean",
      description: "Shortcut for --probe aggressive",
    },
    "probe-budget": {
      type: "string",
      description:
        "Wall-clock cap for all probing in this run, e.g. 30s, 2m (default: 30s active, 2m aggressive; max 1h). Overrides [security] budget",
    },
    pentest: {
      type: "boolean",
      description: "Shortcut for --level full --probe aggressive",
    },
    summary: {
      type: "boolean",
      description:
        "Print only the score, category breakdown, and issue counts, with no per-issue detail (console format only)",
    },
  },
  async run({ args, rawArgs }) {
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
      cwd: cwdOr(CWD_UNAVAILABLE),
      version: packageVersion,
      bunVersion: Bun.version,
      platform: platform(),
      arch: process.arch,
    });

    // From argv, not args: citty never sets args["no-publish"], and once
    // --no-publish is passed its publish value depends on argv order, so any
    // --publish/-p token alongside it counts as the conflict.
    const noPublish = hasNegatedFlag(rawArgs, "publish");
    const flagError = validateAuditFlags({
      ...args,
      publish:
        !!args.publish || (noPublish && hasFlag(rawArgs, "publish", ["p"])),
      noPublish,
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

    // --disable-discovery-probes (#409): a plain boolean, so citty delivers
    // true, or false for `=false` (which turns the probes back on over a config
    // that disables them). A repeated flag arrives as an array; the last wins.
    const disableDiscoveryProbes = lastFlagValue(
      args["disable-discovery-probes"] as boolean | boolean[] | undefined
    );

    // Probing flags: refuse an unknown level, a bad budget or contradicting
    // shortcuts before any network work. The level itself resolves below, once
    // the account status (which picks the default) is known; this context is
    // only for validation and cannot fail on its own.
    // --level, or its old name --coverage / -C. Read before the probing
    // check, which needs it to refuse --pentest with a level other than full.
    const levelFlag = readLevelFlag(args);
    if (!levelFlag.ok) {
      console.error(`${fmt.red("Error:")} ${levelFlag.error}`);
      process.exitCode = 1;
      return;
    }

    const probeFlags = probeFlagsFromArgs(args);
    const probeFlagCheck = resolveProbeIntensity({
      flags: probeFlags,
      context: { surface: "local", signedIn: false },
      // citty hands a repeated -C over as an array, read as its comma-joined
      // text (see readLevelFlag), which the level check below refuses.
      coverage: levelFlag.raw,
    });
    if (!probeFlagCheck.ok) {
      console.error(`${fmt.red("Error:")} ${probeFlagCheck.error}`);
      process.exitCode = 1;
      return;
    }

    // A level named on the command line must be one, before any network work.
    // Only the DEFAULT level waits for the account check below.
    if (
      levelFlag.raw !== undefined &&
      parseAuditLevel(levelFlag.raw) === null
    ) {
      console.error(
        `${fmt.red("Error:")} ${unknownLevelMessage(levelFlag.raw)}`
      );
      process.exitCode = 1;
      return;
    }

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
        // The "✓ auto-updated" notice is printed once per RUN by cli/index.ts,
        // not per command — every command has to announce an update applied
        // before it, not just this one (#170).
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
      // Enterprise (unmetered) org: the balance numbers are frozen and must
      // never be compared against a price or shown as a spendable figure.
      let unlimitedCredits = false;
      // Plan tier of the signed-in account, captured from the balance preflight.
      // Drives the report's locked-rules messaging (#368): "free" → soft Pro hint,
      // "paid" → genuinely-unavailable framing, "anonymous" → free-account upsell.
      // Also picks the default coverage mode below (signed-in → surface).
      let accountPlan: "anonymous" | "free" | "paid" = "anonymous";
      // Monthly grant for the signed-in plan, so the footer can warn at a
      // share of it rather than only once the balance is already spent.
      let planMonthlyCredits = 0;
      // White-label branding for local html/markdown/text/xml exports (#810).
      // Present only when the signed-in org is on the Team plan (API decides).
      let reportBranding: ReportBranding | undefined;
      // #2183: the server's upgrade offer and the credit reset date, captured
      // from the same preflight read as the balance. Both walls the CLI can
      // show — the preflight drop to local-only, and the end-of-run low-balance
      // footer — happen WITHOUT a 402, so this is the only place they can get
      // an org-targeted link and a date.
      let upgradeOffer: UpgradeOffer | null = null;
      let creditsResetAt: string | null = null;
      // Did the user EXPECT cloud (had a token) but we can't use it this run?
      // Drives the interactive guard below. null = no outage (clean state).
      let cloudOutage: "expired" | "unreachable" | null = null;
      if (args.offline) {
        kv("Account", fmt.dim("offline (--offline) — cloud features disabled"));
      } else if (statusClient && accountLabel) {
        try {
          const { balance, plan, branding, upgrade } =
            await statusClient.getBalance();
          startingBalance = balance.total;
          unlimitedCredits = isUnlimitedBalance(balance);
          accountPlan = plan.id === "free" ? "free" : "paid";
          planMonthlyCredits = plan.monthlyCredits;
          reportBranding = branding;
          upgradeOffer = upgrade ?? null;
          creditsResetAt = balance.periodEnd ?? null;
          // Pricing v11 (#2290): every signed-in audit debits a flat base at
          // registration plus 2 per audited page. A balance below the base plus
          // one page can't start one — run local-only (no register, no cloud
          // calls, no publish) instead of letting the server 402 the register
          // mid-crawl. Above that, the page cap is fitted to the balance below.
          //
          // An unmetered plan is exempt: its stored total is frozen (often 0)
          // and the server never refuses the debit, so comparing it here would
          // silently drop an enterprise org to local-only every run (#1588 is
          // the same failure mode with a real empty balance).
          if (!canStartCloudAudit(balance)) {
            // #2183: the org-targeted link when the server sent one. This is
            // the CLI's most-seen credit wall — the run never registers, so it
            // never collects the 402 that carries the same offer.
            kv(
              "Account",
              `${accountLabel} · ${fmt.yellow(`${balance.total.toLocaleString("en-US")} credits — below the ${MIN_AUDIT_CREDITS} a one-page audit needs, running local-only`)} · ${accountPlan === "paid" && !upgrade ? "top up" : "upgrade"}: ${fmt.cyan(upgrade?.url ?? upgradeUrl("cli-audit"))}`
            );
          } else {
            signedIn = true;
            kv(
              "Account",
              `${accountLabel} · ${fmt.bold(formatBalance(balance.total, unlimitedCredits))} credits`
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

      // Resolve the audit level: --level / -C > --pentest (full) > [crawler]
      // coverage > auth-aware default. Any signed-in plan (free OR paid)
      // defaults to `surface` (cloud checks + editor summary on a page sample,
      // pro-parity demo #684); only anonymous defaults to `quick` (local rules,
      // no spend). The flag is a free string (citty has no enum), so it is
      // parsed (see audit-level.ts): an unknown value would otherwise make the
      // page budget `undefined`, a NaN cap and an unbounded crawl.
      // Transient outage: keep the signed-in user's level (no spend while cloud is down); expired token stays anon.
      const levelAccountPlan =
        cloudOutage === "unreachable" ? "paid" : accountPlan;
      const levelInput =
        levelFlag.raw ??
        (probeFlags.pentest ? "full" : undefined) ??
        config.crawler.coverage ??
        defaultAuditLevel(levelAccountPlan);
      const level = parseAuditLevel(levelInput);
      if (level === null) {
        console.error(
          `${fmt.red("Error:")} ${unknownLevelMessage(levelInput)}`
        );
        process.exitCode = 1;
        return;
      }

      // Smart audits (#684): explicit `smart_audits` config always wins; the
      // default matrix (signed-in/expired/unreachable → on, anonymous → off)
      // lives in defaultSmartAudits (coverage.ts) with its own tests.
      const smartAudits =
        config.smart_audits ?? defaultSmartAudits(accountPlan, cloudOutage);

      // Probing intensity: --probe > --passive/--aggressive/--pentest >
      // [security] probe > the level's probe setting (quick passive, surface
      // and full active). Disabled discovery probes force passive.
      const probeResolution = resolveLocalProbeIntensity({
        flags: probeFlags,
        config,
        signedIn: levelAccountPlan !== "anonymous",
        disableDiscoveryProbes,
        coverage: levelFlag.raw,
        level,
      });
      if (!probeResolution.ok) {
        console.error(`${fmt.red("Error:")} ${probeResolution.error}`);
        process.exitCode = 1;
        return;
      }
      const probing = probeResolution.value;
      for (const notice of probing.notices) console.error(fmt.yellow(notice));

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
      // The render setting the user chose (flags > [cloud] render > [cloud]
      // rendering), or undefined for the level's own. Resolved here, not at
      // the consent step below, because the banner has to say when it changes
      // the level.
      const requestedRenderMode = resolveExplicitRenderMode(
        { http: args.http, render: args.render, renderMode: renderModeArg },
        config
      );

      // CLI --max-pages > config max_pages (if non-default) > the level's page budget
      const configMaxPagesIsDefault = config.crawler.max_pages === 100;
      const requestedMaxPages = args["max-pages"]
        ? Number.parseInt(args["max-pages"], 10)
        : configMaxPagesIsDefault
          ? levelMaxPages(level)
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
      // Clamp and SAY SO (#1909). Silently applying the cap made a request for
      // 10,000 pages indistinguishable from a 5,000-page site, and the existing
      // notice in cli/format.ts only fires when a crawl reaches the cap — so a
      // 10,000-page request against a 4,000-page site was never mentioned.
      const pageLimit = resolvePageLimit(requestedMaxPages);
      // `let`: the credit preflight below may fit it to the balance (#2290).
      let maxPages = pageLimit.effective;
      const clampNotice = pageLimitNotice(pageLimit);
      if (clampNotice) console.error(fmt.yellow(clampNotice));

      // The audit level with every setting the user chose laid over it; a
      // chosen value that differs from the level's makes the run custom.
      // `[external_links] enabled` is a choice only when it is false: true is
      // the schema default `squirrel init` writes into every config, and it
      // would otherwise switch the quick level's link checks on for everyone.
      const configOverrides = configLevelOverrides(config);
      const auditLevel = resolveLocalAuditLevel(level, {
        pages: maxPages,
        ...(requestedRenderMode !== undefined
          ? { render: requestedRenderMode }
          : {}),
        ...(configOverrides.externalLinks !== undefined
          ? { externalLinks: configOverrides.externalLinks }
          : {}),
        probe: probing.level,
      });
      // The crawler's word for the strategy: quick, surface or full.
      const coverageMode = levelCoverageMode(auditLevel);

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
        // Carried so the report can record the clamp; the controller stamps it.
        ...(pageLimit.clamped
          ? { requestedMaxPages: pageLimit.requested }
          : {}),
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
        auditLevel,
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
        ...(disableDiscoveryProbes !== undefined
          ? { disableDiscoveryProbes }
          : {}),
        probe: { level: probing.level, budgetMs: probing.budgetMs },
      };

      // Preamble — aligned key/value block (Account, and Dashboard when online,
      // already printed above during status resolution; kv defined there).
      kv("Auditing", fmt.bold(options.url));
      const levelBanner = levelBannerParts(auditLevel);
      kv(
        "Level",
        levelBanner.detail
          ? `${levelBanner.level} ${fmt.dim(levelBanner.detail)}`
          : levelBanner.level
      );
      const probeBanner = probeBannerLines(probing);
      kv("Probing", probeBanner.value);
      if (probeBanner.note) log(fmt.yellow(probeBanner.note));
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

      // #403: a local store this process cannot write (owned by root after a
      // sudo run, blocked by an agent's sandbox, a directory, a damaged file)
      // otherwise fails at the first page, or drops every page and ends "No
      // pages were crawled". Checked before the run is registered, so a broken
      // store charges nothing and leaves no failed run behind.
      const storeUrl = parseUserUrl(args.url);
      const storeProblems = storeUrl.ok
        ? checkAuditStores(
            options.projectName ?? domainToProjectName(storeUrl.url),
            { linkCache: !args.offline && auditLevel.settings.externalLinks }
          )
        : [];
      if (storeProblems.length > 0) {
        commandResult = "error";
        log(`✗ ${formatStoreProblems(storeProblems)}`);
        process.exitCode = 1;
        return;
      }

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
        console.error(
          `${fmt.dim(tipLabel())}${pickTip({
            // A plan pitch only goes to someone who could act on it. A paid
            // account already has the feature being sold, and an unmetered one
            // cannot buy a plan at all — `unlimitedCredits` is checked as well as
            // the tier because it is the flag that must never leak an upsell.
            includeSales: accountPlan !== "paid" && !unlimitedCredits,
          })}`
        );
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

      // #1841 cloud preflight. A loopback / RFC1918 / link-local target is
      // auditable (the crawl runs here) but unreachable for every hosted
      // service, so this run hands NOTHING to the cloud that needs to fetch
      // the address: no render submit, no run registration, no publish. Decided
      // once, before the first API call, off the same normalization the crawl
      // uses. The API refuses these independently — this only spares the user a
      // charge and a failure they cannot fix.
      const nonPublicHost = nonPublicHostLabel(args.url);

      // #1169 / #2290: fit the page cap to what this audit can pay for. Pricing
      // v11 charges 2 credits for EVERY audited page, however it was fetched,
      // so an audit priced past the balance (or past the user's own
      // `[cloud] max_credits_per_audit`) would run out part-way. The cap comes
      // down to what the credits cover and the run says so, rather than
      // refusing an audit a smaller crawl could afford. Decided before the
      // consent line below so the estimate it quotes is the clamped one.
      //
      // Only when the run will actually register (and so be charged). #1841:
      // never for a local/private host, which does not register — left in, a
      // low-balance user auditing localhost got a top-up warning for money
      // nothing was going to take.
      let creditClamp:
        | {
            requestedMaxPages: number;
            effectiveMaxPages: number;
            limitedBy: "balance" | "cap";
          }
        | undefined;
      if (
        startingBalance != null &&
        resolveRegisterDecision({
          signedIn,
          offline: !!args.offline,
          nonPublicHost: !!nonPublicHost,
          cloudChecks: auditLevel.settings.cloudChecks,
        })
      ) {
        const preflight = computePreflightAffordability({
          balance: startingBalance,
          maxPages,
          maxCreditsPerAudit: config.cloud.max_credits_per_audit,
          // #2183: the server's org-scoped link when the preflight read one.
          topUpUrl: upgradeOffer?.url ?? upgradeUrl("cli-audit"),
          unlimited: unlimitedCredits,
          resetAt: creditsResetAt,
        });
        if (preflight.maxPages === 0) {
          // Only the user's own cap can get here: canStartCloudAudit already
          // guaranteed the balance covers one page. Their cap forbids any
          // charged audit at all, so run the free local audit instead.
          log("");
          log(
            fmt.yellow(
              `⚠ [cloud] max_credits_per_audit = ${config.cloud.max_credits_per_audit} is below the ${MIN_AUDIT_CREDITS} credits a one-page audit needs, running local-only.`
            )
          );
          signedIn = false;
        } else if (preflight.clamped && preflight.limitedBy) {
          creditClamp = {
            requestedMaxPages: maxPages,
            effectiveMaxPages: preflight.maxPages,
            limitedBy: preflight.limitedBy,
          };
          maxPages = preflight.maxPages;
          options.maxPages = maxPages;
          log("");
          log(fmt.yellow(preflight.noticeLines[0]!));
          log(fmt.dim(preflight.noticeLines[1]!));
        }
      }

      // Resolve the render strategy (#294). `off`/`auto`/`all` is funneled into
      // the existing http/browser consent decision (off→http, auto|all→browser)
      // so the spend-consent flow is unchanged; the auto-vs-all *strategy* is
      // passed separately to the controller (hybrid vs render-all). Unset →
      // the level's render setting (quick auto, surface and full all).
      // `requestedRenderMode` was resolved with the level, above.
      // Rendering debits on SUBMIT and the crawler-worker then refuses the
      // host outright ("Refusing to render a non-public host"), so an
      // unpreflighted --render against localhost is a charge for a guaranteed
      // failure. Announce it only when the user actually asked for rendering —
      // the default (unset) mode is resolved in the controller and never
      // reached the cloud for a local host anyway.
      const explicitRenderMode = nonPublicHost ? "off" : requestedRenderMode;
      // Only when rendering was actually going to happen: the user asked for it
      // AND this run could have reached the cloud at all. Signed out or
      // --offline, cloud rendering was already off for other reasons, and
      // blaming the host there is a notice about nothing.
      if (
        nonPublicHost &&
        signedIn &&
        !args.offline &&
        (requestedRenderMode === "auto" || requestedRenderMode === "all")
      ) {
        const [why, what] = cloudRenderSkippedLines(nonPublicHost);
        log(fmt.yellow(`⚠ ${why}`));
        log(fmt.dim(what));
      }
      if (config.cloud.rendering && !config.cloud.render) {
        logger.debug(
          `[cloud] rendering = "${config.cloud.rendering}" is deprecated; prefer render = "${config.cloud.rendering === "http" ? "off" : "all"}"`
        );
      }
      const levelRender = auditLevel.settings.render;
      const renderStrategy =
        explicitRenderMode === "auto" || explicitRenderMode === "all"
          ? explicitRenderMode
          : explicitRenderMode === undefined &&
              (levelRender === "auto" || levelRender === "all")
            ? levelRender
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
          // A run without cloud checks (the quick level) spends no credits,
          // and a cloud render costs them, so it renders only when the user
          // asks for it (--render, --render-mode, [cloud] render). Unasked, it
          // fetches over HTTP like a signed-out run.
          signedIn:
            signedIn &&
            (auditLevel.settings.cloudChecks ||
              explicitRenderMode !== undefined),
          consent: effectiveSettings?.cloud_render_consent,
          // The once-only "cloud audits are on" cost line quotes an audit
          // charge. A run without cloud checks does not register and is not
          // charged, so it neither prints nor uses up that disclosure.
          spendAck: auditLevel.settings.cloudChecks
            ? effectiveSettings?.cloud_spend_ack
            : true,
          log,
          // Cost shown up front so the user can decline before the crawl.
          estimate: {
            maxPages,
            balance: startingBalance,
            maxCredits: config.cloud.max_credits_per_audit,
            unlimited: unlimitedCredits,
          },
        });

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
      let registerWarning: RegisterFailure | null = null;
      const registerPromise: Promise<RegisteredRun | null> =
        resolveRegisterDecision({
          signedIn,
          offline: !!args.offline,
          nonPublicHost: !!nonPublicHost,
          cloudChecks: auditLevel.settings.cloudChecks,
        })
          ? registerRun(
              {
                url: args.url,
                mode: "audit",
                // #271 phase 6: runner metadata (who/where ran it) stored on the
                // run's config jsonb; surfaced in the dashboard audit-detail header.
                config: {
                  maxPages,
                  coverageMode,
                  // The level and every setting it resolved to, so the
                  // dashboard can say what this run was.
                  auditLevel,
                  cliVersion: packageVersion,
                  runner: runnerInfo,
                  // #2290: the pricing this binary quotes and settles under, so
                  // the server can tell a v11 client from an older one.
                  pricingVersion: CREDIT_PRICING_VERSION,
                  // #2290: the page cap came down to fit the credits; recorded
                  // so the dashboard can say why this audit is smaller.
                  ...(creditClamp ? { creditClamp } : {}),
                },
              },
              (failure) => {
                registerWarning = failure;
              }
            )
          : Promise.resolve(null);
      // Captured for the in-crawl progress emits below: register resolves a beat
      // after this (fast round-trip), so by the time pages start landing the id
      // is set. Null until then → those early ticks simply no-op.
      let trackedRunId: string | null = null;
      // Base path resolved once at register; reused so the lifecycle stays consistent.
      let trackedBase: string | undefined;
      // Kept, not fired and forgotten: the terminal PATCH waits for this one
      // (see createRunFinalizer), or an audit that fails before it lands is
      // flipped back to running and reaped as stalled an hour later.
      const runningPromise = registerPromise
        .then(async (run) => {
          if (!run) return;
          trackedRunId = run.runId;
          trackedBase = run.lifecycleBase;
          await markRunning(
            run.runId,
            new Date(startTime).toISOString(),
            run.lifecycleBase
          );
        })
        .catch(() => {});

      // #332: one guarded finalizer for every exit path (--no-publish, error, Ctrl-C, crash) so none leaves the run pending to be reaped.
      finalizeTracked = createRunFinalizer(registerPromise, runningPromise);

      // #332: on interrupt, await a "cancelled" PATCH before re-raising so it lands instead of being reaped as a failure.
      const onSignal = (signal: NodeJS.Signals): void => {
        // SIGHUP means the terminal is gone: a write to it fails with EIO,
        // and an unhandled stream error (the progress spinner keeps writing)
        // would take the process down before the PATCH lands. Say nothing,
        // and let the streams fail quietly until the signal is re-raised.
        const canWrite = signal !== "SIGHUP";
        if (!canWrite) {
          process.stdout.on("error", () => {});
          process.stderr.on("error", () => {});
        }
        // Note the cancel so the user isn't left wondering during the PATCH (stderr keeps piped stdout clean).
        if (canWrite && trackedRunId)
          process.stderr.write("\nCancelling run…\n");
        // #1583: the crawl is checkpointed in the project's SQLite store, so the
        // pages fetched so far survive this exit — but nothing ever said so, and
        // a user who has just lost a 450-page crawl reasonably assumes it is gone
        // and starts over. Name the exact command while the context is on screen.
        if (canWrite && lastPagesFetched > 0) {
          process.stderr.write(
            `${lastPagesFetched} pages are saved. Resume with:\n  squirrel audit ${args.url} --resume\n`
          );
        }
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
        // Cast: bun-types >=1.4 declares off/removeListener("memoryPressure")
        // directly on Process, which hides the inherited EventEmitter overloads
        // (@types/node only spells out signal names for on/once). The cast
        // restores them; drop it once bun-types keeps the base signatures.
        const emitter = process as NodeJS.EventEmitter;
        emitter.off("SIGINT", onSignal);
        emitter.off("SIGTERM", onSignal);
        emitter.off("SIGHUP", onSignal);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      // Closing the terminal (or its window on Windows) aborts the audit as
      // surely as Ctrl-C does; without this the run was left to be reaped.
      process.once("SIGHUP", onSignal);

      // #271 phase 5: coarse page-progress, throttled to ≤1/s. `crawlPagesFailed`
      // is tallied from the raw crawler events (onEvent) since onProgress only
      // carries the processed count.
      let lastProgressAt = 0;
      let crawlPagesFailed = 0;
      const decodeFailures: string[] = [];
      const PROGRESS_MIN_INTERVAL_MS = 1_000;

      // #1583: newest counts seen from the crawl, kept OUTSIDE onProgress so the
      // heartbeat can still report them once onProgress has moved past
      // `crawling` (or returned entirely). They stop advancing when the crawl
      // ends, which is correct — the beat is then asserting "still alive, still
      // this many pages", not inventing progress.
      let lastPagesFetched = 0;
      let lastPagesTotal = maxPages;

      // Start the liveness beat as soon as the run exists. Every phase after the
      // crawl is silent on the wire, and the server reaps on silence, so without
      // this a long rules/render/publish stretch reads as a dead process.
      void registerPromise.then((run) => {
        if (!run) return;
        startRunHeartbeat(
          run.runId,
          () => ({
            pagesFetched: lastPagesFetched,
            pagesTotal: lastPagesTotal,
            pagesFailed: crawlPagesFailed,
          }),
          run.lifecycleBase
        );
      });

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
            ? async (
                estimate: number,
                // An unmetered org still confirms the spend (it is accounted
                // and invoiced), it just sees "balance: unlimited".
                balance: PreflightBalance
              ): Promise<boolean> => {
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
          // async-registered run id. #2290: it WAITS for register to settle
          // (bounded by register's own timeout): under pricing v11 a render
          // that went out untagged is billed as a standalone render AND its
          // page again when the run settles. No register (signed out, offline,
          // local host) resolves null at once, so those runs wait for nothing.
          getRunId: async () =>
            trackedRunId ??
            (await registerPromise.catch(() => null))?.runId ??
            undefined,
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
          // all = render every page. The level's setting unless overridden.
          renderStrategy,
          // The level's external link checks unless [external_links] enabled
          // in the config file says otherwise (--offline still turns them off).
          externalLinksEnabled: auditLevel.settings.externalLinks,
          // Retention (#1912) deleted some of this project's audit history, so
          // say so. stderr unconditionally: this is the one line that tells a
          // user their older reports are gone, and putting it on stdout would
          // corrupt `-f json` for the scripts that parse it.
          onRetention: (outcome) =>
            console.error(formatRetentionNotice(outcome)),
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
                if (isDecodeFailure(event.error))
                  decodeFailures.push(event.error);
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
                  lastPagesFetched = p.current;
                  lastPagesTotal = p.total ?? maxPages;
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

      for (const line of decodeFailureLines(decodeFailures)) log(line);

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
        for (const line of registerFailureLines(
          registerWarning,
          unlimitedCredits,
          accountPlan === "paid"
        ))
          log(line);
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
          // #403: a store-check failure names local paths; the run's error
          // gets the class, the terminal above gets the paths.
          error:
            result.error.code === ErrorCodes.FILE_WRITE_ERROR
              ? "Audit failed: a local store could not be written"
              : result.error.message,
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
      //
      // Pricing v11 (#2290): and so is the page settlement the server charges
      // when this run completes — every audited page the crawl did NOT already
      // pay for through a render. Mirrored here so the printed total, the
      // published report and the ledger agree. Not for an invalid audit
      // (down/403/0-page): that run finalizes failed, which settles nothing and
      // refunds the base.
      if (registeredRun?.baseCharged) {
        const prior = report.cloudSpend;
        const withBase = [
          {
            service: "audit-base",
            feature: "audit_base",
            units: 1,
            credits: registeredRun.baseCharged,
          },
          ...(prior?.lines ?? []),
        ];
        const lines =
          auditStatusToLifecycle(report.status) === "failed"
            ? withBase
            : withAuditPageSettlement(withBase, auditedPageCount(report));
        const totalSpent = lines.reduce((sum, l) => sum + l.credits, 0);
        // The settlement lands after every balance read this run made.
        const settled =
          totalSpent - withBase.reduce((sum, l) => sum + l.credits, 0);
        report.cloudSpend = {
          lines,
          totalSpent,
          balanceAfter: estimateBalanceAfter({
            prefetchRead: prior?.balanceAfter ?? null,
            afterBase: registeredRun.balanceAfterBase,
            baseCharged: registeredRun.baseCharged,
            totalSpent,
            settled,
            unlimited: unlimitedCredits,
          }),
        };
      }
      // #368: stamp the account tier so the published report's locked-rules
      // section never shows the "get a free account" upsell to a signed-in user.
      report.cloudPlan = accountPlan;
      // #368: stamp the resolved cloud mode so an explicit --http opt-out reads as
      // a deliberate choice, not a "cloud temporarily unavailable" failure.
      report.cloudMode = cloudRendering;
      // #747: stamp the level so a quick run's locked cloud rules read as a
      // level choice ("re-run at the surface or full level"), never a cloud
      // outage. The controller stamped `auditLevel` (the full snapshot).
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
          // #2290: what the server settles the page charge on.
          pagesAudited: auditedPageCount(report),
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
        maxPages,
        auditLevel.settings.crawlStrategy === "all"
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
        noPublish,
        configPublish: config.cloud.publish,
        ruleFilterActive,
        nonPublicHost: !!nonPublicHost,
      });
      // #1841: one line, and only when the host is the deciding factor — a
      // signed-out or --no-publish run was never going to publish, and saying
      // "kept local" there would read as a new restriction. Covers the skipped
      // registration too: to the user both are the same fact.
      // The server's own verdict (#1841). Reachable when its egress classifier
      // is stricter than the preflight above — `box.local`,
      // `metadata.google.internal`, a dotless host — so the run registered but
      // no dashboard site exists. Mutually exclusive with the local skip below:
      // a host the preflight caught never registered at all.
      if (registeredRun?.websiteSkippedReason === "non_public_host") {
        log(fmt.dim(SERVER_NON_PUBLIC_HOST_LINE));
      }
      if (
        nonPublicHost &&
        signedIn &&
        !args.offline &&
        resolvePublishDecision({
          signedIn,
          offline: !!args.offline,
          explicitPublish: !!args.publish,
          noPublish,
          configPublish: config.cloud.publish,
          ruleFilterActive,
          nonPublicHost: false,
        })
      ) {
        log(fmt.dim(LOCAL_HOST_NOT_PUBLISHED_LINE));
      }
      // Only claim the filter caused the skip when it's actually the deciding
      // factor — --no-publish/config/signed-out skips would misattribute.
      const wouldPublishWithoutFilter = resolvePublishDecision({
        signedIn,
        offline: !!args.offline,
        explicitPublish: !!args.publish,
        noPublish,
        configPublish: config.cloud.publish,
        ruleFilterActive: false,
        nonPublicHost: !!nonPublicHost,
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
            websiteId: registeredRun?.websiteId ?? undefined,
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

            // #2184: recurring audits switch themselves on after a site's first
            // completed cloud audit, so this is where the CLI tells its user a
            // weekly credit charge has started and where one click stops it.
            // #2225: the same line, from the same renderer, is also where a
            // `capped` site learns it is not scheduled at all. Silent when the
            // server said nothing, or said the schedule is off.
            const scheduleLine = scheduleSummaryLine(
              publishResult.data.schedule
            );
            if (scheduleLine) log(scheduleLine);

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
          // An unmetered org's "balance after" is meaningless (nothing was
          // deducted) — say unlimited rather than echo a frozen number.
          const balancePart = unlimitedCredits
            ? " · balance unlimited"
            : after != null
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
          // The advance warning the dashboard now shows as a banner, in the
          // one place a CLI-only user will actually read it. Fires while there
          // are still credits left, not at zero.
          footerLines.push(
            ...lowBalanceFooterLines({
              balance: after,
              monthlyCredits: planMonthlyCredits,
              plan: accountPlan,
              unlimited: unlimitedCredits,
              upgrade: upgradeOffer,
              resetAt: creditsResetAt,
            })
          );
          // #2182: a signed-in user whose reports never reach the dashboard has
          // no idea what publishing gets them. Said exactly once, and never at
          // all once anything has been published.
          if (
            shouldShowPublishNudge({
              signedIn,
              offline: !!args.offline,
              publishedThisRun: publishedReportId !== null,
              publishFailed: autoPublishError !== null,
              everPublished: hasEverPublished(effectiveSettings),
              nudgeShown: effectiveSettings?.publish_nudge_shown === true,
              nonPublicHost: !!nonPublicHost,
              ruleFilterActive,
              stderrIsTTY: process.stderr.isTTY === true,
              isConsoleFormat,
              outputPath: args.output,
            })
          ) {
            footerLines.push(publishNudgeLine());
            // Non-fatal: a failed write just re-shows the line next run, which
            // is the same failure mode auto_publish_notice_shown accepts.
            updateSettings({ publish_nudge_shown: true });
          }
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
