// Billing for the local MCP `audit_website` tool (#628).
//
// No signed-in audit is free in credits. Signed in, a tool call is a billed
// cloud audit exactly like `squirrel audit`: the same register decision, the
// same affordability preflight, the same cloud rendering, and the run is
// registered (50-credit base) and settled on its audited pages (2 each) when
// it finishes. Signed out, offline, or against a host no hosted runner can
// reach, the audit stays on this machine and makes no cloud call.
//
// A tool call cannot prompt, so the spend is confirmed the way the hosted
// server's run_audit confirms it: an estimate over `[cloud] confirm_threshold`
// comes back as `confirmation_required`, and the agent calls again with
// `confirm: true`. An audit the balance or the per-audit cap cannot pay for is
// refused with the cost and the balance, before anything is registered.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Config } from "@squirrelscan/config";
import type { ResolvedAuditSettings } from "@squirrelscan/core-contracts/audit-levels";

import { CloudClientError } from "@squirrelscan/cloud-client";
import { CREDIT_PRICING_VERSION } from "@squirrelscan/core-contracts";

import type { AuditLevel } from "@/cli/audit-level";
import type { RunAuditOptions } from "@/controllers/audit";
import type { AuditReport } from "@/types";

import {
  canStartCloudAudit,
  computePreflightAffordability,
  resolveCloudRendering,
  resolveRegisterDecision,
} from "@/cli/commands/audit";
import { STATUS_REQUEST_TIMEOUT_MS } from "@/constants";
import { auditedPageCount } from "@/controllers/audit";
import { isUnlimitedBalance } from "@/lib/balance";
import { nonPublicHostLabel } from "@/lib/non-public-host";
import {
  type FinalizeRunInput,
  finalizeRun,
  markRunning,
  registerRun,
  reportProgress,
  type RegisteredRun,
  type RegisterFailure,
  resolveRunFinalizeScore,
} from "@/lib/run-tracker";
import {
  AUDIT_BASE_CREDITS,
  AUDIT_PAGE_CREDITS,
  MIN_AUDIT_CREDITS,
  upgradeUrl,
} from "@/lib/upgrade";
import { envTokenRejectedMessage } from "@/self/credentials";
import { detectRunner } from "@/self/install-meta";
import { loadUserSettings } from "@/self/settings";
import { createCloudClientWithSource } from "@/tools/cloud";

import { version } from "../../package.json";
import { errorResult, jsonResult } from "./result";

/** What the tool's level resolution hands this module. */
export interface McpLevelOptions {
  coverageMode: AuditLevel;
  maxPages: number;
  auditLevel: ResolvedAuditSettings;
  /** A render setting the config chose (`[cloud] render`), if any. */
  render?: "off" | "auto" | "all";
}

/** A tool call that runs as a billed cloud audit. */
export interface BilledAudit {
  run: RegisteredRun;
  /** The page cap, fitted to the balance and the per-audit cap. */
  maxPages: number;
  /** Upper bound in credits: the base plus every page of the cap. */
  estimate: number;
  /** Clamp notices from the preflight, empty when nothing was lowered. */
  notices: string[];
  /** Run options the billed audit adds to the level's. */
  options: Pick<
    RunAuditOptions,
    | "maxPages"
    | "cloudAvailable"
    | "cloudRendering"
    | "cloudConsented"
    | "getRunId"
  >;
  accountPlan: "free" | "paid";
}

export type McpAuditPlan =
  /** On this machine, with no cloud call. `note` says why, when it is not obvious. */
  | { kind: "local"; note?: string }
  /** A result to hand straight back: a refusal or a confirmation request. */
  | { kind: "stop"; result: CallToolResult }
  | { kind: "billed"; billed: BilledAudit };

const PRICING = `${AUDIT_BASE_CREDITS} base + ${AUDIT_PAGE_CREDITS} per audited page`;

/**
 * One billed run from register to its terminal PATCH. `running` is the
 * markRunning call, which the terminal PATCH waits on; `closed` is the one
 * terminal PATCH, set by whichever closes it first (the audit finishing, or a
 * shutdown), so two terminal states can never race.
 */
interface RunLifecycle {
  run: RegisteredRun;
  running: Promise<void>;
  closed: Promise<void> | null;
}

// The server is long-lived and can run several billed audits at once. On
// shutdown every run here that is not closed yet is closed as cancelled, and
// every register still in flight is waited for and closed the same way, so no
// charged run is left pending (see cancelActiveMcpRuns).
const lifecycles = new Map<string, RunLifecycle>();
const registering = new Set<Promise<RegisteredRun | null>>();
// Set when a shutdown begins: no new register starts after it, so none can
// slip past the shutdown's snapshot and be charged without being closed.
let shuttingDown = false;

