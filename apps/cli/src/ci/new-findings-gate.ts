// `squirrel ci`: audit a deployed URL in the cloud and gate on findings that are new since the
// previous completed audit of the same website (#1776).
//
// The command is a thin client over endpoints that already exist: POST /v1/agent-runs starts the
// run (with `websiteId`, so it lands in that website's audit history), GET /v1/agent-runs/{id} is
// polled to a terminal state, and GET /v1/websites/{id}/audits/compare?head=<run>&fail_on=<sev>
// answers new versus previous. The gate is decided server-side, over every finding, so the CLI,
// the action and a plain curl read it the same way; this module only starts, waits, asks, prints
// and maps the answer onto an exit code.
//
// Everything that touches the network, the clock or the terminal is injected, so the whole flow is
// testable without a process-wide patch.

import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";

import {
  EXIT_CODE_UNREACHABLE,
  EXIT_CODE_WAF_BLOCKED,
  REPORTS_BASE_URL,
} from "@/constants";

/** The new-findings gate failed: the same code `--fail-on` uses, so CI reads one meaning for 2. */
export const EXIT_CODE_NEW_FINDINGS = 2;

export const FAIL_ON_SEVERITIES = ["error", "warning", "info"] as const;
export type FailOnSeverity = (typeof FAIL_ON_SEVERITIES)[number];

export function isFailOnSeverity(value: unknown): value is FailOnSeverity {
  return (
    typeof value === "string" &&
    (FAIL_ON_SEVERITIES as readonly string[]).includes(value)
  );
}

export type GateStatus = "pass" | "fail" | "no_baseline" | "not_evaluated";

export interface CompareGate {
  failOn?: string;
  status?: string;
  newAtOrAbove?: number;
  resolved?: number;
  notCompared?: { notCrawled?: number; notChecked?: number };
  reason?: string;
}

export interface CompareFinding {
  kind?: string;
  ruleId?: string;
  ruleName?: string;
  severity?: string;
  pageUrl?: string | null;
  locator?: string | null;
}

export interface CompareResponse {
  comparison?: {
    head?: {
      runId?: string;
      reportId?: string | null;
      healthScore?: number | null;
      status?: string;
      /** Not in the published schema; read when the server sends it. */
      statusReasonCode?: string;
    } | null;
    firstRun?: boolean;
    newBySeverity?: Record<string, number>;
    findings?: CompareFinding[];
    findingsTruncated?: boolean;
    comparisonIncomplete?: boolean;
    notes?: string[];
  };
  gate?: CompareGate;
}

export interface RunRecord {
  id?: string;
  status?: string;
  error?: string | null;
  completionReason?: string | null;
  completionMessage?: string | null;
  reportId?: string | null;
  reportAvailability?: string;
  progress?: {
    phase?: string | null;
    current?: number | null;
    total?: number | null;
  } | null;
}

export interface CreditsSnapshot {
  total: number;
  unlimited: boolean;
}

export interface ApiReply<T> {
  ok: boolean;
  /** 0 for a transport failure. */
  status: number;
  data: T | null;
}

export interface GateDeps {
  request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<ApiReply<T>>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Result lines (stdout). */
  out(line: string): void;
  /** Progress and diagnostics (stderr). */
  err(line: string): void;
}

export interface GateOptions {
  url: string;
  websiteId: string;
  failOn: FailOnSeverity;
  maxPages?: number;
  /** Give up waiting for the run after this long. */
  timeoutMs: number;
  pollIntervalMs: number;
  json: boolean;
}

export type GateExitReason =
  | "pass"
  | "no_baseline"
  | "new_findings"
  | "blocked"
  | "unreachable"
  | "not_evaluated"
  | "run_failed"
  | "timeout"
  | "start_failed"
  | "compare_failed";

export interface GateResult {
  code: number;
  reason: GateExitReason;
}

/** Statuses a run does not leave. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Failure classes that mean the site could not be reached (core-contracts `AuditFailureReasonCode`). */
const UNREACHABLE_REASON_CODES = new Set([
  "dns",
  "tls",
  "connection",
  "timeout",
]);

