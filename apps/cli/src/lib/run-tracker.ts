/**
 * Run tracker — best-effort lifecycle signals so a signed-in `squirrel audit`
 * appears live in the dashboard the instant it starts (epic #271).
 *
 *   registerRun (at start) -> markRunning (before crawl)
 *     -> reportProgress (throttled, during crawl) -> finalizeRun (at end)
 *
 * The whole flow is BEST-EFFORT: a failure, timeout, or unreachable API must
 * NEVER block or fail the local audit. `registerRun` is the only awaited call
 * (we need the ids it returns); the rest are fire-and-forget. All transport —
 * base URL, bearer auth, User-Agent, timeout — is owned by `cliApi`, so this
 * file is just the agent-runs lifecycle shapes.
 *
 * Gating lives at the call site (audit.ts): only signed-in, non-`--offline`
 * runs register. `--no-publish` still registers (the run shows in YOUR
 * dashboard) — publishing only governs the shareable report.
 */
import { isApiKey } from "@squirrelscan/core-contracts/api-keys";

import { cliApi } from "@/lib/api-client";
import { resolveCredential } from "@/self/credentials";
import { logger } from "@/utils/logger";
import { parseUserUrl } from "@/utils/url";

// Register runs CONCURRENTLY with the crawl (audit.ts kicks the promise off
// without awaiting), so a generous ceiling costs nothing at audit start. The old
// 5s ceiling did cost something else: a register the SERVER committed (run row +
// 50cr base debit) but whose response arrived late resolved null here, and the
// audit then ran fully untracked — no markRunning, no finalize, no runId in
// publish — so the run was reaped as an orphan pending and the delivered audit
// was refunded to free (#1534, ~9% of CLI runs, concentrated far from us-west).
// Give the round-trip room, then retry once; only a genuinely dead API falls
// through to an untracked audit.
const REGISTER_TIMEOUT_MS = 12_000;
// The retry's shorter ceiling bounds the total register budget (~20s) so a dead
// API can't hold the end-of-run finalizer (which awaits this promise) that long
// past a very fast audit.
const REGISTER_RETRY_TIMEOUT_MS = 8_000;
const PATCH_TIMEOUT_MS = 10_000;
// Progress is the most frequent signal (throttled to ≤1/s at the call site) and
// the least important — keep its timeout short so a slow tick never piles up.
const PROGRESS_TIMEOUT_MS = 3_000;

/** Completion reasons the CLI emits (subset of the API's CompletionReason). */
export type CliCompletionReason = "success" | "error" | "user_cancel";

export interface RegisteredRun {
  runId: string;
  websiteId: string;
  auditId: string;
  /**
   * Lifecycle base path resolved ONCE at register time. Threaded into every
   * later call so the whole lifecycle (register → markRunning → progress →
   * finalize) is consistent even if the credential changes mid-run — a run
   * registered org-scoped must never be PATCHed user-scoped (or vice versa).
   */
  lifecycleBase: string;
  /**
   * Credits the server debited for the flat audit base at registration
   * (pricing v10, #391). 0 from servers that predate the base charge.
   */
  baseCharged: number;
  /** Balance total right after the base debit; null when the server omits it. */
  balanceAfterBase: number | null;
}

export interface RegisterRunInput {
  url: string;
  mode?: "audit" | "audit-fix" | "fix" | "recommend";
  /** Crawl config snapshot (maxPages, coverageMode, …) — stored on the run. */
  config?: Record<string, unknown>;
}

export interface ProgressInput {
  pagesFetched: number;
  pagesTotal: number;
  pagesFailed: number;
}

export interface FinalizeRunInput {
  status: "completed" | "failed" | "cancelled";
  completedAt: string;
  healthScore?: number | null;
  issuesFound?: number | null;
  /** Published report id, when the run published a shareable report. */
  reportId?: string | null;
  completionReason?: CliCompletionReason;
  error?: string;
  /**
   * #1168: structured classification of a PUBLISH failure (PAYLOAD_TOO_LARGE,
   * TOKEN_INVALID, VALIDATION_ERROR, …) on an otherwise-successful audit. The API
   * refunds the whole audit for size/server-class publish failures and ignores it
   * for auth/user-caused ones. Absent for successful publishes and non-publish exits.
   */
  errorCode?: string;
  /**
   * Per-phase wall-clock ms for this run (#857), incl. `publish` when it ran.
   * Merged into the run's `config` jsonb as `phaseTimingsMs` — the API merges
   * rather than overwrites `config`, so this never drops the register-time
   * maxPages/coverageMode/runner fields already stored there.
   */
  phaseTimingsMs?: Record<string, number>;
}

/**
 * #1179: pick the score/issues to finalize agent_runs with. A signed-in publish
 * re-merges server-side and can land a DIFFERENT score than the CLI's local
 * pre-publish estimate; when the publish succeeded we adopt the SERVER numbers so
 * the dashboard "runs" history matches the published report (they used to diverge
 * hard on big sites: 84 local vs 56 published). Precedence:
 *  - invalid audit (down/403/0-page) → null score, regardless of server (parity
 *    with the report/DO null-score guards);
 *  - publish succeeded (server value present, incl. an explicit null) → server;
 *  - no publish / older server (undefined) → the local estimate stands.
 */
