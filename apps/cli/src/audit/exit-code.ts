// The exit code of `squirrel audit` and the outcome the report carries (#1657).
//
// The command used to assign `process.exitCode` in 34 places, each overwriting the last, and the
// explicit-publish failure paths returned early and skipped the failed/blocked code and the
// `--fail-on` gate. The code is now a pure function of what happened, computed in one place, and
// the same facts go into the JSON and LLM reports so a CI gate or an agent reads the exit code
// without waiting for the process to end.

import type {
  AuditStatus,
  AuditOutcome,
  PublishOutcome,
} from "@squirrelscan/core-contracts";

import { EXIT_CODE_REDIRECTED } from "@squirrelscan/core-contracts/seed-redirect";

import { EXIT_CODE_UNREACHABLE, EXIT_CODE_WAF_BLOCKED } from "@/constants";

export type { AuditOutcome, PublishOutcome };

/** A run that ended before it produced an audit report. */
export type EarlyExit =
  /** Bad flags, a refused start URL, a store problem, a plugin that would not load: nothing ran. */
  | "validation"
  /** The audit returned an error (a crash, a store that could not be written). */
  | "error"
  /** The start URL redirected to another site and the run was not told to follow it. */
  | "redirected"
  /** The start URL could not be reached at all. */
  | "unreachable";

export interface ExitInput {
  early?: EarlyExit;
  /** The report's status, when the run produced a report. */
  auditStatus?: AuditStatus;
  /** What the publish phase did. Absent before it ran. */
  publish?: PublishOutcome;
  /** A `--fail-on` condition tripped on the finished report. */
  gateTripped?: boolean;
}

/** Which row of the precedence table decided the code. */
export type ExitReason =
  | "unreachable"
  | "redirected"
  | "validation"
  | "error"
  | "blocked"
  | "failed"
  | "publish-failed"
  | "gate"
  | "ok";

/**
 * The precedence, first match wins:
 *
 * 1. `unreachable` 5, `redirected` 4, `validation` or `error` 1: the run never produced a report.
 * 2. a `blocked` report 3 (the site's perimeter refused the crawler).
 * 3. a `failed` report 1 (the site is down, or answered with an error).
 * 4. an explicit `--publish` that failed 1 (publishing was the stated goal), which also means the
 *    `--fail-on` gate was not evaluated.
 * 5. a tripped `--fail-on` gate 2.
 * 6. anything else 0: a completed or `partial` report, and an AUTO-publish that failed (a side
 *    effect of a successful audit; the failure is in `outcome.publish` and on stderr).
 */
export function computeExitCode(input: ExitInput): {
  code: number;
  reason: ExitReason;
} {
  if (input.early === "unreachable")
    return { code: EXIT_CODE_UNREACHABLE, reason: "unreachable" };
  if (input.early === "redirected")
    return { code: EXIT_CODE_REDIRECTED, reason: "redirected" };
  if (input.early === "validation") return { code: 1, reason: "validation" };
  if (input.early === "error") return { code: 1, reason: "error" };
  if (input.auditStatus === "blocked")
    return { code: EXIT_CODE_WAF_BLOCKED, reason: "blocked" };
  if (input.auditStatus === "failed") return { code: 1, reason: "failed" };
  if (input.publish?.status === "failed" && input.publish.explicit) {
    return { code: 1, reason: "publish-failed" };
  }
  if (input.gateTripped) return { code: 2, reason: "gate" };
  return { code: 0, reason: "ok" };
}

/** Why the publish phase did nothing, in the order the decision checks them. */
export type PublishSkipReason =
  | "non-public-host"
  | "server-ignored-ephemeral"
  | "offline"
  | "ephemeral"
  | "rule-filter"
  | "targeted"
  | "no-publish"
  | "config-off"
  | "signed-out";

export function publishSkipReason(opts: {
  nonPublicHost: boolean;
  serverIgnoredEphemeral: boolean;
  offline: boolean;
  ephemeral: boolean;
  explicitPublish: boolean;
  ruleFilterActive: boolean;
  /** #1777: a `--target-url` run. Not published unless --publish is explicit. */
  targeted?: boolean;
  noPublish: boolean;
  configPublish: boolean;
}): PublishSkipReason {
  if (opts.nonPublicHost) return "non-public-host";
  if (opts.serverIgnoredEphemeral) return "server-ignored-ephemeral";
  if (opts.offline) return "offline";
  if (opts.ephemeral && !opts.explicitPublish) return "ephemeral";
  if (opts.ruleFilterActive) return "rule-filter";
  if (opts.targeted) return "targeted";
  if (opts.noPublish) return "no-publish";
  if (!opts.configPublish) return "config-off";
  return "signed-out";
}

/** The outcome stamped on the report: the exit code, the audit status and the publish result. */
export function buildOutcome(
  exitCode: number,
  auditStatus: AuditStatus | undefined,
  publish: PublishOutcome
): AuditOutcome {
  return {
    exit_code: exitCode,
    status: auditStatus ?? "completed",
    publish:
      publish.status === "published"
        ? { status: "published" }
        : publish.status === "skipped"
          ? { status: "skipped", reason: publish.reason }
          : { status: "failed", reason: publish.reason },
  };
}

/** The one place the audit command sets the process exit code. */
export function applyExitCode(code: number): number {
  process.exitCode = code;
  return code;
}

/** Compute the code for `input` and set it. Returns the code. */
export function exitWith(input: ExitInput): number {
  return applyExitCode(computeExitCode(input).code);
}

/**
 * The end of a finished audit, run exactly once however the publish phase went (#1657).
 *
 * `settle()` is the normal path, called when the publish phase is over. `finish(reason)` is for a
 * path that cannot reach it: a step of the publish phase threw, or the run was interrupted. It
 * settles with a failed explicit publish carrying `reason`, so the report is still written (it was
 * held back for the outcome) and the exit code is set. A second call does nothing.
 */
export function createSettler<G extends { trips: readonly unknown[] }>(deps: {
  auditStatus: AuditStatus | undefined;
  getPublish: () => PublishOutcome;
  /** Evaluates the `--fail-on` gate; not called when an explicit publish failed (it outranks the gate). */
  evaluateGate: () => G | null;
  /** Puts the outcome on the report. */
  stamp: (outcome: AuditOutcome) => void;
  /** Writes the report that was held back for the outcome. */
  emit: () => void;
  apply: (code: number) => void;
}): {
  settle: () => void;
  finish: (reason: string) => void;
  gate: () => G | null;
  settled: () => boolean;
} {
  let done = false;
  let gate: G | null = null;
  const run = (publish: PublishOutcome): void => {
    if (done) return;
    done = true;
    const explicitPublishFailed =
      publish.status === "failed" && publish.explicit;
    gate = explicitPublishFailed ? null : deps.evaluateGate();
    const { code } = computeExitCode({
      auditStatus: deps.auditStatus,
      publish,
      gateTripped: (gate?.trips.length ?? 0) > 0,
    });
    deps.stamp(buildOutcome(code, deps.auditStatus, publish));
    // The code first: a report that fails to write must not leave the exit code unset.
    deps.apply(code);
    deps.emit();
  };
  return {
    settle: () => run(deps.getPublish()),
    finish: (reason) => run({ status: "failed", reason, explicit: true }),
    gate: () => gate,
    settled: () => done,
  };
}
