// Resource size checker for CSS/images/sub-resources.
// Uses HEAD with Range/GET fallback to determine size and status (the image
// pool sends one ranged GET instead and reads each image's natural size from
// its first bytes, #470), captures
// compression + caching metadata (#107), and — given prior-crawl records —
// reuses fresh sub-resources without a full transfer using the SAME browser-like
// freshness logic as the page hot-path (calculateFreshness from @crawler), or a
// conditional GET (304) when only a validator is available.

import { Effect } from "effect";

import type {
  CacheHitReason,
  CachedResourceRecord,
} from "@squirrelscan/core-contracts";
import { isCacheHitReason } from "@squirrelscan/core-contracts";
import { calculateFreshness } from "@squirrelscan/crawler";
import { RESOURCE_SIZE_LIMITS, SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { isCompressibleContentType } from "@squirrelscan/utils/headers";
import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";
import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";
import type { FetchBudget, FetchOutcome } from "./fetch-budget";
import { parseImageHeader, type ImageHeaderInfo } from "./image-header";

export interface ResourceCheckResult {
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  redirectTarget: string | null;
  /**
   * content-encoding (gzip/br/deflate/zstd), or null for identity/none. (#107)
   *
   * `undefined` is a third state, not a missing field: the response was seen but
   * its encoding could NOT be established (#9 — a ranged 206 whose confirming
   * GET failed). Consumers judging compression must treat it as unknown rather
   * than as "no coding"; see perf/asset-compression.
   */
  contentEncoding: string | null | undefined;
  /**
   * Encoded body size (Content-Length) — the bytes a full GET transfers over the
   * wire for a MISS; 0 for a cache HIT (no body fetched this run). On a HEAD
   * (no body) this is still the advertised Content-Length so miss bandwidth is
   * comparable across HEAD/GET. (#107)
   */
  transferBytes: number | null;
  /** Cache-Control header verbatim. (#107) */
  cacheControl: string | null;
  /** ETag validator, if present. (#107) */
  etag: string | null;
  /** Last-Modified validator, if present. (#107) */
  lastModified: string | null;
  /** Vary header verbatim; gates cache reuse (we re-fetch when present). (#107) */
  vary: string | null;
  /** Cache-hit reason if reused from a prior crawl without a full transfer. (#107) */
  cacheReason: CacheHitReason | null;
  /**
   * The origin was throttling us (429/430, or 503 + `Retry-After`), so `status`
   * describes OUR request rate rather than the resource (#1829). Consumers that
   * grade a status — crawl/sitemap-4xx above all — must skip these rather than
   * report a live URL as 4xx.
   */
  rateLimited?: boolean;
  /**
   * Natural pixel size and animation read from the image's first bytes (#470).
   * Null when the pool does not read headers, the bytes were not a PNG, GIF,
   * WebP, AVIF or JPEG header the parser reads to its dimensions, or the read
   * failed. `animated` is also null when the bytes read do not settle it.
   */
  naturalWidth: number | null;
  naturalHeight: number | null;
  animated: boolean | null;
}

export interface ResourceCheckerOptions {
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  maxResources?: number;
  validateContentType?: boolean;
  expectedContentTypePrefix?: string;
  /**
   * Prior-crawl resource records keyed by URL — enables browser-like cache reuse
   * for sub-resources (#107). Absent → every resource is fetched fresh (a
   * first/cold audit, or caching disabled).
   */
  priorByUrl?: Map<string, CachedResourceRecord>;
  /** Hard cap on how stale an origin-fresh entry may be (seconds). Default 24h. */
  maxStalenessSeconds?: number;
  /**
   * Custom HTTP request headers attached to every asset HEAD/GET (e.g. Web Bot
   * Auth signatures), matching the page crawl. Secret values — never logged.
   */
  customHeaders?: Record<string, string>;
  /**
   * #1252: shared tarpit-aware budget. When present, a resource is skipped
   * before its fetch if the total budget is spent or its host is tarpitting, and
   * every attempt's latency/outcome is recorded so escalating-latency hosts get
   * skipped. Absent (CLI) → every resource is fetched as today.
   */
  budget?: FetchBudget;
  /**
   * #9: prove whether this pool's assets are really uncompressed. Neither cheap
   * probe is conclusive on its own — a bodiless HEAD and a ranged 206 can BOTH
   * omit Content-Encoding on a server that compresses ordinary GETs — so
   * settling it costs one extra request per compressible asset that still looks
   * uncompressed. Only the pools perf/asset-compression reads (CSS, images)
   * enable this; sitemap and PDF checks never report on compression and keep
   * the cheap HEAD path. Default off.
   */
  verifyCompression?: boolean;
  /**
   * #470: read each image's natural pixel size from its first
   * `RESOURCE_SIZE_LIMITS.IMAGE_HEADER_BYTES`. The HEAD is replaced by ONE
   * ranged GET, so the request count stays flat, and the body is read only up
   * to that cap, the rest cancelled, when a server ignores Range and sends the
   * whole file. Only the image pool sets it. Default off.
   */
  readImageHeader?: boolean;
}

const DEFAULT_OPTIONS: ResourceCheckerOptions = {
  concurrency: RESOURCE_SIZE_LIMITS.CHECK_CONCURRENCY,
  timeoutMs: RESOURCE_SIZE_LIMITS.CHECK_TIMEOUT_MS,
  userAgent: SQUIRRELSCAN_USER_AGENT,
  maxResources: RESOURCE_SIZE_LIMITS.MAX_RESOURCES_TO_CHECK,
  validateContentType: false,
};

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseContentRangeTotal(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\/(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function validateContentType(
  contentType: string | null,
  expectedPrefix: string | undefined
): boolean {
  if (!expectedPrefix || !contentType) return true;
  return contentType.toLowerCase().startsWith(expectedPrefix.toLowerCase());
}

/**
 * Normalize content-encoding to a stored value (null for identity/none). Shared
 * with the script fetcher (#9) so assets and scripts store the SAME shape.
 *
 * `null` on its own does NOT mean "observed, and not compressed": this module
 * also initializes it to null for timeouts, budget skips, and cache reuse of a
 * record written before #107 added the column. A caller judging compression must
 * check status/error/cacheReason too — see perf/asset-compression.
 */
export function normalizeEncoding(value: string | null): string | null {
  if (!value) return null;
  const enc = value.trim().toLowerCase();
  return enc && enc !== "identity" ? enc : null;
}

/**
 * Whether a prior record's Vary header forbids cache reuse. The resource checker
 * sends a fixed, minimal request context (no per-variant negotiation), so any
 * non-trivial Vary means we cannot prove this variant matches — re-fetch to be
 * safe (mirrors the page hot-path's conservative Vary keying). A bare/empty
 * Vary, or `Vary: Accept-Encoding` (transport-only, we don't key on it and
 * `*` is treated as always-forbid) is the only safe-to-ignore case; everything
 * else (incl. `*`, `User-Agent`, `Accept`, `Cookie`) blocks reuse.
 */
export function varyForbidsReuse(vary: string | null | undefined): boolean {
  if (!vary) return false;
  const fields = vary
    .toLowerCase()
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  // Only `accept-encoding` is safe to ignore (set by the runtime transport, not
  // request-content negotiation). Anything else — including `*` — blocks reuse.
  return fields.some((f) => f !== "accept-encoding");
}

// The raster types the header parser reads to a size (#470).
const HEADER_IMAGE_TYPES = [
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
];

/**
 * #470: a prior image record with no natural size, for a type the header
 * parser reads. A record written before the probe existed looks like this, and
 * reusing it (an origin-fresh hit or a 304) would carry the gap forward for as
 * long as the file is unchanged, so the image is probed again instead. SVG, ICO
 * and unlabelled files never get a size, and keep their cheap reuse.
 */
function priorLacksImageHeader(prior: CachedResourceRecord | undefined): boolean {
  if (!prior || prior.naturalWidth != null) return false;
  const type = prior.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return HEADER_IMAGE_TYPES.includes(type);
}

interface CappedBody {
  /** The first `cap` bytes, or fewer when the body was shorter or the read failed. */
  head: Uint8Array;
  /** Bytes received in all, past the cap too when `measureRest` asked for that. */
  received: number;
  /** The body ended, so `received` is its whole length. */
  complete: boolean;
}

/**
 * #470: keep a response's first `cap` bytes and stop the rest, so a server
 * that ignores Range cannot turn one header read into a whole-file download.
 * With `measureRest` the remainder is counted and dropped instead, which is
 * how {@link measureUnrangedSize} learns a size no header gives. A read that
 * fails part way, the check's own timeout included, keeps what arrived.
 *
 * Stopping takes `abort`, the request's own AbortController. Cancelling the
 * body stream is not enough: Bun's fetch keeps draining a cancelled body off
 * the socket (measured on 1.3.14: the server sent all of a 1 MB file after
 * the reader cancelled at 32 KiB), where an abort closes the connection.
 */
async function readCappedBody(
  response: Response,
  cap: number,
  measureRest: boolean,
  abort: () => void
): Promise<CappedBody> {
  const reader = response.body?.getReader();
  if (!reader) return { head: new Uint8Array(0), received: 0, complete: true };
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let received = 0;
  let complete = false;
  try {
    for (;;) {
      if (!measureRest && received >= cap) break;
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (!value) continue;
      received += value.byteLength;
      if (kept < cap) {
        const slice = value.subarray(0, cap - kept);
        chunks.push(slice);
        kept += slice.byteLength;
      }
    }
  } catch {
    // Keep what arrived; the headers already gave the status and size.
  }
  if (!complete) {
    abort();
    reader.cancel().catch(() => {});
  }
  const head = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { head, received, complete };
}

/**
 * #470: the size of a file whose ranged GET came back as a 200 with no
 * Content-Length and ran past the header cap: found the way this module always
 * has, a HEAD and then a counted read of the whole body, so the header read
 * never costs a measurement. On its own deadline, because the first request's
 * controller was aborted to stop that transfer. Rare: it takes a server that
 * both ignores Range and sends images chunked.
 */
async function measureUnrangedSize(
  url: string,
  options: ResourceCheckerOptions
): Promise<number | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
  const headers = { "User-Agent": options.userAgent, Accept: "*/*", ...options.customHeaders };
  try {
    try {
      const { response } = await safeRedirectFetch(url, {
        method: "HEAD",
        headers,
        signal: controller.signal,
      });
      const length =
        response.status < 400 ? parseHeaderInt(response.headers.get("content-length")) : null;
      if (length !== null) return length;
    } catch {
      // Fall through to the counted read, as the HEAD path above does.
    }
    const { response } = await safeRedirectFetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const declared = parseHeaderInt(response.headers.get("content-length"));
    if (!response.ok || declared !== null) {
      controller.abort();
      return response.ok ? declared : null;
    }
    const body = await readCappedBody(response, 0, true, () => controller.abort());
    return body.complete ? body.received : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * #470: a controller for ONE request, aborted with the check's own deadline.
 * Aborting is the only way to stop a Bun fetch's transfer (see
 * {@link readCappedBody}), and the image pool discards bodies it does not
 * want this way, so each of its requests needs a controller of its own: one
 * shared controller would take the next request down with the discarded one.
 */
function requestController(deadline: AbortController): AbortController {
  const request = new AbortController();
  if (deadline.signal.aborted) request.abort();
  else deadline.signal.addEventListener("abort", () => request.abort(), { once: true });
  return request;
}

/** The parser is total by test; a header it still cannot read costs the size, never the check. */
function readHeaderInfo(head: Uint8Array): ImageHeaderInfo | null {
  try {
    return parseImageHeader(head);
  } catch {
    return null;
  }
}

/**
 * Try to reuse a sub-resource from the prior crawl WITHOUT a network request,
 * honoring origin freshness (Cache-Control max-age/Expires/immutable) via the
 * SAME `calculateFreshness` used by the page hot-path. Returns a hit result or
 * null (must fetch / revalidate).
 */
function tryOriginFreshReuse(
  prior: CachedResourceRecord | undefined,
  maxStalenessSeconds: number | undefined
): ResourceCheckResult | null {
  if (!prior || !prior.cacheControl) return null;
  // Only reuse what was a real success previously.
  if (prior.status == null || prior.status >= 400) return null;
  // Never reuse a variant-keyed response — we can't prove this variant matches.
  if (varyForbidsReuse(prior.vary)) return null;
  const freshness = calculateFreshness(
    {
      cacheControl: prior.cacheControl,
      expires: null,
      age: null,
      fetchedAt: prior.fetchedAt,
    },
    maxStalenessSeconds !== undefined ? { maxStalenessSeconds } : {}
  );
  if (freshness.state !== "fresh") return null;
  // calculateFreshness only emits a FreshReason in the "fresh" state, all of
  // which are valid CacheHitReasons — but guard at runtime rather than cast, so
  // a future fresh reason that ISN'T a hit reason can't silently store an
  // invalid value (we just decline to reuse instead).
  if (!isCacheHitReason(freshness.reason)) return null;
  const reason: CacheHitReason = freshness.reason;
  return {
    url: prior.url,
    status: prior.status,
    error: null,
    contentType: prior.contentType,
    sizeBytes: prior.sizeBytes,
    redirectTarget: null,
    contentEncoding: prior.contentEncoding ?? null,
    transferBytes: 0, // served from cache — nothing transferred this run
    cacheControl: prior.cacheControl,
    etag: prior.etag ?? null,
    lastModified: prior.lastModified ?? null,
    vary: prior.vary ?? null,
    cacheReason: reason,
    naturalWidth: prior.naturalWidth ?? null,
    naturalHeight: prior.naturalHeight ?? null,
    animated: prior.animated ?? null,
  };
}

async function checkSingleResourceAsync(
  url: string,
  options: ResourceCheckerOptions,
  retryCount = 0
): Promise<ResourceCheckResult> {
  const readHeader = options.readImageHeader === true;
  const known = options.priorByUrl?.get(url);
  // #470: a prior image with no natural size is probed again rather than
  // reused, or a record from before the probe would never gain one.
  const prior = readHeader && priorLacksImageHeader(known) ? undefined : known;

  // 1. Origin-fresh reuse — no request at all (the biggest saving).
  const fresh = tryOriginFreshReuse(prior, options.maxStalenessSeconds);
  if (fresh) return fresh;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  // Mutated in place as responses arrive, so every `...defaultResult` return
  // below inherits the throttling verdict without repeating it eight times
  // (#1829). Each assignment reflects the LAST response received, which is
  // always the one whose status the result reports.
  const defaultResult: ResourceCheckResult = {
    url,
    status: null,
    error: null,
    contentType: null,
    sizeBytes: null,
    redirectTarget: null,
    contentEncoding: null,
    transferBytes: null,
    cacheControl: null,
    etag: null,
    lastModified: null,
    vary: null,
    cacheReason: null,
    naturalWidth: null,
    naturalHeight: null,
    animated: null,
  };

  // 2. Conditional-GET revalidation when only a validator is available: a 304
  //    means unchanged (a hit; body bytes saved). Only sent for resources whose
  //    prior fetch succeeded, carried an ETag / Last-Modified, and were NOT
  //    variant-keyed (Vary) — a 304 only proves the variant we'd send matches,
  //    which we can't guarantee for a Vary-keyed response.
  const conditional: Record<string, string> = {};
  if (
    prior &&
    prior.status != null &&
    prior.status < 400 &&
    !varyForbidsReuse(prior.vary)
  ) {
    if (prior.etag) conditional["If-None-Match"] = prior.etag;
    if (prior.lastModified) conditional["If-Modified-Since"] = prior.lastModified;
  }

  const extractMeta = (response: Response) => ({
    contentType: response.headers.get("content-type"),
    contentEncoding: normalizeEncoding(response.headers.get("content-encoding")),
    cacheControl: response.headers.get("cache-control"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    vary: response.headers.get("vary"),
  });

  try {
    // #470: the image pool skips the HEAD. Its ranged GET below answers the
    // size from Content-Range AND carries the header bytes, in one request.
    if (!readHeader) {
      try {
        // #1395: follow redirects manually so per hop the http/https scheme
        // allowlist applies and secret customHeaders are stripped on a cross-origin
        // redirect (native redirect:"follow" replays them to the redirect target).
        const { response: headResponse, finalUrl: headFinalUrl } = await safeRedirectFetch(url, {
          method: "HEAD",
          headers: {
            "User-Agent": options.userAgent,
            Accept: "*/*",
            ...options.customHeaders,
            ...conditional,
          },
          signal: controller.signal,
        });

        defaultResult.rateLimited =
          isRateLimitedResponse(headResponse.status, headResponse.headers.get("retry-after")) ||
          undefined;

        // 304 Not Modified → reuse prior body size (validator hit).
        if (headResponse.status === 304 && prior && prior.status != null) {
          clearTimeout(timeoutId);
          const meta = extractMeta(headResponse);
          return {
            ...defaultResult,
            status: prior.status,
            contentType: prior.contentType,
            sizeBytes: prior.sizeBytes,
            contentEncoding: prior.contentEncoding ?? null,
            transferBytes: 0,
            cacheControl: meta.cacheControl ?? prior.cacheControl ?? null,
            etag: meta.etag ?? prior.etag ?? null,
            lastModified: meta.lastModified ?? prior.lastModified ?? null,
            vary: meta.vary ?? prior.vary ?? null,
            cacheReason: "304",
            naturalWidth: prior.naturalWidth ?? null,
            naturalHeight: prior.naturalHeight ?? null,
            animated: prior.animated ?? null,
          };
        }

        const meta = extractMeta(headResponse);
        const sizeBytes = parseHeaderInt(
          headResponse.headers.get("content-length")
        );

        if (
          options.validateContentType &&
          !validateContentType(meta.contentType, options.expectedContentTypePrefix)
        ) {
          clearTimeout(timeoutId);
          return {
            ...defaultResult,
            status: headResponse.status,
            contentType: meta.contentType,
            contentEncoding: meta.contentEncoding,
            cacheControl: meta.cacheControl,
            etag: meta.etag,
            lastModified: meta.lastModified,
            vary: meta.vary,
            error: "invalid content-type",
          };
        }

        // #9: a HEAD carries no body, so a server whose compression runs as a
        // body filter (nginx's gzip module is the common one) answers it with NO
        // Content-Encoding and the UNCOMPRESSED Content-Length — indistinguishable
        // from a genuinely uncompressed asset. Absence of the header on a bodiless
        // response is not evidence of absence, so when this pool's findings depend
        // on the answer we decline the HEAD shortcut for compressible text that
        // looks uncompressed and fall through to the GET below. A HEAD that DOES
        // name a coding is positive evidence and still takes the shortcut, as does
        // any asset whose type gains nothing from compression.
        const headEncodingIsTrustworthy =
          !options.verifyCompression ||
          meta.contentEncoding !== null ||
          !isCompressibleContentType(meta.contentType);

        if (headResponse.status < 400 && sizeBytes !== null && headEncodingIsTrustworthy) {
          clearTimeout(timeoutId);
          return {
            ...defaultResult,
            status: headResponse.status,
            contentType: meta.contentType,
            sizeBytes,
            // transferBytes = the encoded body Content-Length (what a real GET
            // would transfer over the wire). The HEAD itself sends no body, but
            // this records the body size for a MISS so bandwidth metrics are
            // comparable across HEAD/GET; cache HITS set it to 0.
            transferBytes: sizeBytes,
            contentEncoding: meta.contentEncoding,
            cacheControl: meta.cacheControl,
            etag: meta.etag,
            lastModified: meta.lastModified,
            vary: meta.vary,
            redirectTarget: headFinalUrl !== url ? headFinalUrl : null,
          };
        }
      } catch {
        // HEAD failed; fall through to GET
      }
    }

    // #1395: manual redirects — scheme allowlist + strip secret customHeaders on
    // cross-origin redirects (see the HEAD path above).
    let getController = readHeader ? requestController(controller) : controller;
    let { response: getResponse, finalUrl: getFinalUrl } = await safeRedirectFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent,
        Accept: "*/*",
        Range: readHeader
          ? `bytes=0-${RESOURCE_SIZE_LIMITS.IMAGE_HEADER_BYTES - 1}`
          : "bytes=0-0",
        ...options.customHeaders,
        ...conditional,
      },
      signal: getController.signal,
    });

    // Servers that reject Range answer 416 (Range Not Satisfiable). That is a
    // Range-rejection, not the resource's real status — recording it surfaced
    // live URLs as 4xx. Retry once WITHOUT Range to capture the true status (we
    // keep the Range optimization for servers that honor it).
    if (getResponse.status === 416) {
      // Discard the rejected response body so the connection can be reused
      // instead of stalling the pool while the 416 body lingers unread. The
      // image pool aborts it instead, which also stops the transfer (#470).
      if (readHeader) getController.abort();
      getResponse.body?.cancel().catch(() => {});
      getController = readHeader ? requestController(controller) : controller;
      ({ response: getResponse, finalUrl: getFinalUrl } = await safeRedirectFetch(url, {
        method: "GET",
        headers: {
          "User-Agent": options.userAgent,
          Accept: "*/*",
          ...options.customHeaders,
          ...conditional,
        },
        signal: getController.signal,
      }));
    }

    // 304 Not Modified on the GET fallback → validator hit.
    defaultResult.rateLimited =
      isRateLimitedResponse(getResponse.status, getResponse.headers.get("retry-after")) ||
      undefined;

    if (getResponse.status === 304 && prior && prior.status != null) {
      clearTimeout(timeoutId);
      const meta = extractMeta(getResponse);
      return {
        ...defaultResult,
        status: prior.status,
        contentType: prior.contentType,
        sizeBytes: prior.sizeBytes,
        contentEncoding: prior.contentEncoding ?? null,
        transferBytes: 0,
        cacheControl: meta.cacheControl ?? prior.cacheControl ?? null,
        etag: meta.etag ?? prior.etag ?? null,
        lastModified: meta.lastModified ?? prior.lastModified ?? null,
        vary: meta.vary ?? prior.vary ?? null,
        cacheReason: "304",
        naturalWidth: prior.naturalWidth ?? null,
        naturalHeight: prior.naturalHeight ?? null,
        animated: prior.animated ?? null,
      };
    }

    const meta = extractMeta(getResponse);
    const contentRange = getResponse.headers.get("content-range");
    const sizeFromRange = parseContentRangeTotal(contentRange);
    const sizeFromLength = parseHeaderInt(
      getResponse.headers.get("content-length")
    );

    // #9: a ranged 206 is no more conclusive than the HEAD was — many origins
    // and CDNs skip compression for range requests specifically, so `Range:
    // bytes=0-0` can answer identity for an asset whose ordinary GET is gzipped.
    // One plain GET settles it; we only want its headers, so the body is
    // cancelled immediately and the size stays whatever the cheap probes found.
    let resolvedEncoding: string | null | undefined = meta.contentEncoding;
    if (
      options.verifyCompression &&
      getResponse.status === 206 &&
      meta.contentEncoding === null &&
      isCompressibleContentType(meta.contentType)
    ) {
      // The 206's own `null` is not evidence, so it cannot be the fallback: if
      // the confirmation never answers, the encoding is UNKNOWN, not absent.
      // Keeping the ranged null here would hand perf/asset-compression exactly
      // the false positive this block exists to prevent — a gzipped asset
      // reported as uncompressed — and the failure modes are ordinary: the
      // confirmation shares this check's AbortController (so a slow HEAD +
      // ranged GET can leave it no deadline), and a second immediate request
      // for the same asset is what rate-limiters answer with 429/503. `size`
      // and every other field survive; only the encoding degrades to unknown,
      // which the rule reads as "stay silent".
      resolvedEncoding = undefined;
      // Only its headers are wanted, so the image pool aborts it once they
      // arrive: a cancel alone lets the whole file download (#470).
      const confirmController = readHeader ? requestController(controller) : controller;
      try {
        const { response: confirmResponse } = await safeRedirectFetch(url, {
          method: "GET",
          headers: {
            "User-Agent": options.userAgent,
            Accept: "*/*",
            ...options.customHeaders,
          },
          signal: confirmController.signal,
        });
        if (readHeader) confirmController.abort();
        confirmResponse.body?.cancel().catch(() => {});
        if (confirmResponse.status < 400) {
          resolvedEncoding = normalizeEncoding(
            confirmResponse.headers.get("content-encoding")
          );
        }
      } catch {
        // Leave it unknown; a failed confirmation must not invent a finding,
        // and must not discard the otherwise usable size either.
      }
    }

    if (
      options.validateContentType &&
      !validateContentType(meta.contentType, options.expectedContentTypePrefix)
    ) {
      clearTimeout(timeoutId);
      return {
        ...defaultResult,
        status: getResponse.status,
        contentType: meta.contentType,
        contentEncoding: resolvedEncoding,
        cacheControl: meta.cacheControl,
        etag: meta.etag,
        lastModified: meta.lastModified,
        vary: meta.vary,
        error: "invalid content-type",
      };
    }

    if (readHeader) {
      // #470: a 206's Content-Length is the slice, never the file, so only its
      // Content-Range can give the size. Any other status means Range was not
      // applied, and Content-Length is the whole body.
      const ranged = getResponse.status === 206;
      let sizeBytes = ranged ? sizeFromRange : sizeFromLength;
      let header: ImageHeaderInfo | null = null;
      if (getResponse.ok) {
        const cap = RESOURCE_SIZE_LIMITS.IMAGE_HEADER_BYTES;
        const body = await readCappedBody(getResponse, cap, false, () => getController.abort());
        header = readHeaderInfo(body.head);
        if (sizeBytes === null && !ranged) {
          // A 200 that ended inside the cap was read whole. One that ran past
          // it is measured the old way; one cut short by the deadline is not.
          if (body.complete) sizeBytes = body.received;
          else if (body.received >= cap) sizeBytes = await measureUnrangedSize(url, options);
        }
      } else {
        // An error page is not wanted at all; abort so it cannot stream on.
        getController.abort();
        getResponse.body?.cancel().catch(() => {});
      }
      clearTimeout(timeoutId);
      return {
        ...defaultResult,
        status: getResponse.status,
        contentType: meta.contentType,
        sizeBytes,
        // What a full GET of the file would transfer, as for the HEAD path.
        transferBytes: sizeBytes,
        contentEncoding: resolvedEncoding,
        cacheControl: meta.cacheControl,
        etag: meta.etag,
        lastModified: meta.lastModified,
        vary: meta.vary,
        redirectTarget: getFinalUrl !== url ? getFinalUrl : null,
        naturalWidth: header?.width ?? null,
        naturalHeight: header?.height ?? null,
        animated: header?.animated ?? null,
      };
    }

    let sizeBytes = sizeFromRange ?? sizeFromLength;
    // transferBytes = full encoded body a MISS transfers. When the server
    // honored our Range (206 → Content-Range present), Content-Length is the
    // tiny partial (often 1), so the real full-body size is sizeFromRange; only
    // a non-ranged 200 makes Content-Length the full body.
    let transferBytes: number | null = sizeFromRange ?? sizeFromLength;
    if (sizeBytes === null && getResponse.ok) {
      const body = await getResponse.arrayBuffer();
      sizeBytes = body.byteLength;
      // Whole body read (no range honored) — transfer ≈ that.
      if (transferBytes === null) transferBytes = body.byteLength;
    }

    clearTimeout(timeoutId);
    return {
      ...defaultResult,
      status: getResponse.status,
      contentType: meta.contentType,
      sizeBytes,
      transferBytes,
      contentEncoding: resolvedEncoding,
      cacheControl: meta.cacheControl,
      etag: meta.etag,
      lastModified: meta.lastModified,
      vary: meta.vary,
      redirectTarget: getFinalUrl !== url ? getFinalUrl : null,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (
      retryCount < RESOURCE_SIZE_LIMITS.MAX_RETRIES &&
      (error as Error).name !== "AbortError"
    ) {
      const delay =
        RESOURCE_SIZE_LIMITS.RETRY_DELAY_MS * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return checkSingleResourceAsync(url, options, retryCount + 1);
    }

    if ((error as Error).name === "AbortError") {
      return { ...defaultResult, error: "timeout" };
    }
    return { ...defaultResult, error: (error as Error).message || "error" };
  }
}

/** Map a completed check to a tarpit outcome — any error (incl. timeout) strikes. */
function resourceOutcome(result: ResourceCheckResult): FetchOutcome {
  if (result.error === "timeout") return "timeout";
  if (result.error != null) return "error";
  return "ok";
}

function checkSingleResource(
  url: string,
  options: ResourceCheckerOptions
): Effect.Effect<ResourceCheckResult, never, never> {
  return Effect.promise(async () => {
    // #1252: skip before launching once the budget is spent or the host is
    // tarpitting — a fast, bounded placeholder rather than another slow fetch.
    if (options.budget?.shouldSkip(url)) {
      return {
        url,
        status: null,
        error: "skipped",
        contentType: null,
        sizeBytes: null,
        redirectTarget: null,
        contentEncoding: null,
        transferBytes: null,
        cacheControl: null,
        etag: null,
        lastModified: null,
        vary: null,
        cacheReason: null,
        naturalWidth: null,
        naturalHeight: null,
        animated: null,
      } satisfies ResourceCheckResult;
    }
    const startedAt = Date.now();
    const result = await checkSingleResourceAsync(url, options);
    options.budget?.record(url, Date.now() - startedAt, resourceOutcome(result));
    return result;
  });
}

export function checkResourceSizes(
  urls: string[],
  options?: Partial<ResourceCheckerOptions>
): Effect.Effect<ResourceCheckResult[], never, never> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.concurrency = Math.max(1, opts.concurrency);

  return Effect.gen(function* () {
    if (urls.length === 0) return [];

    const uniqueUrls = [...new Set(urls)];

    const limitedUrls =
      opts.maxResources && uniqueUrls.length > opts.maxResources
        ? uniqueUrls.slice(0, opts.maxResources)
        : uniqueUrls;

    const checks = limitedUrls.map((url) => checkSingleResource(url, opts));

    return yield* Effect.all(checks, { concurrency: opts.concurrency });
  });
}