export function resolveRunFinalizeScore(input: {
  invalidAudit: boolean;
  localHealthScore: number | null;
  localIssuesFound: number;
  serverHealthScore?: number | null;
  serverIssuesFound?: number;
}): { healthScore: number | null; issuesFound: number } {
  return {
    healthScore: input.invalidAudit
      ? null
      : input.serverHealthScore !== undefined
        ? input.serverHealthScore
        : input.localHealthScore,
    issuesFound:
      input.serverIssuesFound !== undefined
        ? input.serverIssuesFound
        : input.localIssuesFound,
  };
}

/**
 * Lifecycle base path. Org API keys (`sq_`) can't use the userId-scoped routes
 * (they `rejectApiKey`, #200); the `/org/*` twins authorize by orgId instead
 * (#280). Login tokens / Clerk sessions keep the original userId-scoped routes.
 */
function lifecycleBase(): string {
  const cred = resolveCredential();
  return cred && isApiKey(cred.token) ? "/v1/agent-runs/org" : "/v1/agent-runs";
}

/** Path for the lifecycle PATCH/progress on a specific run. */
function runPath(runId: string, suffix = "", base = lifecycleBase()): string {
  return `${base}/${encodeURIComponent(runId)}${suffix}`;
}

/** What `POST /register` answers with — ids plus the pricing-v10 extras. */
type RegisterResponseBody = Partial<RegisteredRun> & {
  balance?: { total?: number } | null;
  error?: { code?: string; message?: string };
};

/**
 * Register-failure codes worth interrupting the user for: persistent, actionable
 * account-state problems where the run then goes untracked/unpublished and the
 * user can act (raise the cap, top up credits, reactivate). An explicit
 * allowlist rather than the whole 4xx range (#816 review) — a 429 rate-limit is
 * transient (and its body is a plain-string `error`, no `code`), and an
 * unexpected backend error the register handler maps to a generic 400 is not
 * actually about the user's input; both must stay silent per best-effort intent.
 * These match the codes registerRunHandler actually emits (agent-runs.ts).
 */
const DEFINITIVE_REGISTER_FAILURE_CODES = new Set([
  "WEBSITE_LIMIT",
  "INSUFFICIENT_CREDITS",
  "ORG_LOCKED",
]);

/**
 * Register the run at audit START. Returns the ids the dashboard needs to track
 * it live, or null on ANY failure (no credential, network error, non-2xx, bad
 * body) — the audit then simply proceeds untracked.
 *
 * A LOST response (timeout / transport failure) is retried ONCE under the same
 * client-generated idempotency key (#1534). Falling through to null is the
 * expensive outcome, not the slow one: the server may already have committed the
 * run row and its 50cr base debit, and an untracked audit then gets reaped as an
 * orphan pending run and refunded — a delivered audit, for free.
 *
 * `onWarn` is invoked with the server message ONLY on a DEFINITIVE, actionable
 * failure (see DEFINITIVE_REGISTER_FAILURE_CODES) so the caller can surface it
 * loudly (#816): at the website limit / out of credits / org locked means the
 * run runs untracked and unpublished-to-dashboard and the user should know why.
 * Everything else — transient network/5xx, rate limits, generic 400s — stays
 * silent: best-effort tracking must not spam noise on a flaky connection.
 */
