// Shared reader for the cloud runtime-perf envelope (repo#4681), used by
// perf/unused-javascript and perf/long-tasks.

import type { RuntimePerfResult } from "@squirrelscan/core-contracts";

import { readCloudResult } from "../cloud";
import type { CheckResult, RuleContext } from "../types";

/** The runner that takes the measurement is ours, so the copy never speaks for a visitor's device. */
export const RUNNER_NOTE =
  "Measured by squirrelscan's cloud runner on a sample of pages, not on your visitors' devices.";

const SKIP_REASON =
  "Runtime measurement needs a cloud audit: squirrelscan's cloud runner executes the page in a browser. Local CLI audits skip this check.";

/** The sampled measurements, or the skipped check to return when there are none. */
export function readRuntimePerf(
  ctx: RuleContext,
  checkName: string,
): { data: RuntimePerfResult } | { skipped: CheckResult } {
  const envelope = readCloudResult<RuntimePerfResult>(ctx.cloudResults, "runtime-perf");
  if (!envelope || envelope.status === "skipped" || !envelope.data) {
    return {
      skipped: {
        name: checkName,
        status: "skipped",
        message: `${checkName} skipped: no runtime measurement for this run`,
        skipReason: SKIP_REASON,
        ...(envelope?.skipReason ? { details: { cloudSkipReason: envelope.skipReason } } : {}),
      },
    };
  }
  if (envelope.data.pages.length === 0) {
    return {
      skipped: {
        name: checkName,
        status: "skipped",
        message: `${checkName} skipped: the runner sampled no pages`,
        skipReason: "The cloud runner measured no pages in this run.",
      },
    };
  }
  return { data: envelope.data };
}
