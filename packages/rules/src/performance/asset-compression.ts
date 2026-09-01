// perf/asset-compression - Uncompressed text sub-resources (#9)
//
// perf/compression judges the HTML DOCUMENT's own response. This rule judges the
// crawled SUB-RESOURCES: a big CSS/JS/SVG file shipped without gzip/Brotli costs
// every visitor the full uncompressed transfer even when the HTML around it is
// compressed, and neither perf/css-file-size nor perf/js-file-size looks at
// content-encoding at all. Site-scope because sub-resources are shared across
// pages — reporting them per page would repeat one asset N times.

import { z } from "zod";

import { ASSET_COMPRESSION_LIMITS } from "@squirrelscan/utils/constants";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  min_bytes: z
    .number()
    .default(ASSET_COMPRESSION_LIMITS.MIN_BYTES)
    .describe("Only report uncompressed assets larger than this many bytes"),
});

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Whether this media type gets a real win from a transfer coding. Classified by
 * content-type rather than by which crawl pool the asset came from, so an SVG
 * discovered as an <img> is judged as the XML text it is, while a PNG/JPEG/WebP
 * in that same pool (already entropy-coded) is left alone.
 */
function isCompressibleType(contentType: string | null): boolean {
  if (!contentType) return false;
  const t = contentType.toLowerCase();
  return (
    t.includes("text/") ||
    t.includes("application/json") ||
    t.includes("application/javascript") ||
    t.includes("application/xml") ||
    t.includes("+xml") ||
    t.includes("+json")
  );
}

/**
 * `content-encoding` is a three-state signal here, and conflating the last two
 * is how this rule would earn a reputation for lying:
 *   - a coding string  → compressed, nothing to report
 *   - `null`           → observed on a live response, and there was none
 *   - `undefined`      → never observed (the CLI's script content-store cache,
 *                        or a resource record written before #107 added the
 *                        column) — unknown, so stay silent
 */
function isKnownUncompressed(encoding: string | null | undefined): boolean {
  if (encoding === undefined) return false;
  if (encoding === null) return true;
  // ANY declared coding counts as compressed, rather than matching against a
  // list of codings we know. An allowlist would report `zstd`, `dcb`/`dcz`
  // (shared-dictionary), or anything else newer than this file as
  // "uncompressed" — exactly the false positive this rule must not produce.
  // `identity` is the one value that explicitly means no coding, and
  // perf/compression already treats it as compression deliberately disabled.
  const enc = encoding.trim().toLowerCase();
  return enc === "" || enc === "identity";
}

interface Candidate {
  url: string;
  status: number | null;
  contentType: string | null;
  sizeBytes: number | null;
  contentEncoding?: string | null;
  sourcePages: string[];
  /** Set only on sub-resources reused from a prior crawl without a real fetch. */
  cacheReason?: string | null;
}

export const assetCompressionRule: Rule = {
  meta: {
    id: "perf/asset-compression",
    name: "Uncompressed Assets",
    description:
      "Checks for large CSS, JavaScript, and other text assets served without gzip or Brotli",
    solution:
      "Enable gzip or Brotli for static text assets, not just HTML. Server config often compresses text/html but omits text/css and application/javascript: add those MIME types to your compression list (nginx 'gzip_types', Apache 'AddOutputFilterByType'). On a CDN, check that compression is on for static file extensions. Brotli beats gzip on text and every current browser accepts it.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    // Every pool the crawler exposes that can hold text. `images` is included
    // deliberately — SVG lands there — and filtered by content-type below.
    // JSON/XML fetched on their own are not crawled as sub-resources today, so
    // they only appear here when served under one of these pools' URLs.
    const candidates: Candidate[] = [
      ...(ctx.site?.resourceSizes?.css ?? []),
      ...(ctx.site?.resourceSizes?.images ?? []),
      ...(ctx.site?.scripts ?? []),
    ];

    if (candidates.length === 0) {
      checks.push({
        name: "asset-compression",
        status: "skipped",
        message: "No sub-resources were crawled",
        skipReason: "no_data",
      });
      return { checks };
    }

    // Only responses whose encoding we can actually vouch for this run. A
    // cache-reused record (cacheReason set) carries the PRIOR crawl's headers,
    // and for a record written before #107 that prior encoding is an un-backed
    // null — reporting on it would invent findings the current server never
    // justified. An `undefined` encoding is likewise unjudgeable. Excluding
    // both here (rather than only at the report step) keeps the pass message
    // honest: it counts assets we genuinely checked.
    const observed = candidates.filter(
      (c) =>
        c.status !== null &&
        c.status >= 200 &&
        c.status < 300 &&
        (c.cacheReason ?? null) === null &&
        c.contentEncoding !== undefined &&
        isCompressibleType(c.contentType)
    );

    if (observed.length === 0) {
      checks.push({
        name: "asset-compression",
        status: "skipped",
        message: "No compressible text assets with observed response headers",
        skipReason: "no_data",
      });
      return { checks };
    }

    const uncompressed = observed.filter(
      (c) =>
        isKnownUncompressed(c.contentEncoding) &&
        c.sizeBytes !== null &&
        c.sizeBytes > opts.min_bytes
    );

    if (uncompressed.length === 0) {
      checks.push({
        name: "asset-compression",
        status: "pass",
        message: `All ${observed.length} compressible asset(s) are compressed or under ${formatBytes(opts.min_bytes)}`,
      });
      return { checks };
    }

    // Biggest first: the top of the list is where the bandwidth actually is.
    const sorted = [...uncompressed].sort(
      (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
    );
    const wastedBytes = sorted.reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0);

    checks.push({
      name: "asset-compression",
      status: "warn",
      message: `${sorted.length} text asset(s) over ${formatBytes(opts.min_bytes)} served without compression`,
      expected: "gzip, Brotli, or zstd on every large text asset",
      items: sorted.map((c) => ({
        id: c.url,
        sourcePages: c.sourcePages,
        meta: {
          sizeBytes: c.sizeBytes,
          size: formatBytes(c.sizeBytes ?? 0),
          contentType: c.contentType ?? undefined,
        },
      })),
      details: {
        thresholdBytes: opts.min_bytes,
        total: sorted.length,
        compressibleAssets: observed.length,
        uncompressedBytes: wastedBytes,
        // Text typically compresses ~70%, the same ratio perf/compression
        // quotes for the HTML document.
        estimatedSavings: formatBytes(Math.round(wastedBytes * 0.7)),
      },
    });

    return { checks };
  },
};
