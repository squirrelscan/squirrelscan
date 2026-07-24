// perf/ttfb - Time to First Byte measurement

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  good_threshold: z.number().default(600).describe("Good TTFB in ms"),
  poor_threshold: z.number().default(1000).describe("Poor TTFB in ms"),
});

export const ttfbRule: Rule = {
  meta: {
    id: "perf/ttfb",
    name: "Time to First Byte",
    description: "Measures server response time (TTFB)",
    solution: `Time to First Byte (TTFB) measures how quickly your server responds. Slow TTFB indicates server/backend issues.

Thresholds (Core Web Vitals):
- Good: < 600ms
- Needs improvement: 600-1000ms
- Poor: > 1000ms

Fixes for slow TTFB:
- Enable server caching (Redis, Varnish, CDN)
- Optimize database queries
- Use CDN for static assets
- Upgrade server resources
- Reduce server-side processing
- Enable HTTP/2 or HTTP/3
- Use edge computing (Cloudflare Workers, Vercel Edge)`,
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 7,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    // Only use actual TTFB - don't fall back to loadTime as it includes download time
    // which makes it misleading for TTFB measurement
    const ttfb = ctx.page.ttfb;

    if (ttfb === undefined) {
      checks.push({
        name: "ttfb",
        status: "skipped",
        message: "TTFB not measured",
        skipReason: "No TTFB timing data (only available for fresh fetches)",
      });
      return { checks };
    }

    // Round to nearest ms
    const ttfbMs = Math.round(ttfb);

    if (ttfbMs < opts.good_threshold) {
      checks.push({
        name: "ttfb",
        status: "pass",
        message: `Fast server response (${ttfbMs}ms)`,
        value: ttfbMs,
        expected: `< ${opts.good_threshold}ms`,
      });
    } else if (ttfbMs < opts.poor_threshold) {
      checks.push({
        name: "ttfb",
        status: "warn",
        message: `Slow server response (${ttfbMs}ms)`,
        value: ttfbMs,
        expected: `< ${opts.good_threshold}ms`,
      });
    } else {
      checks.push({
        name: "ttfb",
        status: "fail",
        message: `Very slow server response (${ttfbMs}ms)`,
        value: ttfbMs,
        expected: `< ${opts.poor_threshold}ms`,
      });
    }

    // Also report download time if available
    if (ctx.page.downloadTime !== undefined) {
      const downloadMs = Math.round(ctx.page.downloadTime);
      checks.push({
        name: "download-time",
        status: "info",
        message: `Content download: ${downloadMs}ms`,
        value: downloadMs,
      });
    }

    return { checks };
  },
};
