// Change detection for incremental crawling
// Uses ETag, Last-Modified, and content hash to detect changes

import { createHash } from "crypto";

import {
  type CacheControl,
  cacheControlLifetimeSeconds,
  expiresLifetimeSeconds,
  parseCacheControl,
} from "@squirrelscan/utils/cache-control";

// Re-export the shared Cache-Control parser so existing consumers that import
// it from this module (or via @squirrelscan/crawler) keep working.
export { type CacheControl, parseCacheControl };

// ============================================
// TYPES
// ============================================

/**
 * Change detection metadata stored per page
 */
export interface ChangeDetectionMeta {
  /** ETag header value */
  etag: string | null;
  /** Last-Modified header value */
  lastModified: string | null;
  /** SHA-256 hash of the response body */
  contentHash: string;
}

/**
 * Conditional request headers for incremental crawling
 */
export interface ConditionalHeaders {
  "If-None-Match"?: string;
  "If-Modified-Since"?: string;
}

/**
 * Result of comparing change detection metadata
 */
export type ChangeStatus =
  | { changed: false; reason: "etag_match" | "lastmod_match" | "hash_match" }
  | {
      changed: true;
      reason:
        | "new_page"
        | "etag_mismatch"
        | "lastmod_mismatch"
        | "hash_mismatch";
    };

// ============================================
// CONTENT HASH
// ============================================

/**
 * Compute SHA-256 hash of content
 */
export function computeContentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute a normalized content hash that ignores whitespace variations
 * Useful for detecting meaningful content changes vs formatting changes
 */
export function computeNormalizedContentHash(html: string): string {
  // Normalize whitespace
  const normalized = html.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();

  return computeContentHash(normalized);
}

// ============================================
// CONDITIONAL HEADERS
// ============================================

/**
 * Build conditional headers for an incremental fetch request
 * These headers tell the server to return 304 Not Modified if content hasn't changed
 */
export function buildConditionalHeaders(
  prev: ChangeDetectionMeta | null
): ConditionalHeaders {
  if (!prev) return {};

  const headers: ConditionalHeaders = {};

  // Prefer ETag over Last-Modified (more precise)
  if (prev.etag) {
    headers["If-None-Match"] = prev.etag;
  }

  if (prev.lastModified) {
    headers["If-Modified-Since"] = prev.lastModified;
  }

  return headers;
}

/**
 * Check if we have any conditional headers to send
 */
export function hasConditionalHeaders(headers: ConditionalHeaders): boolean {
  return !!(headers["If-None-Match"] || headers["If-Modified-Since"]);
}

// ============================================
// CHANGE DETECTION EXTRACTION
// ============================================

/**
 * Extract change detection metadata from response headers and body
 */
export function extractChangeDetection(
  headers: Headers | Record<string, string>,
  body: string
): ChangeDetectionMeta {
  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  };

  return {
    etag: getHeader("etag"),
    lastModified: getHeader("last-modified"),
    contentHash: computeContentHash(body),
  };
}

/**
 * Extract change detection metadata with normalized hash
 * Use this for HTML content to ignore whitespace changes
 */
export function extractChangeDetectionNormalized(
  headers: Headers | Record<string, string>,
  html: string
): ChangeDetectionMeta {
  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  };

  return {
    etag: getHeader("etag"),
    lastModified: getHeader("last-modified"),
    contentHash: computeNormalizedContentHash(html),
  };
}

// ============================================
// CHANGE COMPARISON
// ============================================

/**
 * Compare previous and current change detection metadata
 * Returns whether content has changed and why
 */
export function compareChangeDetection(
  prev: ChangeDetectionMeta | null,
  current: ChangeDetectionMeta
): ChangeStatus {
  // No previous data = new page
  if (!prev) {
    return { changed: true, reason: "new_page" };
  }

  // Compare ETags if both present
  if (prev.etag && current.etag) {
    if (prev.etag === current.etag) {
      return { changed: false, reason: "etag_match" };
    }
    // ETags don't match - content changed
    return { changed: true, reason: "etag_mismatch" };
  }

  // Compare Last-Modified if both present and no ETags
  if (prev.lastModified && current.lastModified) {
    const prevDate = new Date(prev.lastModified).getTime();
    const currentDate = new Date(current.lastModified).getTime();

    if (!isNaN(prevDate) && !isNaN(currentDate)) {
      if (currentDate <= prevDate) {
        return { changed: false, reason: "lastmod_match" };
      }
      // Last-Modified is newer - content changed
      return { changed: true, reason: "lastmod_mismatch" };
    }
  }

  // Fall back to content hash comparison
  if (prev.contentHash === current.contentHash) {
    return { changed: false, reason: "hash_match" };
  }

  return { changed: true, reason: "hash_mismatch" };
}

