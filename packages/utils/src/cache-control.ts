// Dependency-free Cache-Control parsing + freshness lifetime calc (RFC 9111).
//
// Single source of truth shared by the crawler's incremental-freshness path
// (@squirrelscan/crawler, incremental.ts) and the perf/bad-caching rule
// (@squirrelscan/rules). Both need to agree on what "has a freshness lifetime"
// means — no-cache/no-store never count, and s-maxage (shared-cache override)
// takes precedence over max-age. Keeping it here avoids @rules depending on the
// crawler package (bun:sqlite/effect) and prevents the two copies from drifting.
//
// MUST stay dependency-free: @squirrelscan/utils gains no runtime deps from this.

/**
 * Parsed Cache-Control directives relevant to freshness decisions.
 */
export interface CacheControl {
  /** max-age in seconds (origin freshness lifetime), if present */
  maxAge?: number;
  /** s-maxage in seconds (shared-cache override of max-age), if present */
  sMaxAge?: number;
  /** stale-while-revalidate window in seconds, if present */
  staleWhileRevalidate?: number;
  noCache: boolean;
  noStore: boolean;
  /** must-revalidate / proxy-revalidate: stale responses must not be served */
  mustRevalidate: boolean;
  /** immutable directive: content never changes within its freshness lifetime */
  immutable: boolean;
}

/**
 * Parse a Cache-Control header into the directives that matter for freshness.
 * Tolerant of quoting/whitespace; unknown directives are ignored. Negative or
 * non-numeric max-age/s-maxage/stale-while-revalidate values are treated as
 * absent (undefined).
 */
export function parseCacheControl(cacheControl: string | null): CacheControl {
  const result: CacheControl = {
    noCache: false,
    noStore: false,
    mustRevalidate: false,
    immutable: false,
  };
  if (!cacheControl) return result;

  const directives = cacheControl
    .toLowerCase()
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  const numeric = (directive: string, prefix: string): number | undefined => {
    if (!directive.startsWith(prefix)) return undefined;
    // Value may be quoted, e.g. max-age="600".
    const raw = directive.slice(prefix.length).replace(/^"|"$/g, "");
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) || value < 0 ? undefined : value;
  };

  for (const directive of directives) {
    if (directive === "no-cache") result.noCache = true;
    else if (directive === "no-store") result.noStore = true;
    else if (directive === "must-revalidate" || directive === "proxy-revalidate")
      result.mustRevalidate = true;
    else if (directive === "immutable") result.immutable = true;
    else {
      const maxAge = numeric(directive, "max-age=");
      if (maxAge !== undefined) result.maxAge = maxAge;
      const sMaxAge = numeric(directive, "s-maxage=");
      if (sMaxAge !== undefined) result.sMaxAge = sMaxAge;
      const swr = numeric(directive, "stale-while-revalidate=");
      if (swr !== undefined) result.staleWhileRevalidate = swr;
    }
  }

  return result;
}

/**
 * Effective Cache-Control freshness lifetime in seconds: s-maxage (shared-cache
 * override) if present, else max-age. Returns undefined when neither is set.
 * Note: this is the Cache-Control lifetime only — callers that also honor the
 * legacy Expires header should fall back to {@link expiresLifetimeSeconds}.
 */
export function cacheControlLifetimeSeconds(cc: CacheControl): number | undefined {
  return cc.sMaxAge ?? cc.maxAge;
}

/**
 * Convert an Expires header into a freshness lifetime relative to fetchedAt
 * (epoch ms). Returns undefined when the header is missing or unparseable.
 * Lifetime = how long from when the entry was stored until the declared expiry,
 * clamped at 0 (an already-past Expires yields a 0s lifetime, not negative).
 */
export function expiresLifetimeSeconds(
  expires: string | null,
  fetchedAt: number
): number | undefined {
  if (!expires) return undefined;
  const expiresMs = new Date(expires).getTime();
  if (Number.isNaN(expiresMs)) return undefined;
  return Math.max(0, (expiresMs - fetchedAt) / 1000);
}