const SHUTTING_DOWN =
  "The squirrelscan MCP server is shutting down, so the audit did not start.";

/**
 * Reset the shutdown state between tests.
 * @internal
 */
export function resetBilledRunsForTests(): void {
  shuttingDown = false;
  lifecycles.clear();
  registering.clear();
}

/** Start tracking a registered run (once), flipping it to running. */
function trackRun(run: RegisteredRun): RunLifecycle {
  let life = lifecycles.get(run.runId);
  if (!life) {
    life = {
      run,
      running: markRunning(
        run.runId,
        new Date().toISOString(),
        run.lifecycleBase
      ).catch(() => {}),
      closed: null,
    };
    lifecycles.set(run.runId, life);
  }
  return life;
}

/** Close a run once: the first terminal state wins, later calls wait on it. */
function closeRun(run: RegisteredRun, input: FinalizeRunInput): Promise<void> {
  const life = trackRun(run);
  // The entry stays after it closes, so a late second close (the audit
  // finishing after a shutdown closed it) finds it and sends nothing. One small
  // entry per billed audit, each of which cost credits: not worth evicting.
  life.closed ??= life.running.then(() =>
    finalizeRun(run.runId, input, run.lifecycleBase)
  );
  return life.closed;
}

const LOCAL_HINT = "Pass offline: true for a local-only audit.";
const LOCAL_HINT_LOWER = "pass offline: true for a local-only audit.";

function balanceLabel(total: number, unlimited: boolean): string {
  return unlimited ? "unlimited" : `${total.toLocaleString("en-US")} credits`;
}

/** The refusal for a register the server turned down. Nothing was charged. */
function registerRefusal(failure: RegisterFailure | null): string {
  // No answer at all: the server may still have registered the run and taken
  // the base, so this does not promise nothing was charged. A run that never
  // starts is cleaned up as an orphan and its charge refunded.
  if (!failure) {
    return `Could not start the billed cloud audit: the register request got no answer, so the audit did not run. If the server did register it, that run never starts and its charge is refunded when it is cleaned up. Retry, or ${LOCAL_HINT_LOWER}`;
  }
  const why =
    failure.code === "INSUFFICIENT_CREDITS"
      ? `insufficient credits${failure.required !== null ? `: it needs ${failure.required}` : ""}${failure.balance !== null ? `, the balance is ${failure.balance}` : ""}`
      : failure.message;
  return `Could not start the billed cloud audit (${why}). Nothing was charged. Retry, or ${LOCAL_HINT_LOWER}`;
}

/**
 * Decide how a signed-in-or-not `audit_website` call runs, and for a billed
 * audit, register the run. Mirrors `squirrel audit`: offline, signed out, a
 * non-public host or an unreachable API run locally; an account that cannot
 * pay for one page is refused; an estimate over the confirmation threshold
 * waits for `confirm: true`.
 */
