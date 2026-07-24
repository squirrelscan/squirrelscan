// Resource size checker for CSS/images/sub-resources.
// Uses HEAD with Range/GET fallback to determine size and status, captures
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
import type { FetchBudget, FetchOutcome } from "./fetch-budget";

export interface ResourceCheckResult {
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  redirectTarget: string | null;
  /** content-encoding (gzip/br/deflate/zstd) or null for identity. (#107) */
  contentEncoding: string | null;
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

/** Normalize content-encoding to a stored value (null for identity/none). */
function normalizeEncoding(value: string | null): string | null {
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
  };
}

async function checkSingleResourceAsync(
  url: string,
  options: ResourceCheckerOptions,
  retryCount = 0
): Promise<ResourceCheckResult> {
  const prior = options.priorByUrl?.get(url);

  // 1. Origin-fresh reuse — no request at all (the biggest saving).
  const fresh = tryOriginFreshReuse(prior, options.maxStalenessSeconds);
  if (fresh) return fresh;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

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
    try {
      const headResponse = await fetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent": options.userAgent,
          Accept: "*/*",
          ...options.customHeaders,
          ...conditional,
        },
        signal: controller.signal,
        redirect: "follow",
      });

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

      if (headResponse.status < 400 && sizeBytes !== null) {
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
          redirectTarget: headResponse.url !== url ? headResponse.url : null,
        };
      }
    } catch {
      // HEAD failed; fall through to GET
    }

    let getResponse = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent,
        Accept: "*/*",
        Range: "bytes=0-0",
        ...options.customHeaders,
        ...conditional,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    // Servers that reject Range answer 416 (Range Not Satisfiable). That is a
    // Range-rejection, not the resource's real status — recording it surfaced
    // live URLs as 4xx. Retry once WITHOUT Range to capture the true status (we
    // keep the Range optimization for servers that honor it).
    if (getResponse.status === 416) {
      // Discard the rejected response body so the connection can be reused
      // instead of stalling the pool while the 416 body lingers unread.
      getResponse.body?.cancel();
      getResponse = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": options.userAgent,
          Accept: "*/*",
          ...options.customHeaders,
          ...conditional,
        },
        signal: controller.signal,
        redirect: "follow",
      });
    }

    // 304 Not Modified on the GET fallback → validator hit.
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
      };
    }

    const meta = extractMeta(getResponse);
    const contentRange = getResponse.headers.get("content-range");
    const sizeFromRange = parseContentRangeTotal(contentRange);
    const sizeFromLength = parseHeaderInt(
      getResponse.headers.get("content-length")
    );

    if (
      options.validateContentType &&
      !validateContentType(meta.contentType, options.expectedContentTypePrefix)
    ) {
      clearTimeout(timeoutId);
      return {
        ...defaultResult,
        status: getResponse.status,
        contentType: meta.contentType,
        contentEncoding: meta.contentEncoding,
        cacheControl: meta.cacheControl,
        etag: meta.etag,
        lastModified: meta.lastModified,
        vary: meta.vary,
        error: "invalid content-type",
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
      contentEncoding: meta.contentEncoding,
      cacheControl: meta.cacheControl,
      etag: meta.etag,
      lastModified: meta.lastModified,
      vary: meta.vary,
      redirectTarget: getResponse.url !== url ? getResponse.url : null,
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
