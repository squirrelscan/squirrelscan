/**
 * What a page record looks like once a request THIS crawl made has revalidated
 * a stored copy (repo#4765).
 *
 * A 304 or a hash match proves the BODY unchanged, nothing more. The headers
 * the origin sent with it can change on their own: a site that drops an
 * `X-Robots-Tag: noindex`, or adds HSTS, without touching its HTML. Reusing the
 * stored record whole kept the old headers, so the audit reported a header the
 * latest response did not carry, as a fresh finding.
 *
 * The body, its parse and its links come from the stored copy; everything the
 * response itself says comes from the response.
 */
import type { FetchResult } from "../fetcher";
import { contentTypeCharset } from "../fetcher";
import type { PageRecord, ResponseHeaders, SecurityHeaders } from "../storage/types";

/** The page's response headers as the crawler stores them, read off one fetch. */
export function pageHeadersFromResponse(
  result: FetchResult,
  lastModified: string | null,
): ResponseHeaders {
  return {
    contentType: result.contentType,
    // `contentType` is the media type only; the charset rides beside it
    // so core/charset sees a header-only declaration (pub#674).
    contentTypeCharset: contentTypeCharset(result.headers.contentType),
    contentEncoding: result.headers.contentEncoding ?? null,
    cacheControl: result.headers.cacheControl ?? null,
    expires: result.headers.expires ?? null,
    vary: result.headers.vary ?? null,
    etag: result.headers.etag ?? null,
    server: result.headers.server ?? null,
    lastModified,
    link: result.headers.link ?? null,
    serverTiming: result.headers.serverTiming ?? null,
    age: result.headers.age ?? null,
    xCache: result.headers.xCache ?? null,
    cfCacheStatus: result.headers.cfCacheStatus ?? null,
    xVercelCache: result.headers.xVercelCache ?? null,
    altSvc: result.headers.altSvc ?? null,
    acceptRanges: result.headers.acceptRanges ?? null,
    // security/version-disclosure rule (#713).
    xPoweredBy: result.headers.xPoweredBy ?? null,
    xAspNetVersion: result.headers.xAspNetVersion ?? null,
    xAspNetMvcVersion: result.headers.xAspNetMvcVersion ?? null,
    xGenerator: result.headers.xGenerator ?? null,
    // security/cookie-flags rule (#748).
    setCookie: result.headers.setCookie ?? null,
    // Technology detection in a local audit (pub#871).
    techHeaders: result.headers.techHeaders ?? null,
  };
}

/** The page's security headers as the crawler stores them, read off one fetch. */
export function securityHeadersFromResponse(result: FetchResult): SecurityHeaders {
  return {
    hsts: result.securityHeaders.hsts ?? null,
    csp: result.securityHeaders.csp ?? null,
    xFrameOptions: result.securityHeaders.xFrameOptions ?? null,
    xContentTypeOptions: result.securityHeaders.xContentTypeOptions ?? null,
    referrerPolicy: result.securityHeaders.referrerPolicy ?? null,
    permissionsPolicy: result.securityHeaders.permissionsPolicy ?? null,
    xRobotsTag: result.securityHeaders.xRobotsTag ?? null,
  };
}

/**
 * Fields of `fresh` that carry a value replace the stored ones; the rest keep
 * the stored value. How a cache updates a stored response from a real 304
 * (RFC 9111 §4.3.4): a 304 need only resend some headers, so a header it omits
 * says nothing about whether the origin still sends it.
 */
function overlaySent<T extends object>(stored: T, fresh: T): T {
  const out = { ...stored } as Record<string, unknown>;
  for (const [key, value] of Object.entries(fresh)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as T;
}

export interface RevalidationInput {
  /** The response that revalidated the stored copy. */
  result: FetchResult;
  /**
   * True when `result` carries the page's full header set: a 200 whose body
   * matched the stored one, or a 304 the conditional-render gate synthesized
   * from such a 200. Its headers then REPLACE the stored ones, so a header the
   * origin stopped sending is gone. False for an origin's own 304, whose
   * headers are overlaid instead.
   */
  completeHeaders: boolean;
  /** Last-Modified as change detection read it, for a complete response. */
  lastModified: string | null;
  /** The request headers this crawl sent (the Vary key of the next lookup). */
  requestHeaders: Record<string, string>;
  now: number;
}

/**
 * The stored page with what this crawl's response says about it: its headers,
 * validators and fetch time. Timing and fetcher stay the stored ones, because
 * they describe how the reused BODY was produced (a 304 or a plain probe in
 * front of a stored render measures neither).
 */
export function revalidatedPage(cached: PageRecord, input: RevalidationInput): PageRecord {
  const { result } = input;
  const freshHeaders = pageHeadersFromResponse(
    result,
    input.completeHeaders ? input.lastModified : (result.headers.lastModified ?? null),
  );
  const freshSecurity = securityHeadersFromResponse(result);
  const headers = input.completeHeaders
    ? freshHeaders
    : // A 304 has no body, so its Content-Type (and the charset read off it) is
      // not the page's: keep the stored ones.
      overlaySent(cached.headers, {
        ...freshHeaders,
        contentType: null,
        contentTypeCharset: null,
        // A map of headers, overlaid per header like the rest.
        techHeaders:
          freshHeaders.techHeaders && cached.headers.techHeaders
            ? { ...cached.headers.techHeaders, ...freshHeaders.techHeaders }
            : freshHeaders.techHeaders,
      });
  const securityHeaders = input.completeHeaders
    ? freshSecurity
    : overlaySent(cached.securityHeaders, freshSecurity);
  return {
    ...cached,
    headers,
    securityHeaders,
    // The validators the next run revalidates with.
    etag: headers.etag ?? null,
    lastModified: headers.lastModified ?? null,
    fetchedAt: input.now,
    requestHeaders: input.requestHeaders,
  };
}
