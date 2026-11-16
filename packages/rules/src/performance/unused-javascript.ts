// performance/unused-javascript - first-party JavaScript that is downloaded but never run
// (cloud-backed, site-scope, repo#4681)
//
// Reads the runner's JavaScript coverage from the runtime-perf envelope. Third-party scripts are
// listed in the details for context but never counted toward the verdict: the site owner cannot
// shrink a tag vendor's bundle, and perf/inp-hints already speaks to third-party load.

import type { RuntimePerfScript } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { readRuntimePerf, RUNNER_NOTE } from "./runtime-perf-signal";

/** First-party unused bytes across the sampled pages above which the check warns. */
export const UNUSED_WARN_BYTES = 100 * 1024;
/** ...and above which it fails. */
export const UNUSED_FAIL_BYTES = 500 * 1024;
/** Scripts listed as items. */
const TOP_SCRIPTS = 10;

interface Tally {
  url: string;
  totalBytes: number;
  unusedBytes: number;
  pages: string[];
}

function tally(
  pages: { url: string; scripts: RuntimePerfScript[] }[],
  thirdParty: boolean,
): Tally[] {
  const byUrl = new Map<string, Tally>();
  for (const page of pages) {
    for (const s of page.scripts) {
      if (s.thirdParty !== thirdParty) continue;
      const unused = Math.min(Math.max(s.unusedBytes, 0), Math.max(s.totalBytes, 0));
      const cur = byUrl.get(s.url);
      if (!cur) {
        byUrl.set(s.url, { url: s.url, totalBytes: s.totalBytes, unusedBytes: unused, pages: [page.url] });
      } else {
        // One bundle on many pages is one bundle: count the worst page, not the sum.
        cur.totalBytes = Math.max(cur.totalBytes, s.totalBytes);
        cur.unusedBytes = Math.max(cur.unusedBytes, unused);
        cur.pages.push(page.url);
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => b.unusedBytes - a.unusedBytes || (a.url < b.url ? -1 : 1));
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const sum = (xs: Tally[], f: (t: Tally) => number) => xs.reduce((n, t) => n + f(t), 0);

export const unusedJavascriptRule: Rule = {
  meta: {
    id: "perf/unused-javascript",
    name: "Unused JavaScript",
    description:
      "Lists the first-party scripts with the most JavaScript that is downloaded but never executed, from a browser run in a cloud audit",
    solution:
      "Split the largest first-party bundles by route, load rarely used code with dynamic import(), and drop dependencies the page does not call. Re-run the audit to confirm the unused bytes fall.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 3,
    checks: [
      { name: "unused-javascript", outcome: "problem" },
      { name: "unused-javascript", outcome: "clean", clears: ["unused-javascript"] },
      { name: "unused-javascript", outcome: "skipped" },
    ],
    cloud: { service: "runtime-perf", unit: "site", creditFeature: "runtime_perf" },
  },

  run(ctx: RuleContext): RuleResult {
    const read = readRuntimePerf(ctx, "unused-javascript");
    if ("skipped" in read) return { checks: [read.skipped] };
    const { pages, totalPages } = read.data;

    const first = tally(pages, false);
    const third = tally(pages, true);
    const firstUnused = sum(first, (t) => t.unusedBytes);
    const firstTotal = sum(first, (t) => t.totalBytes);
    const thirdUnused = sum(third, (t) => t.unusedBytes);

    const status: CheckResult["status"] =
      firstUnused >= UNUSED_FAIL_BYTES ? "fail" : firstUnused >= UNUSED_WARN_BYTES ? "warn" : "pass";
    const sampled = `${pages.length}${totalPages ? ` of ${totalPages}` : ""} sampled page${pages.length === 1 ? "" : "s"}`;
    const percent = firstTotal > 0 ? Math.round((firstUnused / firstTotal) * 100) : 0;

    const check: CheckResult = {
      name: "unused-javascript",
      status,
      message:
        status === "pass"
          ? `First-party JavaScript is mostly used: ${kb(firstUnused)} unused of ${kb(firstTotal)} across ${sampled}. ${RUNNER_NOTE}`
          : `${kb(firstUnused)} of ${kb(firstTotal)} first-party JavaScript (${percent}%) is never executed across ${sampled}. ${RUNNER_NOTE}`,
      value: firstUnused,
      details: {
        firstPartyUnusedBytes: firstUnused,
        firstPartyTotalBytes: firstTotal,
        // Context only: kept out of the verdict above.
        thirdPartyUnusedBytes: thirdUnused,
        thirdPartyScripts: third.length,
        sampledPages: pages.length,
        ...(totalPages ? { totalPages } : {}),
        measuredBy: "squirrelscan cloud runner",
      },
    };
    if (status !== "pass") {
      check.items = first
        .filter((t) => t.unusedBytes > 0)
        .slice(0, TOP_SCRIPTS)
        .map((t) => ({
          id: t.url,
          label: `${kb(t.unusedBytes)} unused of ${kb(t.totalBytes)}`,
          sourcePages: t.pages.slice(0, 5),
        }));
    }
    return { checks: [check] };
  },
};
