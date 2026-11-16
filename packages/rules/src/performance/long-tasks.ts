// performance/long-tasks - main-thread long tasks and total blocking time on sampled pages
// (cloud-backed, site-scope, repo#4681)
//
// Reads the runner's long-task measurement from the runtime-perf envelope. The numbers come
// from squirrelscan's cloud runner, a lab measurement on one machine, so the copy says so and
// the rule never claims what a visitor's device would see.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { readRuntimePerf, RUNNER_NOTE } from "./runtime-perf-signal";

/** Total blocking time (ms) above which a page warns: the "needs improvement" edge Lighthouse uses. */
export const TBT_WARN_MS = 200;
/** ...and above which it fails: the "poor" edge. */
export const TBT_FAIL_MS = 600;
const TOP_PAGES = 10;

export const longTasksRule: Rule = {
  meta: {
    id: "perf/long-tasks",
    name: "Long Tasks",
    description:
      "Reports the longest main-thread task and total blocking time on sampled pages, measured by the cloud runner's browser",
    solution:
      "Find the scripts behind the longest tasks in a performance trace, split or defer that work, and move heavy computation off the main thread. Re-run the audit to confirm total blocking time falls.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 3,
    checks: [
      { name: "long-tasks", outcome: "problem" },
      { name: "long-tasks", outcome: "clean", clears: ["long-tasks"] },
      { name: "long-tasks", outcome: "skipped" },
    ],
    cloud: { service: "runtime-perf", unit: "site", creditFeature: "runtime_perf" },
  },

  run(ctx: RuleContext): RuleResult {
    const read = readRuntimePerf(ctx, "long-tasks");
    if ("skipped" in read) return { checks: [read.skipped] };
    const { pages, totalPages } = read.data;

    const measured = pages.filter((p) => p.longTasks !== null);
    if (measured.length === 0) {
      return {
        checks: [
          {
            name: "long-tasks",
            status: "skipped",
            message: "long-tasks skipped: the runner recorded no long-task data",
            skipReason: "The cloud runner could not record long tasks on the sampled pages.",
          },
        ],
      };
    }

    const rows = measured
      .map((p) => ({ url: p.url, ...p.longTasks! }))
      .sort((a, b) => b.tbtMs - a.tbtMs || b.longestMs - a.longestMs || (a.url < b.url ? -1 : 1));
    const worst = rows[0];
    const longest = rows.reduce((m, r) => Math.max(m, r.longestMs), 0);
    const status: CheckResult["status"] =
      worst.tbtMs > TBT_FAIL_MS ? "fail" : worst.tbtMs > TBT_WARN_MS ? "warn" : "pass";
    const sampled = `${measured.length}${totalPages ? ` of ${totalPages}` : ""} sampled page${measured.length === 1 ? "" : "s"}`;

    const check: CheckResult = {
      name: "long-tasks",
      status,
      message:
        status === "pass"
          ? `Longest main-thread task ${Math.round(longest)} ms, worst total blocking time ${Math.round(worst.tbtMs)} ms across ${sampled}. ${RUNNER_NOTE}`
          : `Total blocking time reaches ${Math.round(worst.tbtMs)} ms (longest task ${Math.round(longest)} ms) across ${sampled}. ${RUNNER_NOTE}`,
      value: Math.round(worst.tbtMs),
      details: {
        longestTaskMs: Math.round(longest),
        worstTbtMs: Math.round(worst.tbtMs),
        sampledPages: measured.length,
        ...(totalPages ? { totalPages } : {}),
        measuredBy: "squirrelscan cloud runner",
      },
    };
    if (status !== "pass") {
      check.items = rows
        .filter((r) => r.tbtMs > TBT_WARN_MS)
        .slice(0, TOP_PAGES)
        .map((r) => ({
          id: r.url,
          label: `TBT ${Math.round(r.tbtMs)} ms, longest task ${Math.round(r.longestMs)} ms, ${r.count} long task${r.count === 1 ? "" : "s"}`,
          sourcePages: [r.url],
        }));
    }
    return { checks: [check] };
  },
};
