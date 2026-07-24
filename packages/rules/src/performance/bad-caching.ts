// performance/bad-caching - Site-wide weak-caching detection (#109)
//
// Complements the per-page perf/cache-headers and perf/compression rules by
// aggregating caching weakness ACROSS the whole site: how many crawled
// responses lack a freshness lifetime, lack a validator (ETag/Last-Modified),
// or ship a compressible body without compression. A site that gets these
// wrong on most pages pays for it on every repeat visit and behind every CDN,
// so this is a site-scope signal, not a per-page nit.

import { z } from "zod";

import {
  cacheControlLifetimeSeconds,
  parseCacheControl,
} from "@squirrelscan/utils/cache-control";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  min_freshness_ratio: z
    .number()
    .default(0.6)
    .describe(
      "Minimum fraction of pages that should declare a freshness lifetime (Cache-Control max-age or Expires) before this passes"
    ),
  min_validator_ratio: z
    .number()
    .default(0.6)
    .describe(
      "Minimum fraction of pages that should expose a validator (ETag or Last-Modified) for cheap revalidation"
    ),
  min_compression_ratio: z
    .number()
    .default(0.8)
    .describe(
      "Minimum fraction of compressible responses that should be gzip/Brotli compressed"
    ),
});

function isCompressible(contentType: string): boolean {
  return (
    contentType.includes("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/javascript") ||
    contentType.includes("application/xml") ||
    contentType.includes("+xml") ||
    contentType.includes("+json")
  );
}

export const badCachingRule: Rule = {
  meta: {
    id: "perf/bad-caching",
    name: "Weak Caching (site-wide)",
    description:
      "Flags sites where most pages lack caching freshness, validators, or compression",
    solution:
      "Set Cache-Control with an appropriate max-age on every response (short for HTML, long + immutable for hashed static assets), expose an ETag or Last-Modified for cheap revalidation, and enable gzip/Brotli for text responses. Consistent caching across the whole site cuts repeat-visit load times and origin/CDN cost.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    // Only consider successful HTML responses we actually have headers for.
    const pages = (ctx.site?.pages ?? []).filter(
      (p) =>
        p.statusCode >= 200 &&
        p.statusCode < 300 &&
        p.headers &&
        (p.headers["content-type"] ?? "").includes("text/html")
    );

    if (pages.length === 0) {
      checks.push({
        name: "bad-caching",
        status: "skipped",
        message: "No cacheable HTML responses with headers to evaluate",
        skipReason: "no_data",
      });
      return { checks };
    }

    let withFreshness = 0; // has max-age/s-maxage or Expires (and not no-store)
    let withValidator = 0; // has ETag or Last-Modified
    let compressibleTotal = 0;
    let compressibleCompressed = 0;
    const noCacheExamples: string[] = [];
    const noValidatorExamples: string[] = [];
    const uncompressedExamples: string[] = [];

    for (const page of pages) {
      const h = page.headers ?? {};
      const cacheControl = h["cache-control"];
      const expires = h["expires"];
      const etag = h["etag"];
      const lastModified = h["last-modified"];
      const contentType = h["content-type"] ?? "";
      const contentEncoding = (h["content-encoding"] ?? "").toLowerCase();

      // Shared parser (@squirrelscan/utils) keeps this rule and the crawler's
      // freshness path agreeing on what counts: no-cache/no-store never count,
      // and s-maxage takes precedence over max-age.
      const cc = parseCacheControl(cacheControl ?? null);
      const lifetime = cacheControlLifetimeSeconds(cc);
      // no-cache / no-store require revalidation before reuse → not "fresh".
      const hasFreshness =
        !cc.noStore &&
        !cc.noCache &&
        ((lifetime !== undefined && lifetime > 0) || Boolean(expires));
      if (hasFreshness) withFreshness++;
      else if (noCacheExamples.length < 5) noCacheExamples.push(page.url);

      const hasValidator = Boolean(etag || lastModified);
      if (hasValidator) withValidator++;
      else if (noValidatorExamples.length < 5) noValidatorExamples.push(page.url);

      if (isCompressible(contentType)) {
        compressibleTotal++;
        const compressed =
          contentEncoding.includes("br") ||
          contentEncoding.includes("gzip") ||
          contentEncoding.includes("deflate") ||
          contentEncoding.includes("zstd");
        if (compressed) compressibleCompressed++;
        else if (uncompressedExamples.length < 5)
          uncompressedExamples.push(page.url);
      }
    }

    const total = pages.length;
    const freshnessRatio = withFreshness / total;
    const validatorRatio = withValidator / total;
    const compressionRatio =
      compressibleTotal > 0 ? compressibleCompressed / compressibleTotal : 1;

    // --- Freshness lifetime coverage ---
    if (freshnessRatio < opts.min_freshness_ratio) {
      checks.push({
        name: "bad-caching-freshness",
        status: freshnessRatio < 0.25 ? "fail" : "warn",
        message: `${total - withFreshness}/${total} pages lack a caching freshness lifetime`,
        value: `${Math.round(freshnessRatio * 100)}%`,
        expected: `≥ ${Math.round(opts.min_freshness_ratio * 100)}% with Cache-Control max-age or Expires`,
        pages: noCacheExamples,
        details: { pagesWithFreshness: withFreshness, totalPages: total },
      });
    } else {
      checks.push({
        name: "bad-caching-freshness",
        status: "pass",
        message: `${withFreshness}/${total} pages declare a caching freshness lifetime`,
        value: `${Math.round(freshnessRatio * 100)}%`,
      });
    }

    // --- Validator coverage ---
    if (validatorRatio < opts.min_validator_ratio) {
      checks.push({
        name: "bad-caching-validators",
        status: validatorRatio < 0.25 ? "fail" : "warn",
        message: `${total - withValidator}/${total} pages lack an ETag or Last-Modified validator`,
        value: `${Math.round(validatorRatio * 100)}%`,
        expected: `≥ ${Math.round(opts.min_validator_ratio * 100)}% with ETag or Last-Modified`,
        pages: noValidatorExamples,
        details: { pagesWithValidator: withValidator, totalPages: total },
      });
    } else {
      checks.push({
        name: "bad-caching-validators",
        status: "pass",
        message: `${withValidator}/${total} pages expose a revalidation validator`,
        value: `${Math.round(validatorRatio * 100)}%`,
      });
    }

    // --- Compression coverage (compressible responses only) ---
    if (compressibleTotal > 0) {
      if (compressionRatio < opts.min_compression_ratio) {
        checks.push({
          name: "bad-caching-compression",
          status: compressionRatio < 0.5 ? "fail" : "warn",
          message: `${compressibleTotal - compressibleCompressed}/${compressibleTotal} compressible pages served without gzip/Brotli`,
          value: `${Math.round(compressionRatio * 100)}%`,
          expected: `≥ ${Math.round(opts.min_compression_ratio * 100)}% of text responses compressed`,
          pages: uncompressedExamples,
          details: {
            compressedPages: compressibleCompressed,
            compressiblePages: compressibleTotal,
          },
        });
      } else {
        checks.push({
          name: "bad-caching-compression",
          status: "pass",
          message: `${compressibleCompressed}/${compressibleTotal} compressible pages compressed`,
          value: `${Math.round(compressionRatio * 100)}%`,
        });
      }
    }

    return { checks };
  },
};
