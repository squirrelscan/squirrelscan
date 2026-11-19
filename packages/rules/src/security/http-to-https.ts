// security/http-to-https - Detect HTTP to HTTPS redirects

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RedirectChain } from "@squirrelscan/core-contracts";

import { HTTP_PROBE_LIMITS } from "@squirrelscan/utils/constants";
import { followRedirects } from "../links/redirects";
import { hasRequestTool } from "../tools";
import { getHostname } from "@squirrelscan/utils";

const ANALYZE_OFFLINE_REASON = "analyze runs offline; run `squirrel audit` to probe";

export const optionsSchema = z.object({
  sampleLimit: z
    .number()
    .int()
    .min(1)
    .max(HTTP_PROBE_LIMITS.MAX_SAMPLE_SIZE)
    .default(HTTP_PROBE_LIMITS.DEFAULT_SAMPLE_SIZE)
    .describe("Maximum number of pages to probe for HTTP→HTTPS redirects"),
  probeBudgetMs: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .default(HTTP_PROBE_LIMITS.PROBE_TOTAL_BUDGET_MS)
    .describe(
      "Total time budget in milliseconds for all probes; when it runs out the rule reports partial coverage"
    ),
});

// Add delay between probes to prevent rate limiting
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Validate that URL is from the same domain as base
function isValidProbeTarget(url: string, baseUrl: string): boolean {
  try {
    const baseHost = getHostname(baseUrl);
    const targetHost = getHostname(url);
    return baseHost !== "" && targetHost !== "" && baseHost === targetHost;
  } catch {
    return false;
  }
}

export interface ProbeResult {
  from: string;
  to: string;
  statusCode?: number;
  chain?: RedirectChain;
}

/**
 * What one http:// probe found.
 * - `redirects`: the chain ended on https://.
 * - `insecure`: the http:// URL answered (or redirected within http) and never
 *   reached https://.
 * - `unverified`: no verdict (request failed, rate limited, error status,
 *   redirect loop, off-host target). Not a finding: a host that does not listen
 *   on port 80 at all lands here.
 */
export interface ProbeOutcome {
  from: string;
  to: string;
  kind: "redirects" | "insecure" | "unverified";
  statusCode?: number;
  chain?: RedirectChain;
}

export interface ProbeReport {
  /** One entry per url that was actually probed, in input order. */
  outcomes: ProbeOutcome[];
  /** Urls never started because the total budget ran out. */
  notProbed: number;
}

function classify(chain: RedirectChain): ProbeOutcome["kind"] {
  if (chain.isLoop) return "unverified";
  if (chain.httpToHttps || chain.finalUrl.startsWith("https://")) return "redirects";
  if (chain.endsInError || chain.endsRateLimited) return "unverified";
  return "insecure";
}

/**
 * Probe HTTP variants of sample urls with a bounded worker pool. The serial
 * 500ms-per-probe loop dominated the entire rules phase (~10s for 20 urls);
 * 5 workers with a 100ms intra-worker stagger keep the politeness property
 * while finishing in ~1s. Outcomes preserve input order. Exported for tests.
 */
export async function probeHttpCoverage(
  urls: string[],
  baseUrl: string,
  probe: (httpUrl: string) => Promise<RedirectChain>,
  options?: { concurrency?: number; staggerMs?: number; budgetMs?: number }
): Promise<ProbeReport> {
  const concurrency = Math.max(
    1,
    options?.concurrency ?? HTTP_PROBE_LIMITS.PROBE_CONCURRENCY
  );
  const staggerMs = options?.staggerMs ?? HTTP_PROBE_LIMITS.PROBE_STAGGER_MS;
  // #1252: total wall-clock budget for the whole probe. This step runs inside
  // the rules phase and re-hits the target host, so a tarpit could stretch it
  // across minutes; once the budget is spent, workers stop pulling new URLs and
  // the rule reports on whatever subset it already probed (#1269: and says so).
  // In-flight probes are separately bounded by the per-hop timeout in
  // followRedirects.
  const budgetMs =
    options?.budgetMs && options.budgetMs > 0
      ? options.budgetMs
      : HTTP_PROBE_LIMITS.PROBE_TOTAL_BUDGET_MS;
  const deadlineAt = Date.now() + budgetMs;

  const results: Array<ProbeOutcome | undefined> = new Array(urls.length).fill(undefined);
  let nextIndex = 0;
  let notProbed = 0;

  async function worker(workerIndex: number): Promise<void> {
    // Stagger worker start too: without this all workers fire their first
    // probe simultaneously, bursting the audited host with `concurrency`
    // requests at t=0.
    let first = true;
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      // Stop launching new probes once the total budget is spent (#1252).
      if (Date.now() >= deadlineAt) {
        notProbed++;
        continue;
      }
      const startDelay = first ? workerIndex * staggerMs : staggerMs;
      if (startDelay > 0) await delay(startDelay);
      first = false;
      if (Date.now() >= deadlineAt) {
        notProbed++;
        continue;
      }

      const url = urls[index]!;
      let from = "";
      try {
        const httpUrl = new URL(url);
        httpUrl.protocol = "http:";
        from = httpUrl.toString();

        // Double-check probe target is valid
        if (!isValidProbeTarget(from, baseUrl)) continue;

        const chain = await probe(from);
        results[index] = {
          from,
          to: chain.finalUrl,
          kind: classify(chain),
          statusCode: chain.hops[0]?.statusCode,
          chain,
        };
      } catch {
        // The probe threw (e.g. connection refused on port 80): no verdict.
        if (from) results[index] = { from, to: "", kind: "unverified" };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, (_, i) => worker(i))
  );

  return {
    outcomes: results.filter((r): r is ProbeOutcome => r !== undefined),
    notProbed,
  };
}

