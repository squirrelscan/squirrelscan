// performance/bad-caching - Site-wide weak-caching detection (#109)
//
// Complements the per-page perf/cache-headers and perf/compression rules by
// aggregating caching weakness ACROSS the whole site: how many crawled
// responses lack a freshness lifetime, lack a validator (ETag/Last-Modified),
// or ship a compressible body without compression. A site that gets these
// wrong on most pages pays for it on every repeat visit and behind every CDN,
// so this is a site-scope signal, not a per-page nit.
//
// Freshness and compression are SCORED by the per-page rules, perf/cache-headers
// and perf/compression, which list every page and its fix. Here they are info:
// the site-wide share is still reported, but one missing server setting costs
// the score once, not once per rule (pub#633). Validators are this rule's own.

import { z } from "zod";

import {
  cacheControlLifetimeSeconds,
  parseCacheControl,
} from "@squirrelscan/utils/cache-control";
import { SUBRESOURCE_CACHING_LIMITS } from "@squirrelscan/utils/constants";
import { detectCdnFromHeaders, hasJavaScriptDetections } from "@squirrelscan/utils/cdn";

import { HEADERS_NOT_RECORDED_SKIP_REASON } from "@squirrelscan/core-contracts";

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

// Cloudflare JavaScript Detections is the one of those features that leaves a marker in the page: an
// inline script. When most of the Cloudflare pages missing a validator carry it, the note names it
// instead of listing every possibility (#605).
function jsDetectionsNote(pages: number): string {
  return (
    `. Cloudflare JavaScript Detections (turned on by Bot Fight Mode) was found on ${pages} of them, and Cloudflare` +
    " removes the ETag from HTML where it injects the script. Super Bot Fight Mode has a switch for it (Security," +
    " Bots); the free Bot Fight Mode does not, so add no-transform to the HTML Cache-Control, or also send Last-Modified"
  );
}

