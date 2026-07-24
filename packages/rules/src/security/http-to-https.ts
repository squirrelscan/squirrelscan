// security/http-to-https - Detect HTTP to HTTPS redirects

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RedirectChain } from "@squirrelscan/core-contracts";

import { HTTP_PROBE_LIMITS } from "@squirrelscan/utils/constants";
import { followRedirects } from "../links/redirects";
import { getHostname } from "@squirrelscan/utils";

export const optionsSchema = z.object({
  sampleLimit: z
    .number()
    .int()
    .min(1)
    .max(HTTP_PROBE_LIMITS.MAX_SAMPLE_SIZE)
    .default(HTTP_PROBE_LIMITS.DEFAULT_SAMPLE_SIZE)
    .describe("Maximum number of pages to probe for HTTP→HTTPS redirects"),
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
 * Probe HTTP variants of sample urls with a bounded worker pool. The serial
 * 500ms-per-probe loop dominated the entire rules phase (~10s for 20 urls);
 * 5 workers with a 100ms intra-worker stagger keep the politeness property
 * while finishing in ~1s. Results preserve input order. Exported for tests.
 */
export async function probeHttpVariants(
  urls: string[],
  baseUrl: string,
  probe: (httpUrl: string) => Promise<RedirectChain>,
  options?: { concurrency?: number; staggerMs?: number; budgetMs?: number }
): Promise<ProbeResult[]> {
  const concurrency = Math.max(
    1,
    options?.concurrency ?? HTTP_PROBE_LIMITS.PROBE_CONCURRENCY
  );
  const staggerMs = options?.staggerMs ?? HTTP_PROBE_LIMITS.PROBE_STAGGER_MS;
  // #1252: total wall-clock budget for the whole probe. This step runs inside
  // the rules phase and re-hits the target host, so a tarpit could stretch it
  // across minutes; once the budget is spent, workers stop pulling new URLs and
  // the rule reports on whatever subset it already probed. In-flight probes are
  // separately bounded by the per-hop timeout in followRedirects.
  const budgetMs =
    options?.budgetMs && options.budgetMs > 0
      ? options.budgetMs
      : HTTP_PROBE_LIMITS.PROBE_TOTAL_BUDGET_MS;
  const deadlineAt = Date.now() + budgetMs;

  const results: Array<ProbeResult | null> = new Array(urls.length).fill(null);
  let nextIndex = 0;

  async function worker(workerIndex: number): Promise<void> {
    // Stagger worker start too — without this all workers fire their first
    // probe simultaneously, bursting the audited host with `concurrency`
    // requests at t=0.
    let first = true;
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      // Stop launching new probes once the total budget is spent (#1252).
      if (Date.now() >= deadlineAt) return;
      const startDelay = first ? workerIndex * staggerMs : staggerMs;
      if (startDelay > 0) await delay(startDelay);
      first = false;

      const url = urls[index]!;
      try {
        const httpUrl = new URL(url);
        httpUrl.protocol = "http:";

        // Double-check probe target is valid
        if (!isValidProbeTarget(httpUrl.toString(), baseUrl)) continue;

        const chain = await probe(httpUrl.toString());

        // Skip circular redirects (already detected in followRedirects)
        if (chain.isLoop) continue;

        if (chain.httpToHttps || chain.finalUrl.startsWith("https://")) {
          results[index] = {
            from: httpUrl.toString(),
            to: chain.finalUrl,
            statusCode: chain.hops[0]?.statusCode,
            chain,
          };
        }
      } catch {
        continue;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, (_, i) => worker(i))
  );

  return results.filter((r): r is ProbeResult => r !== null);
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
    severity: "warning",
    weight: 3,
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

    const redirected = await probeHttpVariants(
      Array.from(sampleUrls),
      ctx.site.baseUrl,
      followRedirects
    );

    if (redirected.length > 0) {
      checks.push({
        name: "http-to-https",
        status: "warn",
        message: `${redirected.length} HTTP URL(s) redirect to HTTPS`,
        items: redirected.map((entry) => ({
          id: entry.from,
          label: entry.statusCode
            ? `${entry.from} → ${entry.to} (${entry.statusCode})`
            : `${entry.from} → ${entry.to}`,
          meta: {
            statusCode: entry.statusCode,
            chain: entry.chain,
          },
        })),
        details: { total: redirected.length, sampled: sampleUrls.size },
      });
    } else {
      checks.push({
        name: "http-to-https",
        status: "pass",
        message: "No HTTP to HTTPS redirects detected in sample",
      });
    }

    return { checks };
  },
};
