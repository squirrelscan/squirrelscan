// perf/render-blocking - Render-blocking resources

import { querySelectorAllOutsideNoscript, resolveUrl } from "@squirrelscan/utils";
import { isSlowBlockingScript, SLOW_BLOCKING_SCRIPT_MS } from "@squirrelscan/utils/constants";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints, scriptLoading } from "./cwv";

// The audit fetches each script once, so the time a head script took to answer is
// a site input: it is read here by the resolved URL of every blocking script.
function slowBlockingScripts(ctx: RuleContext): CheckResult | null {
  const head = ctx.parsed.document?.head;
  const scripts = ctx.site?.scripts;
  if (!head || !scripts || scripts.length === 0) return null;
  const timed = new Map<string, { ms: number; hostFirst: boolean }>();
  for (const script of scripts) {
    if (script.responseMs === undefined) continue;
    const entry = { ms: script.responseMs, hostFirst: script.hostFirst === true };
    timed.set(script.url, entry);
    if (script.finalUrl) timed.set(script.finalUrl, entry);
  }
  const slow = new Map<string, number>();
  for (const el of querySelectorAllOutsideNoscript(head, "script[src]")) {
    const src = el.getAttribute("src");
    if (!src || scriptLoading(el) !== "blocking") continue;
    const url = resolveUrl(src, ctx.page.url);
    const entry = url ? timed.get(url) : undefined;
    if (url && entry && isSlowBlockingScript(entry.ms, entry.hostFirst)) slow.set(url, entry.ms);
  }
  if (slow.size === 0) return null;
  const ranked = [...slow].sort((a, b) => b[1] - a[1]);
  return {
    name: "slow-blocking-script",
    status: "warn",
    message: `${ranked.length} render-blocking script(s) took over ${SLOW_BLOCKING_SCRIPT_MS} ms to respond (slowest: ${ranked[0]![0]}, ${ranked[0]![1]} ms)`,
    items: ranked.map(([url, ms]) => ({
      id: url,
      meta: { responseMs: ms, thresholdMs: SLOW_BLOCKING_SCRIPT_MS },
    })),
  };
}

export const renderBlockingRule: Rule = {
  meta: {
    id: "perf/render-blocking",
    name: "Render-Blocking Resources",
    description:
      "Checks for render-blocking CSS and JavaScript, and flags blocking scripts that were slow to respond",
    solution:
      "Render-blocking resources delay First Contentful Paint (FCP) and LCP. Fix by: 1) Inline critical CSS for above-fold content. 2) Load non-critical CSS with media='print' onload='this.media=all'. 3) Add async or defer to non-critical scripts: a blocking script that is slow to respond (over 1 second) stalls the page for that long. 4) Move scripts to end of body when possible. 5) Use <link rel='preload'> for critical resources. Consider tools like Critical to extract critical CSS.",
    category: "perf",
    scope: "page",
    // Reads the response time of the page's own resolved script URLs from the site's
    // fetched scripts, which a template key (raw src strings) does not determine.
    verdictScope: "page",
    severity: "warning",
    weight: 6,
    // Check names by outcome class (#1741).
    checks: [
      { name: "render-blocking", outcome: "problem" },
      { name: "render-blocking", outcome: "clean", clears: ["render-blocking", "slow-blocking-script"] },
      { name: "slow-blocking-script", outcome: "problem" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check render-blocking resources
    if (hints.renderBlockingResources.length > 3) {
      checks.push({
        name: "render-blocking",
        status: "warn",
        message: `${hints.renderBlockingResources.length} render-blocking resources`,
        items: hints.renderBlockingResources.map((url) => ({ id: url })),
      });
    } else if (hints.renderBlockingResources.length > 0) {
      checks.push({
        name: "render-blocking",
        status: "info",
        message: `${hints.renderBlockingResources.length} render-blocking resource(s)`,
        items: hints.renderBlockingResources.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "render-blocking",
        status: "pass",
        message: "No significant render-blocking resources",
      });
    }

    const slow = slowBlockingScripts(ctx);
    if (slow) checks.push(slow);

    return { checks };
  },
};