/**
 * Check if content has changed (simple boolean)
 */
export function hasContentChanged(
  prev: ChangeDetectionMeta | null,
  current: ChangeDetectionMeta
): boolean {
  return compareChangeDetection(prev, current).changed;
}

// ============================================
// 304 RESPONSE HANDLING
// ============================================

/**
 * Check if a response status indicates "not modified"
 */
export function isNotModifiedResponse(status: number): boolean {
  return status === 304;
}

/**
 * Determine if we should skip re-parsing for a 304 response
 */
export function shouldSkipParsing(
  status: number,
  prev: ChangeDetectionMeta | null
): boolean {
  // 304 means server says content hasn't changed
  if (status === 304 && prev) {
    return true;
  }
  return false;
}

// ============================================
// CACHE HEADERS (browser-like freshness — RFC 9111)
// ============================================
//
// Cache-Control parsing lives in @squirrelscan/utils/cache-control (shared with
// the perf/bad-caching rule); calculateFreshness below builds on it.

/**
 * Metadata needed to decide whether a cached entry is still usable without a
 * network request. Mirrors the response headers a browser cache would key on.
 */
export interface FreshnessInput {
  cacheControl: string | null;
  /** Expires header (legacy fallback when no max-age) */
  expires: string | null;
  /** Age header from the original response (seconds) */
  age: string | number | null;
  /** When we last stored this entry (epoch ms) */
  fetchedAt: number;
}

export type FreshnessState =
  /** Usable as-is — no request needed */
  | "fresh"
  /**
   * Stale but within the stale-while-revalidate window — serve immediately
   * without blocking. NOTE: the background revalidation is not yet implemented;
   * the crawler serves the stale copy and lets the NEXT audit revalidate it via
   * conditional GET (writing a background refresh into the current crawl would
   * corrupt its report row). So this is "serve stale, no request now".
   */
  | "revalidate"
  /** Must revalidate before use (conditional GET) */
  | "stale";

/** Reasons a cached entry can be reused without a request (state === "fresh"). */
export type FreshReason = "max-age" | "s-maxage" | "expires" | "immutable";

export type FreshnessReason =
  | FreshReason
  | "stale-while-revalidate"
  | "no-cache-directive"
  | "no-cache-header"
  | "expired"
  | "stale"
  | "staleness-cap";

export interface FreshnessResult {
  state: FreshnessState;
  reason: FreshnessReason;
  /** Effective freshness lifetime in seconds (max-age/s-maxage/Expires), if known */
  lifetimeSeconds?: number;
  /** Current age of the entry in seconds (response Age + time since stored) */
  ageSeconds: number;
}

export interface FreshnessOptions {
  /**
   * Hard cap on how stale a "fresh" entry may be regardless of what the origin
   * declared (seconds). Protects against absurd max-age values (e.g. 10 years)
   * silently skipping requests for a whole audit. Default: 24h.
   */
  maxStalenessSeconds?: number;
  /** Clock injection for tests */
  now?: number;
}

const DEFAULT_MAX_STALENESS_SECONDS = 24 * 60 * 60;

/**
 * Decide whether a cached response may be reused without hitting the network,
 * emulating a browser cache (RFC 9111 §4.2). Conservative by design: any
 * directive that forbids reuse, or an entry whose effective freshness exceeds
 * the staleness cap, returns "stale" so the normal conditional-GET path runs.
 */