/** Consecutive poll failures tolerated before the wait is given up. */
const MAX_POLL_FAILURES = 5;
const COMPARE_ATTEMPTS = 4;
const COMPARE_RETRY_MS = 3000;
const COMPARE_LIMIT = 500;

function oneLine(value: unknown, max = 300): string {
  const text = stripControlChars(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function apiErrorText(reply: ApiReply<unknown>): string {
  const data = reply.data as {
    error?: { code?: string; message?: string } | string;
  } | null;
  const err = data?.error;
  if (typeof err === "string") return oneLine(err);
  if (err?.message) {
    return oneLine(err.code ? `${err.code}: ${err.message}` : err.message);
  }
  return reply.status === 0
    ? "the API could not be reached"
    : `HTTP ${reply.status}`;
}

/**
 * Exit code for a compared audit. Blocked and unreachable come first and never reach 2: a site the
 * crawler could not read has no findings to be new. `not_evaluated` is not a pass.
 */
export function decideExit(
  compare: CompareResponse,
  run: RunRecord | null
): GateResult {
  const head = compare.comparison?.head;
  if (head?.status === "blocked")
    return { code: EXIT_CODE_WAF_BLOCKED, reason: "blocked" };
  const reasonCode = head?.statusReasonCode ?? run?.completionReason ?? "";
  if (
    (head?.status === "failed" || run?.status === "failed") &&
    UNREACHABLE_REASON_CODES.has(reasonCode)
  ) {
    return { code: EXIT_CODE_UNREACHABLE, reason: "unreachable" };
  }
  switch (compare.gate?.status) {
    case "fail":
      return { code: EXIT_CODE_NEW_FINDINGS, reason: "new_findings" };
    case "pass":
      return { code: 0, reason: "pass" };
    case "no_baseline":
      return { code: 0, reason: "no_baseline" };
    default:
      // `not_evaluated`, an absent gate or a status this CLI does not know: never a pass.
      return { code: 1, reason: "not_evaluated" };
  }
}

function where(f: CompareFinding): string {
  return oneLine(f.pageUrl ?? f.locator ?? "(site)", 200);
}

function findingLine(f: CompareFinding): string {
  return `  ${oneLine(f.severity ?? "?", 8).padEnd(8)} ${oneLine(f.ruleId ?? "?", 80)}  ${where(f)}`;
}

function formatCredits(
  before: CreditsSnapshot | null,
  after: CreditsSnapshot | null
): { line: string; used: number | null } {
  if (!before || !after) {
    return { line: "Credits: could not be read", used: null };
  }
  if (before.unlimited || after.unlimited) {
    return {
      line: "Credits: unlimited plan, usage is recorded and invoiced",
      used: null,
    };
  }
  const used = before.total - after.total;
  return {
    line: `Credits used: ${used} (balance ${before.total} -> ${after.total}; other runs on the org in the same window count too)`,
    used,
  };
}

async function readCredits(deps: GateDeps): Promise<CreditsSnapshot | null> {
  const reply = await deps.request<{
    balance?: { total?: number; unlimited?: boolean };
  }>("GET", "/v1/credits");
  const balance = reply.data?.balance;
  if (!reply.ok || !balance || typeof balance.total !== "number") return null;
  return { total: balance.total, unlimited: balance.unlimited === true };
}

/** Print the finished comparison (or the JSON record) and return the exit decision. */
function report(
  deps: GateDeps,
  opts: GateOptions,
  run: RunRecord,
  compare: CompareResponse,
  decision: GateResult,
  credits: { before: CreditsSnapshot | null; after: CreditsSnapshot | null }
): void {
  const comparison = compare.comparison ?? {};
  const gate = compare.gate ?? {};
  const findings = comparison.findings ?? [];
  const added = findings.filter((f) => f.kind === "new");
  const resolved = findings.filter((f) => f.kind === "resolved");
  const reportId = comparison.head?.reportId ?? run.reportId ?? null;
  const reportUrl = reportId
    ? `${REPORTS_BASE_URL}/${encodeURIComponent(reportId)}`
    : null;
  const notCompared = {
    notCrawled: gate.notCompared?.notCrawled ?? 0,
    notChecked: gate.notCompared?.notChecked ?? 0,
  };
  const creditLine = formatCredits(credits.before, credits.after);

  if (opts.json) {
    deps.out(
      JSON.stringify(
        {
          exitCode: decision.code,
          exitReason: decision.reason,
          url: opts.url,
          websiteId: opts.websiteId,
          runId: run.id ?? null,
          runStatus: run.status ?? null,
          auditStatus: comparison.head?.status ?? null,
          healthScore: comparison.head?.healthScore ?? null,
          failOn: opts.failOn,
          gate: compare.gate ?? null,
          newBySeverity: comparison.newBySeverity ?? {},
          new: added,
          resolved,
          findingsTruncated: comparison.findingsTruncated === true,
          notCompared,
          reportUrl,
          credits: {
            before: credits.before?.total ?? null,
            after: credits.after?.total ?? null,
            used: creditLine.used,
            unlimited:
              credits.before?.unlimited || credits.after?.unlimited || false,
          },
        },
        null,
        2
      )
    );
    return;
  }

  const score = comparison.head?.healthScore;
  deps.out(
    `Audit of ${oneLine(opts.url, 200)} (run ${oneLine(run.id)}): ${oneLine(comparison.head?.status ?? run.status)}${typeof score === "number" ? `, health score ${score}` : ""}`
  );
  const verdict =
    decision.reason === "no_baseline"
      ? "no baseline"
      : decision.reason === "new_findings"
        ? "FAIL"
        : decision.reason === "pass"
          ? "pass"
          : decision.reason === "blocked"
            ? "blocked"
            : decision.reason === "unreachable"
              ? "unreachable"
              : "not evaluated";
  deps.out(
    `Gate (fail on new ${opts.failOn}): ${verdict}${gate.reason ? `: ${oneLine(gate.reason)}` : ""}`
  );
  if (decision.reason === "no_baseline") {
    deps.out(
      "No baseline: this is the first completed audit of the website, so there is nothing to compare it with. Exiting 0."
    );
  }
  if (decision.reason === "not_evaluated") {
    deps.out(
      "Not evaluated is not a pass: the comparison could not say whether anything is new. Exiting 1."
    );
  }

  if (added.length > 0) {
    deps.out("");
    deps.out(`New findings (${added.length}):`);
    for (const f of added) deps.out(findingLine(f));
  }
  if (resolved.length > 0) {
    deps.out("");
    deps.out(`Resolved findings (${resolved.length}, never fail the job):`);
    for (const f of resolved) deps.out(findingLine(f));
  }
  if (comparison.findingsTruncated) {
    deps.out(
      `(the list is clipped at ${COMPARE_LIMIT} rows; the gate counted every finding${gate.newAtOrAbove != null ? `: ${gate.newAtOrAbove} new at or above ${opts.failOn}` : ""})`
    );
  }
  deps.out("");
  deps.out(
    `Not compared: ${notCompared.notCrawled} on pages not crawled, ${notCompared.notChecked} from rules not run (neither new nor resolved)`
  );
  if (reportUrl) deps.out(`Report: ${reportUrl}`);
  deps.out(creditLine.line);
}

/** Start the run, wait for it, compare, print, and decide the exit code. */
export async function runNewFindingsGate(
  deps: GateDeps,
  opts: GateOptions
): Promise<GateResult> {
  const fail = (
    code: number,
    reason: GateExitReason,
    message: string
  ): GateResult => {
    deps.err(`squirrel ci: ${message}`);
    return { code, reason };
  };

  const creditsBefore = await readCredits(deps);

  const started = await deps.request<{ id?: string }>(
    "POST",
    "/v1/agent-runs",
    {
      url: opts.url,
      websiteId: opts.websiteId,
      trigger: "api",
      ...(opts.maxPages !== undefined
        ? { config: { maxPages: opts.maxPages } }
        : {}),
    }
  );
  const runId = started.data?.id;
  if (!started.ok || !runId) {
    return fail(
      1,
      "start_failed",
      `could not start the audit: ${apiErrorText(started)}`
    );
  }
  deps.err(
    `squirrel ci: started run ${oneLine(runId)} for website ${oneLine(opts.websiteId)}`
  );

  // Wait for a terminal status, and for the report to be finalized once the run completed.
  const deadline = deps.now() + opts.timeoutMs;
  let run: RunRecord = { id: runId, status: "pending" };
  let failures = 0;
  let lastProgress = "";
  for (;;) {
    const reply = await deps.request<RunRecord>(
      "GET",
      `/v1/agent-runs/${encodeURIComponent(runId)}`
    );
    if (reply.ok && reply.data) {
      failures = 0;
      run = reply.data;
      const terminal = TERMINAL_RUN_STATUSES.has(run.status ?? "");
      if (terminal && run.reportAvailability !== "pending") break;
      const progress = `${run.status ?? "?"}${run.progress?.phase ? ` (${oneLine(run.progress.phase, 40)}${run.progress.total ? ` ${run.progress.current ?? 0}/${run.progress.total}` : ""})` : ""}`;
      if (progress !== lastProgress) {
        deps.err(`squirrel ci: ${progress}`);
        lastProgress = progress;
      }
    } else if (
      reply.status === 401 ||
      reply.status === 403 ||
      reply.status === 404
    ) {
      return fail(
        1,
        "run_failed",
        `could not read run ${oneLine(runId)}: ${apiErrorText(reply)}`
      );
    } else if (++failures >= MAX_POLL_FAILURES) {
      return fail(
        1,
        "run_failed",
        `could not read run ${oneLine(runId)} ${MAX_POLL_FAILURES} times in a row: ${apiErrorText(reply)}`
      );
    }
    if (deps.now() + opts.pollIntervalMs >= deadline) {
      return fail(
        1,
        "timeout",
        `run ${oneLine(runId)} did not finish within ${Math.round(opts.timeoutMs / 60000)} minutes (last status ${oneLine(run.status)}); it keeps running in the cloud`
      );
    }
    await deps.sleep(opts.pollIntervalMs);
  }

  if (run.status !== "completed") {
    // A run that ended without a report. A site that could not be reached is its own code.
    const code = UNREACHABLE_REASON_CODES.has(run.completionReason ?? "")
      ? EXIT_CODE_UNREACHABLE
      : 1;
    const detail = oneLine(
      run.error ??
        run.completionMessage ??
        run.completionReason ??
        "no reason given"
    );
    deps.err(
      `squirrel ci: run ${oneLine(runId)} ended ${oneLine(run.status)}: ${detail}`
    );
    return {
      code,
      reason: code === EXIT_CODE_UNREACHABLE ? "unreachable" : "run_failed",
    };
  }

  const creditsAfter = await readCredits(deps);

  let compareReply: ApiReply<CompareResponse> | null = null;
  const comparePath =
    `/v1/websites/${encodeURIComponent(opts.websiteId)}/audits/compare` +
    `?head=${encodeURIComponent(runId)}&fail_on=${opts.failOn}&limit=${COMPARE_LIMIT}`;
  for (let attempt = 1; attempt <= COMPARE_ATTEMPTS; attempt++) {
    compareReply = await deps.request<CompareResponse>("GET", comparePath);
    if (compareReply.ok && compareReply.data) break;
    // The report can lag the run by moments: only a 404, a 5xx or a transport failure is retried.
    const retryable =
      compareReply.status === 0 ||
      compareReply.status === 404 ||
      compareReply.status >= 500;
    if (!retryable || attempt === COMPARE_ATTEMPTS) break;
    await deps.sleep(COMPARE_RETRY_MS);
  }
  if (!compareReply?.ok || !compareReply.data) {
    return fail(
      1,
      "compare_failed",
      `could not read the comparison for run ${oneLine(runId)}: ${compareReply ? apiErrorText(compareReply) : "no reply"}`
    );
  }

  const decision = decideExit(compareReply.data, run);
  report(deps, opts, run, compareReply.data, decision, {
    before: creditsBefore,
    after: creditsAfter,
  });
  return decision;
}
