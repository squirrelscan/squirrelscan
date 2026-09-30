// What an ax rule may conclude from a discovery probe that was never sent (#409).
//
// A probe is not sent when discovery probes are turned off, when no enabled rule
// read it at crawl time, or when the crawl preamble's time budget ran out first.
// None of those is evidence about the site: the file may well exist. So the rule
// says "not checked", as an info check that never counts as a failure, instead
// of the "not found" it would report for a request that did get an answer.

import { PROBE_NOT_ATTEMPTED_ERROR } from "@squirrelscan/core-contracts/storage";

import type {
  WellKnownPath,
  WellKnownProbe,
  WellKnownProbeData,
} from "@squirrelscan/core-contracts";

import type { CheckResult } from "../types";

/** The `value` every not-checked check carries, for machine readers. */
export const NOT_CHECKED = "not-checked";

/** An info check saying `subject` was not checked because its probe was not sent. */
export function notCheckedCheck(
  name: string,
  subject: string,
  details?: Record<string, unknown>,
): CheckResult {
  return {
    name,
    status: "info",
    message: `${subject} not checked: the discovery probe was not sent`,
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
  return !(probe.status === 0 && probe.error === PROBE_NOT_ATTEMPTED_ERROR);
}

/**
 * Split `paths` into the well-known probes that were sent and the paths that
 * were not: missing from the sweep (probes off, or no enabled reader when the
 * crawl ran), or skipped by the budget.
 */
export function sentWellKnown(
  wellKnown: WellKnownProbeData,
  paths: readonly WellKnownPath[],
): { sent: WellKnownProbe[]; unsent: WellKnownPath[] } {
  const sent: WellKnownProbe[] = [];
  const unsent: WellKnownPath[] = [];
  for (const path of paths) {
    const probe = wellKnown.probes.find((p) => p.path === path);
    if (probe && wasSent(probe)) sent.push(probe);
    else unsent.push(path);
  }
  return { sent, unsent };
}