export function calculateFreshness(
  input: FreshnessInput,
  options: FreshnessOptions = {}
): FreshnessResult {
  const now = options.now ?? Date.now();
  const maxStaleness = options.maxStalenessSeconds ?? DEFAULT_MAX_STALENESS_SECONDS;

  const responseAge =
    typeof input.age === "number"
      ? input.age
      : input.age
        ? Math.max(0, Number.parseInt(input.age, 10) || 0)
        : 0;
  const localAge = Math.max(0, (now - input.fetchedAt) / 1000);
  const ageSeconds = responseAge + localAge;

  const cc = parseCacheControl(input.cacheControl);

  // no-store / no-cache always require revalidation before reuse.
  if (cc.noStore || cc.noCache) {
    return { state: "stale", reason: "no-cache-directive", ageSeconds };
  }

  // immutable: reusable within its declared lifetime without revalidation. We
  // still honor the staleness cap to bound how long a single audit trusts it.
  // s-maxage (shared cache) takes precedence over max-age, then max-age, then
  // Expires.
  const lifetime =
    cacheControlLifetimeSeconds(cc) ??
    expiresLifetimeSeconds(input.expires, input.fetchedAt);

  if (lifetime === undefined) {
    // No usable freshness information — must revalidate.
    return { state: "stale", reason: "no-cache-header", ageSeconds };
  }

  const reason: FreshnessReason = cc.immutable
    ? "immutable"
    : cc.sMaxAge !== undefined
      ? "s-maxage"
      : cc.maxAge !== undefined
        ? "max-age"
        : "expires";

  // Within freshness lifetime → fresh, but never beyond the staleness cap.
  if (ageSeconds < lifetime) {
    if (ageSeconds > maxStaleness) {
      return { state: "stale", reason: "staleness-cap", lifetimeSeconds: lifetime, ageSeconds };
    }
    return { state: "fresh", reason, lifetimeSeconds: lifetime, ageSeconds };
  }

  // Stale. If within the stale-while-revalidate window, the entry may be served
  // immediately while a background revalidation refreshes it.
  if (cc.staleWhileRevalidate !== undefined && !cc.mustRevalidate) {
    const staleness = ageSeconds - lifetime;
    if (staleness < cc.staleWhileRevalidate && ageSeconds <= maxStaleness) {
      return {
        state: "revalidate",
        reason: "stale-while-revalidate",
        lifetimeSeconds: lifetime,
        ageSeconds,
      };
    }
  }

  return {
    state: "stale",
    reason: lifetime === 0 ? "expired" : "stale",
    lifetimeSeconds: lifetime,
    ageSeconds,
  };
}

/**
 * Legacy helper retained for callers that only need a boolean freshness check.
 * Prefer {@link calculateFreshness}.
 */
export function isCacheFresh(
  fetchedAt: number,
  cacheControl: string | null,
  now: number = Date.now()
): boolean {
  return (
    calculateFreshness(
      { cacheControl, expires: null, age: null, fetchedAt },
      { now }
    ).state === "fresh"
  );
}

// ============================================
// VARY KEYING
// ============================================

/**
 * Headers a browser would vary the cache on. We only send a stable, small set
 * of request headers, so we key on the lowercase header names listed in Vary.
 * `*` means the response is uncacheable across requests — never reuse.
 */
export function parseVary(vary: string | null): string[] | "*" {
  if (!vary) return [];
  const fields = vary
    .toLowerCase()
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  // `*` anywhere in the field list makes the response uncacheable across
  // requests (e.g. `Vary: Accept-Encoding, *`), not just a bare `Vary: *`.
  if (fields.includes("*")) return "*";
  return fields;
}

/**
 * Check whether a cached entry's Vary constraints are satisfied by the current
 * request headers. Returns false (cache miss) on any mismatch or `Vary: *`.
 *
 * @param vary           the stored response's Vary header
 * @param storedRequest  request headers sent when the entry was cached
 * @param currentRequest request headers for the current fetch
 */
export function varyMatches(
  vary: string | null,
  storedRequest: Record<string, string> | null,
  currentRequest: Record<string, string>
): boolean {
  const fields = parseVary(vary);
  if (fields === "*") return false;
  if (fields.length === 0) return true;

  const lower = (h: Record<string, string> | null): Record<string, string> => {
    const out: Record<string, string> = {};
    if (h) for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
    return out;
  };
  const stored = lower(storedRequest);
  const current = lower(currentRequest);

  for (const field of fields) {
    if ((stored[field] ?? "") !== (current[field] ?? "")) return false;
  }
  return true;
}

// ============================================
// UTILITY EXPORTS
// ============================================

export const changeDetection = {
  computeContentHash,
  computeNormalizedContentHash,
  buildConditionalHeaders,
  hasConditionalHeaders,
  extractChangeDetection,
  extractChangeDetectionNormalized,
  compareChangeDetection,
  hasContentChanged,
  isNotModifiedResponse,
  shouldSkipParsing,
  parseCacheControl,
  calculateFreshness,
  isCacheFresh,
  parseVary,
  varyMatches,
} as const;