export async function registerRun(
  input: RegisterRunInput,
  onWarn?: (message: string) => void
): Promise<RegisteredRun | null> {
  // Resolve the base ONCE here; thread it through the returned RegisteredRun.
  const base = lifecycleBase();
  // Callers pass the user's raw input, and servers before #855 validate it
  // with z.string().url() — a bare domain ("example.com") 400s and the run
  // proceeds untracked. Add the scheme for scheme-less input; anything the
  // user typed as a real URL is sent verbatim.
  const parsed = input.url.includes("://") ? null : parseUserUrl(input.url);
  // #1534: one key for BOTH attempts, so a retry that races a first attempt the
  // server is still committing converges on the SAME run row and the SAME
  // audit_base debit rather than creating (and charging for) a second run.
  // Servers before #1534 ignore the unknown field, so the retry is only as safe
  // as the old behavior there — which is why the timeout is generous first.
  const idempotencyKey = crypto.randomUUID();
  const body = {
    url: parsed?.ok ? parsed.url : input.url,
    mode: input.mode ?? "audit",
    idempotencyKey,
    ...(input.config ? { config: JSON.stringify(input.config) } : {}),
  };

  let ok = false;
  let status = 0;
  let data: RegisterResponseBody | null = null;
  // Attempt 2 is for a LOST response only (`status === 0`: timeout, socket
  // reset, DNS blip) — that is the #1534 failure mode. A server that answered,
  // with any status, has decided; re-asking would only duplicate the request.
  for (const timeoutMs of [REGISTER_TIMEOUT_MS, REGISTER_RETRY_TIMEOUT_MS]) {
    ({ ok, status, data } = await cliApi.request<RegisterResponseBody>(
      `${base}/register`,
      { method: "POST", auth: "required", timeoutMs, body }
    ));
    if (ok || status !== 0) break;
    logger.debug("run-tracker: register lost its response, retrying once", {
      timeoutMs,
    });
  }

  if (!ok || !data) {
    if (status !== 0) {
      // Structured args so the logger's key-based redaction sees the body;
      // pre-stringifying here would bypass it.
      logger.debug("run-tracker: register non-2xx", { status, body: data });
      // Surface only definitive, actionable failures to the user (#816); a bare
      // string `error` body (e.g. rate-limit) has no `.code` → stays silent.
      const code = data?.error?.code;
      if (onWarn && code && DEFINITIVE_REGISTER_FAILURE_CODES.has(code)) {
        onWarn(
          data?.error?.message ?? "the run won't appear in your dashboard"
        );
      }
    }
    return null;
  }
  if (!data.runId || !data.websiteId || !data.auditId) return null;
  return {
    runId: data.runId,
    websiteId: data.websiteId,
    auditId: data.auditId,
    lifecycleBase: base,
    // Pricing v10 fields; absent from older servers → 0 / null.
    baseCharged: typeof data.baseCharged === "number" ? data.baseCharged : 0,
    balanceAfterBase:
      typeof data.balance?.total === "number" ? data.balance.total : null,
  };
}

/** Flip the run to "running" once the crawl begins. Fire-and-forget. */
export async function markRunning(
  runId: string,
  startedAt: string,
  base = lifecycleBase()
): Promise<void> {
  await cliApi.send(runPath(runId, "", base), {
    method: "PATCH",
    auth: "required",
    timeoutMs: PATCH_TIMEOUT_MS,
    body: { status: "running", startedAt },
  });
}

/**
 * Push coarse crawl progress for a running audit so the dashboard shows a live
 * progress bar (#271 phase 5). Fire-and-forget; the caller throttles cadence
 * (≤1/s). A failure just leaves the bar a beat behind until the next tick.
 */
export async function reportProgress(
  runId: string,
  input: ProgressInput,
  base = lifecycleBase()
): Promise<void> {
  await cliApi.send(runPath(runId, "/progress", base), {
    method: "POST",
    auth: "required",
    timeoutMs: PROGRESS_TIMEOUT_MS,
    body: {
      pagesFetched: Math.max(0, Math.round(input.pagesFetched)),
      pagesTotal: Math.max(0, Math.round(input.pagesTotal)),
      pagesFailed: Math.max(0, Math.round(input.pagesFailed)),
    },
  });
}

/** Close the run out at the end (after publish). Fire-and-forget. */
export async function finalizeRun(
  runId: string,
  input: FinalizeRunInput,
  base = lifecycleBase()
): Promise<void> {
  // updateRunSchema rejects null for these optionals (z.*.optional(), not
  // .nullable()), so OMIT a field rather than send null. healthScore must be an
  // int in [0,100]; issuesFound a non-negative int.
  const body: Record<string, unknown> = {
    status: input.status,
    completedAt: input.completedAt,
  };
  if (typeof input.healthScore === "number") {
    body.healthScore = Math.max(
      0,
      Math.min(100, Math.round(input.healthScore))
    );
  }
  if (typeof input.issuesFound === "number") {
    body.issuesFound = Math.max(0, Math.round(input.issuesFound));
  }
  if (input.reportId) body.reportId = input.reportId;
  if (input.completionReason) body.completionReason = input.completionReason;
  if (input.error) body.error = input.error.slice(0, 500);
  if (input.errorCode) body.errorCode = input.errorCode.slice(0, 100);
  if (input.phaseTimingsMs && Object.keys(input.phaseTimingsMs).length > 0) {
    body.config = { phaseTimingsMs: input.phaseTimingsMs };
  }

  await cliApi.send(runPath(runId, "", base), {
    method: "PATCH",
    auth: "required",
    timeoutMs: PATCH_TIMEOUT_MS,
    body,
  });
}

/**
 * Build a finalizer that PATCHes the registered run to a terminal state AT MOST
 * ONCE (#332). Resolves the run id by awaiting `registerPromise` (its own
 * timeout bounds the wait), so a finalize racing an in-flight register still
 * lands — every exit path (success, error, interrupt, crash) shares one guard.
 * No registered run (promise resolves null) → silently no-ops.
 */
export function createRunFinalizer(
  registerPromise: Promise<RegisteredRun | null>
): (input: FinalizeRunInput) => Promise<void> {
  let finalized = false;
  return async (input: FinalizeRunInput): Promise<void> => {
    if (finalized) return;
    finalized = true;
    const run = await registerPromise.catch(() => null);
    if (run) await finalizeRun(run.runId, input, run.lifecycleBase);
  };
}