export async function planMcpAudit(input: {
  url: string;
  offline?: boolean;
  confirm?: boolean;
  config: Config;
  level: McpLevelOptions;
}): Promise<McpAuditPlan> {
  const { url, config, level } = input;
  if (input.offline) return { kind: "local" };

  const resolved = createCloudClientWithSource({
    timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
    maxAttempts: 3,
  });
  if (!resolved) return { kind: "local" };

  const nonPublicHost = nonPublicHostLabel(url);
  if (
    !resolveRegisterDecision({
      signedIn: true,
      offline: false,
      nonPublicHost: nonPublicHost !== null,
    })
  ) {
    return {
      kind: "local",
      note: `${nonPublicHost} is not reachable by squirrelscan's cloud, so this audit ran locally and was not billed.`,
    };
  }

  let balance: Awaited<ReturnType<typeof resolved.client.getBalance>>;
  try {
    balance = await resolved.client.getBalance();
  } catch (error) {
    const rejected =
      error instanceof CloudClientError && error.code === "not_authenticated";
    // An env token the server rejects is a hard error, as in the CLI: never a
    // silent fall-back to a local run the caller did not ask for.
    if (rejected && resolved.source === "env") {
      return { kind: "stop", result: errorResult(envTokenRejectedMessage()) };
    }
    return {
      kind: "local",
      note: rejected
        ? "The squirrelscan session has expired, so this audit ran locally without the cloud checks. Run `squirrel auth login` to sign in again."
        : "squirrelscan's cloud could not be reached, so this audit ran locally without the cloud checks.",
    };
  }

  const unlimited = isUnlimitedBalance(balance.balance);
  const topUpUrl = balance.upgrade?.url ?? upgradeUrl("mcp-audit");
  const accountPlan = balance.plan.id === "free" ? "free" : "paid";

  if (!canStartCloudAudit(balance.balance)) {
    return {
      kind: "stop",
      result: errorResult(
        `This audit needs at least ${MIN_AUDIT_CREDITS} credits (${PRICING}), and the balance is ${balanceLabel(balance.balance.total, unlimited)}. Nothing was registered or charged. Top up at ${topUpUrl}. ${LOCAL_HINT}`
      ),
    };
  }

  const preflight = computePreflightAffordability({
    balance: balance.balance.total,
    maxPages: level.maxPages,
    maxCreditsPerAudit: config.cloud.max_credits_per_audit,
    topUpUrl,
    unlimited,
    resetAt: balance.balance.periodEnd ?? null,
  });
  if (preflight.maxPages === 0) {
    return {
      kind: "stop",
      result: errorResult(
        `[cloud] max_credits_per_audit = ${config.cloud.max_credits_per_audit} is below the ${MIN_AUDIT_CREDITS} credits a one-page audit needs (${PRICING}); the balance is ${balanceLabel(balance.balance.total, unlimited)}. Nothing was registered or charged. Raise the cap (0 = no cap). ${LOCAL_HINT}`
      ),
    };
  }
  const notices = preflight.clamped
    ? preflight.noticeLines.map((l) => l.replace(/^⚠\s*/, "").trim())
    : [];

  if (!input.confirm && preflight.estimate > config.cloud.confirm_threshold) {
    return {
      kind: "stop",
      result: jsonResult({
        status: "confirmation_required",
        estimate: {
          credits: preflight.estimate,
          pages: preflight.maxPages,
          baseCredits: AUDIT_BASE_CREDITS,
          creditsPerPage: AUDIT_PAGE_CREDITS,
        },
        balance: unlimited ? "unlimited" : balance.balance.total,
        sufficient: true,
        ...(notices.length > 0 ? { notices } : {}),
        next: `Show the user the estimate (up to ${preflight.estimate} credits for up to ${preflight.maxPages} pages, ${PRICING}), then call audit_website again with confirm: true to start the billed cloud audit. ${LOCAL_HINT}`,
      }),
    };
  }

  // The CLI's rendering decision, with the config's render setting as the
  // explicit choice. Decided before the register, so nothing between the
  // register and the run can throw and leave a charged run pending. The spend
  // was confirmed above, so no notice prints here.
  const settings = loadUserSettings();
  const explicit = level.render;
  const { mode: cloudRendering, consented } = await resolveCloudRendering({
    args: {
      http: explicit === "off",
      render: explicit === "auto" || explicit === "all",
    },
    configRendering:
      explicit === "off"
        ? "http"
        : explicit
          ? "browser"
          : config.cloud.rendering,
    signedIn: true,
    consent: settings.ok ? settings.data.cloud_render_consent : undefined,
    spendAck: true,
    log: () => {},
    estimate: {
      maxPages: preflight.maxPages,
      balance: balance.balance.total,
      maxCredits: config.cloud.max_credits_per_audit,
      unlimited,
    },
    persist: () => ({ ok: true }),
  });

  if (shuttingDown) return { kind: "stop", result: errorResult(SHUTTING_DOWN) };
  let registerFailure: RegisterFailure | null = null;
  const register = registerRun(
    {
      url,
      mode: "audit",
      config: {
        maxPages: preflight.maxPages,
        coverageMode: level.coverageMode,
        auditLevel: level.auditLevel,
        cliVersion: version,
        runner: detectRunner(),
        pricingVersion: CREDIT_PRICING_VERSION,
        // Which surface started the run, for the dashboard's run detail.
        via: "mcp",
        ...(preflight.clamped && preflight.limitedBy
          ? {
              creditClamp: {
                requestedMaxPages: level.maxPages,
                effectiveMaxPages: preflight.maxPages,
                limitedBy: preflight.limitedBy,
              },
            }
          : {}),
      },
    },
    (failure) => {
      registerFailure = failure;
    }
  );
  registering.add(register);
  const run = await register.finally(() => registering.delete(register));
  // An audit that is not registered is not billed, so it does not run with
  // the cloud: refuse, rather than hand out cloud work for nothing.
  if (!run) {
    return {
      kind: "stop",
      result: errorResult(registerRefusal(registerFailure)),
    };
  }
  const life = trackRun(run);
  await life.running;
  // A shutdown that arrived while the register was in flight has already
  // closed this run as cancelled: do not start the audit.
  if (life.closed) {
    return {
      kind: "stop",
      result: errorResult(`${SHUTTING_DOWN} Its run was closed as cancelled.`),
    };
  }

  return {
    kind: "billed",
    billed: {
      run,
      maxPages: preflight.maxPages,
      estimate: preflight.estimate,
      notices,
      accountPlan,
      options: {
        maxPages: preflight.maxPages,
        cloudAvailable: true,
        cloudRendering,
        cloudConsented: consented,
        getRunId: () => run.runId,
      },
    },
  };
}