/** The probes that redirected to https://. Kept for callers that only want those. */
export async function probeHttpVariants(
  urls: string[],
  baseUrl: string,
  probe: (httpUrl: string) => Promise<RedirectChain>,
  options?: { concurrency?: number; staggerMs?: number; budgetMs?: number }
): Promise<ProbeResult[]> {
  const report = await probeHttpCoverage(urls, baseUrl, probe, options);
  return report.outcomes
    .filter((o) => o.kind === "redirects")
    .map((o) => ({ from: o.from, to: o.to, statusCode: o.statusCode, chain: o.chain }));
}

export const httpToHttpsRule: Rule = {
  meta: {
    id: "security/http-to-https",
    name: "HTTP to HTTPS Redirect",
    description: "Checks whether HTTP URLs redirect to HTTPS",
    solution:
      "Ensure all HTTP URLs redirect to their HTTPS equivalents using permanent (301) redirects. This consolidates link equity and avoids mixed indexing. Configure your server to enforce HTTPS globally and verify that both the homepage and key internal URLs redirect correctly. WARNING: This rule makes external HTTP requests to probe redirect behavior.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 3,
    // A dev server or private-network host is not the delivery edge (pub#629).
    skipOnPrivateTarget: true,
    optionsSchema,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages ?? [];

    if (!ctx.site?.baseUrl) {
      checks.push({
        name: "http-to-https",
        status: "skipped",
        message: "No base URL available",
      });
      return { checks };
    }

    let base: URL;
    try {
      base = new URL(ctx.site.baseUrl);
    } catch {
      checks.push({
        name: "http-to-https",
        status: "skipped",
        message: "Invalid base URL",
      });
      return { checks };
    }

    if (base.protocol !== "https:") {
      checks.push({
        name: "http-to-https",
        status: "skipped",
        message: "Base URL is not HTTPS",
      });
      return { checks };
    }

    // `squirrel analyze` installs no request tool: it re-reads stored data and must not touch the site.
    if (!hasRequestTool()) {
      checks.push({
        name: "http-to-https",
        status: "skipped",
        skipReason: "analyze-offline",
        message: `HTTP to HTTPS redirects not checked: ${ANALYZE_OFFLINE_REASON}`,
        value: "not-checked",
        details: { notCheckedReason: ANALYZE_OFFLINE_REASON },
      });
      return { checks };
    }

    const opts = optionsSchema.parse(ctx.options);
    const sampleUrls = new Set<string>();
    sampleUrls.add(base.toString());

    // Only sample URLs from the same domain
    for (const page of pages) {
      if (sampleUrls.size >= opts.sampleLimit) break;
      if (page.statusCode >= 400) continue;
      if (!isValidProbeTarget(page.url, ctx.site.baseUrl)) continue;
      sampleUrls.add(page.url);
    }

    const sampled = sampleUrls.size;
    const report = await probeHttpCoverage(
      Array.from(sampleUrls),
      ctx.site.baseUrl,
      (httpUrl) => followRedirects(httpUrl),
      { budgetMs: opts.probeBudgetMs }
    );

    const insecure = report.outcomes.filter((o) => o.kind === "insecure");
    const redirected = report.outcomes.filter((o) => o.kind === "redirects");
    const unverified = report.outcomes.filter((o) => o.kind === "unverified").length;
    const partial = report.notProbed > 0;
    const coverage = `${report.outcomes.length} of ${sampled} URL(s) probed`;
    const partialNote = partial
      ? `; partial coverage: the ${opts.probeBudgetMs} ms probe budget ran out, ${report.notProbed} URL(s) not probed (raise probeBudgetMs or lower sampleLimit)`
      : "";
    const details = {
      sampled,
      probed: report.outcomes.length,
      redirected: redirected.length,
      insecure: insecure.length,
      unverified,
      notProbed: report.notProbed,
      partial,
      probeBudgetMs: opts.probeBudgetMs,
    };

    if (insecure.length > 0) {
      checks.push({
        name: "http-to-https",
        status: "fail",
        message: `${insecure.length} HTTP URL(s) do not redirect to HTTPS (${coverage}${partialNote})`,
        items: insecure.map((entry) => ({
          id: entry.from,
          label: entry.statusCode
            ? `${entry.from} answered ${entry.statusCode} over HTTP without redirecting to HTTPS`
            : `${entry.from} did not redirect to HTTPS`,
          meta: { statusCode: entry.statusCode, chain: entry.chain },
        })),
        details,
      });
    } else if (partial || redirected.length === 0) {
      checks.push({
        name: "http-to-https",
        status: "info",
        message:
          redirected.length === 0 && !partial
            ? `Could not verify HTTP to HTTPS redirects (${coverage}, ${unverified} without a verdict)`
            : `No HTTP URL found without an HTTPS redirect, ${coverage}${partialNote}`,
        details,
      });
    } else {
      checks.push({
        name: "http-to-https",
        status: "pass",
        message: `${redirected.length} sampled HTTP URL(s) redirect to HTTPS`,
        details,
      });
    }

    return { checks };
  },
};
