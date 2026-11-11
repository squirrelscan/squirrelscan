import { APPROVABLE_PROBE_PATHS } from "@squirrelscan/core-contracts/storage";

import { normalizeHeaderArgs } from "./headers";

export type ProbePathsParse =
  | { ok: true; paths: string[] }
  | { ok: false; error: string };

/**
 * Reads `--discovery-probe-path` (repeatable or comma-separated) into the exact probe paths it
 * names (#1655). A path that is not one of the probe paths is an error rather than a silent
 * no-op: a typo would otherwise leave the probe unsent with no word about why.
 */
export function parseDiscoveryProbePaths(
  raw: string | string[] | undefined
): ProbePathsParse {
  const paths = normalizeHeaderArgs(raw)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const bad = paths.find((path) => !APPROVABLE_PROBE_PATHS.includes(path));
  if (bad !== undefined) {
    return {
      ok: false,
      error: `Invalid --discovery-probe-path "${bad}": use a probe path exactly as written, one of ${APPROVABLE_PROBE_PATHS.join(", ")}`,
    };
  }
  return { ok: true, paths: [...new Set(paths)] };
}
