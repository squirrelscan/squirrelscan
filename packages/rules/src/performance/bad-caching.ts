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
import { detectCdnFromHeaders } from "@squirrelscan/utils/cdn";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Cloudflare documents removing the ETag from HTML when one of these features
// rewrites the body (developers.cloudflare.com/cache/reference/etag-headers/,
// .../javascript-detections/). The rule cannot see the origin's response, so
// the note says "may": a site behind Cloudflare whose origin never sent a
// validator reads the same as one whose validator the edge removed.
function cloudflareNote(cloudflarePages: number): string {
  return (
    `. ${cloudflarePages} of them came through Cloudflare, which may drop the ETag from HTML it rewrites` +
    " with Email Address Obfuscation, Automatic HTTPS Rewrites, Replace insecure JavaScript libraries" +
    " or JavaScript Detections (Bot Fight Mode). Add no-transform to the HTML Cache-Control," +
    " turn those features off, or also send Last-Modified"
  );
}

export const optionsSchema = z.object({
  min_freshness_ratio: z
    .number()
    .default(0.6)
    .describe(
      "Minimum fraction of pages that should declare a caching policy, either a freshness lifetime (Cache-Control max-age or Expires) or a validator paired with no-cache or max-age=0, before this passes"
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

    // Reusable without asking (a freshness lifetime) or cheap to ask about
    // (a validator behind `max-age=0` / `no-cache`). Either is a policy.
    let withCachePolicy = 0;
    let withValidator = 0; // has ETag or Last-Modified
    let noValidatorViaCloudflare = 0;
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

      // Any non-empty ETag counts, weak (`W/"..."`) included: If-None-Match
      // compares weakly (RFC 9110 13.1.2), so a weak tag still earns a 304,
      // and CDNs that compress turn strong tags weak as a matter of course.
      const hasValidator = Boolean(etag || lastModified);
      if (hasValidator) withValidator++;
      else {
        if (noValidatorExamples.length < 5) noValidatorExamples.push(page.url);
        if (detectCdnFromHeaders(h) === "cloudflare") noValidatorViaCloudflare++;
      }

      // `max-age=0, must-revalidate` (or `no-cache`) WITH an ETag or a
      // Last-Modified is not a site that forgot to configure caching. It is
      // the correct policy for a document that must never be served stale:
      // the cache asks every time and gets a 304 with no body back, which is
      // what most frameworks and CDNs emit for HTML by default.
      //
      // Counting that as a failure made this the highest-failing rule in a
      // 196-site sample, failing 163 of them, which tells a reader nothing
      // they can act on (#2230). What is worth reporting is a response that
      // offers NEITHER a lifetime a cache can reuse NOR a validator it can
      // revalidate against: every request for one is a full transfer.
      const revalidates = !cc.noStore && hasValidator && (cc.noCache || lifetime === 0);
      if (hasFreshness || revalidates) withCachePolicy++;
      else if (noCacheExamples.length < 5) noCacheExamples.push(page.url);

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
    const cachePolicyRatio = withCachePolicy / total;
    const validatorRatio = withValidator / total;
    const compressionRatio =
      compressibleTotal > 0 ? compressibleCompressed / compressibleTotal : 1;

    // --- Freshness lifetime coverage ---
    if (cachePolicyRatio < opts.min_freshness_ratio) {
      checks.push({
        name: "bad-caching-freshness",
        status: cachePolicyRatio < 0.25 ? "fail" : "warn",
        message: `${total - withCachePolicy}/${total} pages set no caching policy (no freshness lifetime and no validator)`,
        value: `${Math.round(cachePolicyRatio * 100)}%`,
        expected: `≥ ${Math.round(opts.min_freshness_ratio * 100)}% with Cache-Control max-age, Expires, or a validator to revalidate against`,
        pages: noCacheExamples,
        details: { pagesWithCachePolicy: withCachePolicy, totalPages: total },
      });
    } else {
      checks.push({
        name: "bad-caching-freshness",
        status: "pass",
        message: `${withCachePolicy}/${total} pages declare a caching policy`,
        value: `${Math.round(cachePolicyRatio * 100)}%`,
      });
    }

    // --- Validator coverage ---
    // Warns, never fails (pub#600). A page with no lifetime and no validator
    // already counts against the freshness check above for the same header,
    // and a page WITH a lifetime only loses a cheap revalidation after it
    // expires. Cloudflare also removes HTML ETags through features that are
    // on by default, so a fail here lands on origins configured correctly.
    // The cap is unconditional: visitors pay the same full transfer whoever
    // removed the header, so the Cloudflare attribution below only explains,
    // it never moves the score.
    if (validatorRatio < opts.min_validator_ratio) {
      const missing = total - withValidator;
      const viaCloudflare =
        noValidatorViaCloudflare > 0 && noValidatorViaCloudflare * 2 >= missing;
      checks.push({
        name: "bad-caching-validators",
        status: "warn",
        message:
          `${missing}/${total} pages lack an ETag or Last-Modified validator` +
          (viaCloudflare ? cloudflareNote(noValidatorViaCloudflare) : ""),
        value: `${Math.round(validatorRatio * 100)}%`,
        expected: `≥ ${Math.round(opts.min_validator_ratio * 100)}% with ETag or Last-Modified`,
        pages: noValidatorExamples,
        details: {
          pagesWithValidator: withValidator,
          totalPages: total,
          ...(viaCloudflare ? { cloudflarePages: noValidatorViaCloudflare } : {}),
        },
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