/**
 * Keep a billed run alive while it works. The server reaps a run that shows no
 * activity, and a long rules phase is silent. One timer per run: the MCP
 * server is long-lived and can run several audits at once, so the CLI's
 * single module-level heartbeat does not fit here.
 */
export function startMcpRunHeartbeat(
  run: RegisteredRun,
  snapshot: () => {
    pagesFetched: number;
    pagesTotal: number;
    pagesFailed: number;
  },
  intervalMs = 30_000
): () => void {
  const timer = setInterval(() => {
    void reportProgress(run.runId, snapshot(), run.lifecycleBase).catch(
      () => {}
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** An audit that did not really happen (site down, blocked, no page read). */
function isInvalidAudit(report: AuditReport): boolean {
  return report.status === "failed" || report.status === "blocked";
}

/**
 * Close a billed run out: the server settles the page charge on
 * `pagesAudited`. A run closed as failed settles nothing and refunds the base.
 */
export async function finalizeMcpRun(
  run: RegisteredRun,
  outcome: { report: AuditReport } | { error: string }
): Promise<void> {
  const completedAt = new Date().toISOString();
  if ("error" in outcome) {
    await closeRun(run, {
      status: "failed",
      completedAt,
      completionReason: "error",
      error: outcome.error,
    });
    return;
  }
  const { report } = outcome;
  const invalidAudit = isInvalidAudit(report);
  const score = resolveRunFinalizeScore({
    invalidAudit,
    localHealthScore: report.healthScore?.overall ?? null,
    localIssuesFound: report.failed + report.warnings,
  });
  await closeRun(run, {
    status: invalidAudit ? "failed" : "completed",
    completedAt,
    healthScore: score.healthScore,
    issuesFound: score.issuesFound,
    reportId: null,
    completionReason: invalidAudit ? "error" : "success",
    ...(invalidAudit && report.statusReason
      ? { error: report.statusReason }
      : {}),
    phaseTimingsMs: report.phaseTimingsMs,
    pagesAudited: auditedPageCount(report),
  });
}

/** The line a billed audit's result starts with: the run and what it costs. */
export function billedAuditSummary(
  billed: BilledAudit,
  report: AuditReport
): string {
  if (isInvalidAudit(report)) {
    return `Cloud audit run ${billed.run.runId} did not complete (${report.status}${report.statusReason ? `: ${report.statusReason}` : ""}), so it was closed as failed: no page charge, and the audit base is refunded.`;
  }
  const pages = auditedPageCount(report);
  const credits = AUDIT_BASE_CREDITS + pages * AUDIT_PAGE_CREDITS;
  return [
    `Billed cloud audit, run ${billed.run.runId}: ${pages} audited ${pages === 1 ? "page" : "pages"}, about ${credits} credits (${PRICING}). The page charge settles when the run closes.`,
    ...billed.notices,
  ].join("\n");
}

/**
 * Close every billed run still in flight as cancelled, for a server that is
 * shutting down. Waits for registers in flight, so a run the server created a
 * moment ago is closed too, and for a run already closing (the audit finishing
 * right now), whose own terminal state then stands. Without this a signal
 * mid-audit leaves the run pending with its base charged until it is reaped.
 */
export async function cancelActiveMcpRuns(): Promise<void> {
  shuttingDown = true;
  const fresh = await Promise.all(
    [...registering].map((r) => r.catch(() => null))
  );
  for (const run of fresh) if (run) trackRun(run);
  const completedAt = new Date().toISOString();
  await Promise.all(
    [...lifecycles.values()].map((life) =>
      closeRun(life.run, {
        status: "cancelled",
        completedAt,
        completionReason: "user_cancel",
      })
    )
  );
}
