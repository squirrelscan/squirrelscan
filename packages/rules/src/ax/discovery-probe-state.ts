// What an ax rule may conclude from a discovery probe that got no answer (#409).
//
// A probe is not sent when discovery probes are turned off, when no enabled rule
// read it at crawl time, or when the crawl preamble's time budget ran out first.
// A probe that was sent can still get no answer: a refused connection (a
// firewall that just banned the audit), a timeout, or the budget's deadline
// aborting it mid-flight. None of those is evidence about the site: the file
// may well exist. So the rule says "not checked", as an info check that never
// counts as a failure, instead of the "not found" it reports for a request that
// did get an answer.

import {
  PROBE_NOT_SENT_ERRORS,
  PROBE_PATH_NOT_APPROVED_ERROR,
  PROBE_REDIRECT_NOT_FOLLOWED_ERROR,
} from "@squirrelscan/core-contracts/storage";

import type {
  WellKnownPath,
  WellKnownProbe,
  WellKnownProbeData,
} from "@squirrelscan/core-contracts";

import type { CheckResult } from "../types";

/** The `value` every not-checked check carries, for machine readers. */
export const NOT_CHECKED = "not-checked";

/**
 * Why a probe says nothing: it never went out, it went out and got no answer,
 * or the crawler kept no result, which is either (llms, markdown and RSL store
 * no row in both cases).
 */
export type NotCheckedReason =
  | "not-sent"
  | "no-answer"
  | "no-result"
  | "blocked"
  | "not-approved"
  | "redirect-not-followed";

const REASON_TEXT: Record<NotCheckedReason, string> = {
  "not-sent": "the discovery probe was not sent",
  "no-answer": "the discovery probe got no answer",
  "no-result": "the discovery probe was not sent or got no answer",
  blocked: "the discovery probe was refused or throttled",
  "not-approved": "path not approved ([crawler] discovery_probe_paths)",
  "redirect-not-followed":
    "the request was sent but its redirect to another path was not followed ([crawler] discovery_probe_paths)",
};

/** An info check saying `subject` was not checked, and why. */
export function notCheckedCheck(
  name: string,
  subject: string,
  details?: Record<string, unknown>,
  reason: NotCheckedReason = "not-sent",
): CheckResult {
  return {
    name,
    status: "info",
    message: `${subject} not checked: ${REASON_TEXT[reason]}`,
    value: NOT_CHECKED,
    ...(details ? { details } : {}),
  };
}

/** `paths.includes(path)` for a path read back from storage, a plain string. */
export function includesPath(paths: readonly WellKnownPath[], path: string): boolean {
  return (paths as readonly string[]).includes(path);
}

/**
 * Whether a stored probe reflects a request that went out. The budget skip is
 * recorded as `status: 0` with the not-attempted marker, the same status a
 * network failure gets, so the marker is the only discriminator.
 */
export function wasSent(probe: { status: number; error: string | null }): boolean {
  return !(probe.status === 0 && probe.error !== null && PROBE_NOT_SENT_ERRORS.includes(probe.error));
}

/** Whether a stored probe got an HTTP answer. `status: 0` is no answer at all. */
export function answered(probe: { status: number }): boolean {
  return probe.status > 0;
}

/** "not-sent" when none of `probes` went out, else "no-answer". */
export function notCheckedReason(
  probes: ReadonlyArray<{ status: number; error: string | null } | undefined>,
): NotCheckedReason {
  if (probes.some((p) => p !== undefined && wasSent(p))) return "no-answer";
  // The request went out and was redirected off its approved path: it was sent, so never say "not sent".
  const present0 = probes.filter((p) => p !== undefined);
  if (present0.length > 0 && present0.every((p) => p.error === PROBE_REDIRECT_NOT_FOLLOWED_ERROR)) {
    return "redirect-not-followed";
  }
  // Every silent path was left out by the allowlist: say so, rather than blaming a block or a budget.
  const present = probes.filter((p) => p !== undefined);
  if (present.length > 0 && present.every((p) => p.error === PROBE_PATH_NOT_APPROVED_ERROR)) {
    return "not-approved";
  }
  return "not-sent";
}

/**
 * Split `paths` into the well-known probes that got an answer and the paths
 * that did not: missing from the sweep (probes off, or no enabled reader when
 * the crawl ran), skipped by the budget, or sent with no answer.
 */
export function answeredWellKnown(
  wellKnown: WellKnownProbeData,
  paths: readonly WellKnownPath[],
): { answered: WellKnownProbe[]; unchecked: WellKnownPath[]; reason: NotCheckedReason } {
  const done: WellKnownProbe[] = [];
  const unchecked: WellKnownPath[] = [];
  const silent: Array<WellKnownProbe | undefined> = [];
  for (const path of paths) {
    const probe = wellKnown.probes.find((p) => p.path === path);
    if (probe && answered(probe)) {
      done.push(probe);
    } else {
      unchecked.push(path);
      silent.push(probe);
    }
  }
  return { answered: done, unchecked, reason: notCheckedReason(silent) };
}