// The origin said so itself: `Cache-Control: no-store` forbids a cache from keeping the response, so
// a validator on it would never be used. Blaming a CDN rewrite for the missing one sends the reader
// to the wrong place (#1754).
function noStoreNote(noStorePages: number): string {
  return (
    `. ${noStorePages} of them send Cache-Control: no-store, so the origin itself told caches not to keep them` +
    " and a validator would not be used. Send an ETag or Last-Modified and use no-cache (or a short max-age)" +
    " instead of no-store if you want cheap revalidation"
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
  max_subresources: z
    .number()
    .int()
    .min(1)
    .default(SUBRESOURCE_CACHING_LIMITS.MAX_SAMPLE)
    .describe(
      "Most same-site sub-resources (CSS, scripts, fonts, images), taken in URL order, whose caching headers are judged for a freshness lifetime"
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

// Expires is a freshness lifetime only while its instant is still ahead of the
// response's own Date header (RFC 9110 5.6.7, 8.8.3), or, when Date is absent or
// unparsable, of the time the crawler fetched the page. Never the wall clock:
// re-analysing an old crawl would compare a then-future Expires against today
// and call a lifetime "none". `0`, any other unparsable value and a date at or
// before the reference mean "already expired" (RFC 9111 5.3), so not a lifetime.
// With no reference at all the answer is "unknown": Expires neither grants a
// lifetime nor, on its own, makes a page count as having no policy.
const HTTP_DATE_MONTH = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

type ExpiresVerdict = "lifetime" | "expired" | "unknown" | "absent";

function judgeExpires(
  expires: string | undefined,
  date: string | undefined,
  fetchedAt: number | undefined
): ExpiresVerdict {
  if (!expires) return "absent";
  // Every HTTP-date form names the month (RFC 9110 5.6.7). Date.parse alone is
  // too lenient: it reads `0` as the year 2000.
  const expiresAt = HTTP_DATE_MONTH.test(expires) ? Date.parse(expires) : Number.NaN;
  if (Number.isNaN(expiresAt)) return "expired";
  const parsedDate = date && HTTP_DATE_MONTH.test(date) ? Date.parse(date) : Number.NaN;
  const reference = !Number.isNaN(parsedDate)
    ? parsedDate
    : fetchedAt !== undefined && Number.isFinite(fetchedAt) && fetchedAt > 0
      ? fetchedAt
      : undefined;
  if (reference === undefined) return "unknown";
  return expiresAt > reference ? "lifetime" : "expired";
}

interface SubresourceCaching {
  url: string;
  kind: "css" | "script" | "font" | "image";
  status: number | null;
  error: string | null;
  contentType: string | null;
  sourcePages: string[];
  cacheReason?: string | null;
  headers?: {
    cacheControl: string | null;
    expires: string | null;
    date: string | null;
  };
}

// Same-site sub-resources whose caching headers were observed on THIS crawl. A record reused from a
// prior crawl without a request, an errored or non-2xx one, and one fetched without a header read
// (the CLI content store) cannot show what the server sends now, so none of them is judged. A 304
// revalidation IS a request on this crawl and carries the caching headers (RFC 9110 15.4.5), and it
// is exactly how an incremental re-audit sees an asset with a validator and no lifetime, so it is
// judged like a 200.
function observedSubresources(ctx: RuleContext): SubresourceCaching[] {
  const site = ctx.site;
  if (!site) return [];
  const sizes = site.resourceSizes;
  const fromSizes = (
    kind: SubresourceCaching["kind"],
    list: NonNullable<typeof sizes>["css"] | undefined
  ): SubresourceCaching[] =>
    (list ?? []).map((r) => ({
      url: r.url,
      kind,
      status: r.status,
      error: r.error,
      contentType: r.contentType,
      sourcePages: r.sourcePages,
      cacheReason: r.cacheReason,
      ...(r.cacheControl !== undefined
        ? {
            headers: {
              cacheControl: r.cacheControl,
              expires: r.expires ?? null,
              date: r.date ?? null,
            },
          }
        : {}),
    }));
  const scripts: SubresourceCaching[] = (site.scripts ?? []).map((r) => ({
    url: r.url,
    kind: "script",
    status: r.status,
    error: r.error,
    contentType: r.contentType,
    sourcePages: r.sourcePages,
    ...(r.cacheHeaders ? { headers: r.cacheHeaders } : {}),
  }));
  const origin = (() => {
    try {
      return new URL(site.pages[0]?.url ?? "").hostname;
    } catch {
      return undefined;
    }
  })();
  const sameSite = (url: string): boolean => {
    if (origin === undefined) return true;
    try {
      return new URL(url).hostname === origin;
    } catch {
      return false;
    }
  };
  return [
    ...fromSizes("css", sizes?.css),
    ...fromSizes("font", sizes?.fonts),
    ...fromSizes("image", sizes?.images),
    ...scripts,
  ].filter(
    (r) =>
      r.headers !== undefined &&
      r.status !== null &&
      r.status >= 200 &&
      r.status < 300 &&
      r.error === null &&
      ((r.cacheReason ?? null) === null || r.cacheReason === "304") &&
      sameSite(r.url)
  );
}

function judgeSubresources(ctx: RuleContext, maxSample: number): CheckResult | undefined {
  const sample = observedSubresources(ctx)
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .slice(0, maxSample);
  if (sample.length === 0) return undefined;

  const missing: SubresourceCaching[] = [];
  let withLifetime = 0;
  let noStore = 0;
  let unjudged = 0;
  for (const r of sample) {
    const h = r.headers!;
    const cc = parseCacheControl(h.cacheControl);
    if (cc.noStore) {
      noStore++; // a deliberate policy, not a forgotten one
      continue;
    }
    const lifetime = cacheControlLifetimeSeconds(cc);
    const verdict = judgeExpires(h.expires ?? undefined, h.date ?? undefined, ctx.site?.pages[0]?.fetchedAt);
    const fresh = !cc.noCache && ((lifetime !== undefined && lifetime > 0) || verdict === "lifetime");
    if (fresh) withLifetime++;
    else if (!cc.noCache && lifetime === undefined && verdict === "unknown") unjudged++;
    else missing.push(r);
  }

  const judged = sample.length;
  const note =
    (noStore > 0 ? `, ${noStore} send Cache-Control: no-store (deliberate)` : "") +
    (unjudged > 0 ? `, ${unjudged} send only Expires with nothing to judge it against` : "");
  if (missing.length === 0) {
    return {
      name: "bad-caching-subresources",
      status: "pass",
      message: `${withLifetime}/${judged} sampled sub-resources declare a freshness lifetime${note}`,
      details: { sampled: judged, withLifetime, maxSample },
    };
  }
  return {
    name: "bad-caching-subresources",
    status: "warn",
    message: `${missing.length}/${judged} sampled sub-resources (CSS, JS, fonts, images) have no freshness lifetime, so every repeat visit revalidates or re-downloads them${note}`,
    value: `${Math.round((withLifetime / judged) * 100)}%`,
    expected: "Cache-Control max-age (long, with immutable, for fingerprinted assets) or Expires on every static sub-resource",
    items: missing.map((r) => ({
      id: r.url,
      sourcePages: r.sourcePages,
      meta: { kind: r.kind, contentType: r.contentType ?? undefined },
    })),
    details: { sampled: judged, withLifetime, missing: missing.length, maxSample },
  };
}

// Header names are case-insensitive (RFC 9110 5.1). The engine hands rules lowercase keys, but a
// map built elsewhere (a cloud fetcher, a stored raw response) may carry `ETag` or `Cache-Control`,
// and a lookup on the lowercase name would read that as "header absent" (repo#4641).
function lowerCaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
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
    // A dev server or private-network host is not the delivery edge (pub#629).
    skipOnPrivateTarget: true,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    // A page whose record carries no response headers (headersRecorded === false) says nothing about
    // what the response sent: it is not a page "without an ETag", so it is left out and reported as
    // not checked, never counted against the site (repo#4641).
    const successful = (ctx.site?.pages ?? []).filter((p) => p.statusCode >= 200 && p.statusCode < 300);
    const unrecorded = successful.filter((p) => p.headersRecorded === false);

    // Only consider successful HTML responses we actually have headers for.
    const pages = successful
      .filter((p) => p.headersRecorded !== false && p.headers)
      .map((p) => ({ ...p, headers: lowerCaseHeaders(p.headers) }))
      .filter((p) => (p.headers["content-type"] ?? "").includes("text/html"));

    if (pages.length === 0 && unrecorded.length > 0) {
      checks.push({
        name: "bad-caching",
        status: "skipped",
        message: `Response headers were not recorded for ${unrecorded.length} page${unrecorded.length === 1 ? "" : "s"}, so caching was not checked`,
        skipReason: HEADERS_NOT_RECORDED_SKIP_REASON,
        pages: unrecorded.slice(0, 5).map((p) => p.url),
        details: { unrecordedPages: unrecorded.length },
      });
      return { checks };
    }

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
    let freshnessUnjudged = 0; // only an Expires with no reference time to judge it against
    let withValidator = 0; // has ETag or Last-Modified
    let noValidatorViaCloudflare = 0;
    let noValidatorNoStore = 0;
    let noPolicyNoStore = 0;
    let noValidatorWithJsd = 0;
    // The marker per page: the streaming engine records it with the page's other signals, the
    // resident engine reads it off the live document (#605).
    const markersByUrl = new Map((ctx.collectedSignals?.pages ?? []).map((rec) => [rec.url, rec.edgeMarkers ?? []]));
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
      const reusable = !cc.noStore && !cc.noCache;
      const expiresVerdict = judgeExpires(expires, h["date"], page.fetchedAt);
      const hasFreshness =
        reusable && ((lifetime !== undefined && lifetime > 0) || expiresVerdict === "lifetime");

      // Any non-empty ETag counts, weak (`W/"..."`) included: If-None-Match
      // compares weakly (RFC 9110 13.1.2), so a weak tag still earns a 304,
      // and CDNs that compress turn strong tags weak as a matter of course.
      const hasValidator = Boolean(etag || lastModified);
      if (hasValidator) withValidator++;
      else {
        if (noValidatorExamples.length < 5) noValidatorExamples.push(page.url);
        // no-store is the origin's own doing: the edge is not blamed for a missing validator on it.
        if (cc.noStore) noValidatorNoStore++;
        else if (detectCdnFromHeaders(h) === "cloudflare") {
          noValidatorViaCloudflare++;
          const doc = page.parsed?.document;
          const jsd = ctx.collectedSignals
            ? (markersByUrl.get(page.url) ?? []).includes("cf-jsd")
            : doc !== undefined && doc !== null && hasJavaScriptDetections(doc);
          if (jsd) noValidatorWithJsd++;
        }
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
      else if (reusable && lifetime === undefined && expiresVerdict === "unknown") {
        // Only Expires could grant a lifetime here, and with no Date header and
        // no fetch time there is nothing to measure it against: leave the page
        // out of the freshness share rather than call it "no policy".
        freshnessUnjudged++;
      } else {
        if (cc.noStore) noPolicyNoStore++;
        if (noCacheExamples.length < 5) noCacheExamples.push(page.url);
      }

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
    // Pages whose freshness could not be judged are left out of the share (see freshnessUnjudged).
    const judged = total - freshnessUnjudged;
    const cachePolicyRatio = judged > 0 ? withCachePolicy / judged : 1;
    const validatorRatio = withValidator / total;
    const compressionRatio =
      compressibleTotal > 0 ? compressibleCompressed / compressibleTotal : 1;

    const unjudgedDetails = freshnessUnjudged > 0 ? { unjudgedExpiresPages: freshnessUnjudged } : {};
    const unjudgedNote =
      freshnessUnjudged > 0
        ? ` (${freshnessUnjudged} more send only Expires with no Date or fetch time to judge it against)`
        : "";

    // --- Freshness lifetime coverage (info: perf/cache-headers scores it) ---
    if (judged === 0) {
      checks.push({
        name: "bad-caching-freshness",
        status: "info",
        message: `${total}/${total} pages send only Expires with no Date or fetch time to judge it against, so their freshness is unknown`,
        details: { totalPages: total, ...unjudgedDetails },
      });
    } else if (cachePolicyRatio < opts.min_freshness_ratio) {
      const noPolicy = judged - withCachePolicy;
      // `no-store` is a policy (never keep this), just not a reusable one: say which pages chose it
      // and which sent nothing, instead of calling both "no policy" (#1754).
      const message =
        noPolicyNoStore === 0
          ? `${noPolicy}/${judged} pages set no caching policy (no freshness lifetime and no validator)${unjudgedNote}`
          : noPolicyNoStore === noPolicy
            ? `${noPolicy}/${judged} pages send Cache-Control: no-store (a deliberate policy that forbids reuse, not a missing one)${unjudgedNote}`
            : `${noPolicy}/${judged} pages have no reusable caching policy: ${noPolicyNoStore} send Cache-Control: no-store (deliberate) and ${noPolicy - noPolicyNoStore} set no caching policy (no freshness lifetime and no validator)${unjudgedNote}`;
      checks.push({
        name: "bad-caching-freshness",
        status: "info",
        message,
        value: `${Math.round(cachePolicyRatio * 100)}%`,
        expected: `≥ ${Math.round(opts.min_freshness_ratio * 100)}% with Cache-Control max-age, Expires, or a validator to revalidate against`,
        pages: noCacheExamples,
        details: {
          pagesWithCachePolicy: withCachePolicy,
          totalPages: total,
          ...(noPolicyNoStore > 0 ? { noStorePages: noPolicyNoStore } : {}),
          ...unjudgedDetails,
        },
      });
    } else {
      checks.push({
        name: "bad-caching-freshness",
        status: "info",
        message: `${withCachePolicy}/${judged} pages declare a caching policy${unjudgedNote}`,
        value: `${Math.round(cachePolicyRatio * 100)}%`,
        ...(freshnessUnjudged > 0 ? { details: unjudgedDetails } : {}),
      });
    }

    // --- Validator coverage ---
    // Warns, never fails (pub#600). A page with no lifetime and no validator
    // is usually charged by perf/cache-headers for the same header (no
    // Cache-Control, or no-cache with nothing to revalidate against), and a
    // page WITH a lifetime only loses a cheap revalidation after it
    // expires. Cloudflare also removes HTML ETags through features that are
    // on by default, so a fail here lands on origins configured correctly.
    // The cap is unconditional: visitors pay the same full transfer whoever
    // removed the header, so the Cloudflare attribution below only explains,
    // it never moves the score.
    if (validatorRatio < opts.min_validator_ratio) {
      const missing = total - withValidator;
      const viaNoStore = noValidatorNoStore > 0 && noValidatorNoStore * 2 >= missing;
      const viaCloudflare =
        !viaNoStore &&
        noValidatorViaCloudflare > 0 && noValidatorViaCloudflare * 2 >= missing;
      const viaJsd = !viaNoStore && noValidatorWithJsd > 0 && noValidatorWithJsd * 2 >= missing;
      checks.push({
        name: "bad-caching-validators",
        status: "warn",
        message:
          `${missing}/${total} pages lack an ETag or Last-Modified validator` +
          (viaNoStore
            ? noStoreNote(noValidatorNoStore)
            : viaJsd
            ? jsDetectionsNote(noValidatorWithJsd)
            : viaCloudflare
              ? cloudflareNote(noValidatorViaCloudflare)
              : ""),
        value: `${Math.round(validatorRatio * 100)}%`,
        expected: `≥ ${Math.round(opts.min_validator_ratio * 100)}% with ETag or Last-Modified`,
        pages: noValidatorExamples,
        details: {
          pagesWithValidator: withValidator,
          totalPages: total,
          ...(noValidatorNoStore > 0 ? { noStorePages: noValidatorNoStore } : {}),
          ...(viaCloudflare ? { cloudflarePages: noValidatorViaCloudflare } : {}),
          ...(viaJsd ? { javascriptDetectionsPages: noValidatorWithJsd } : {}),
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

    // --- Compression coverage (compressible responses only; info:
    // perf/compression scores it) ---
    if (compressibleTotal > 0) {
      if (compressionRatio < opts.min_compression_ratio) {
        checks.push({
          name: "bad-caching-compression",
          status: "info",
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
          status: "info",
          message: `${compressibleCompressed}/${compressibleTotal} compressible pages compressed`,
          value: `${Math.round(compressionRatio * 100)}%`,
        });
      }
    }

    const sub = judgeSubresources(ctx, opts.max_subresources);
    if (sub) checks.push(sub);

    // Some pages had no recorded headers: the shares above cover only the rest. Say so, as a
    // not-checked line, so a partial record never reads as a clean site (repo#4641).
    if (unrecorded.length > 0) {
      checks.push({
        name: "bad-caching-headers-not-recorded",
        status: "skipped",
        message: `Response headers were not recorded for ${unrecorded.length} page${unrecorded.length === 1 ? "" : "s"}, so they are left out of the shares above`,
        skipReason: HEADERS_NOT_RECORDED_SKIP_REASON,
        pages: unrecorded.slice(0, 5).map((p) => p.url),
        details: { unrecordedPages: unrecorded.length },
      });
    }

    return { checks };
  },
};
