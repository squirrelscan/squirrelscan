import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { Effect, Duration, Schedule, pipe } from "effect";

import type {
  RedirectChain,
  RedirectHop,
  ResponseHeaders,
  SecurityHeaders,
} from "@squirrelscan/core-contracts";
import { CHROME_SEC_CH_UA } from "@squirrelscan/utils/constants";
import { headersForRedirect } from "@squirrelscan/utils/headers";
import {
  DEFAULT_MAX_DOCUMENT_BODY_BYTES,
  readBodyCapped,
} from "@squirrelscan/utils/response-body";
import { detectWafChallengePage } from "@squirrelscan/utils/waf";

export type CrawlErrorType = "timeout" | "network" | "parse" | "blocked" | "rate_limit" | "tls";

export class CrawlError extends Error {
  constructor(
    readonly url: string,
    readonly type: CrawlErrorType,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "CrawlError";
  }

  static timeout(url: string): CrawlError {
    return new CrawlError(url, "timeout", "Crawl request timed out");
  }

  static network(url: string, message: string): CrawlError {
    return new CrawlError(url, "network", message);
  }

  static parse(url: string, message: string): CrawlError {
    return new CrawlError(url, "parse", message);
  }

  static blocked(url: string, message = "Request blocked by server"): CrawlError {
    return new CrawlError(url, "blocked", message);
  }

  static rateLimit(url: string, retryAfter?: number): CrawlError {
    return new CrawlError(url, "rate_limit", "Rate limited", retryAfter);
  }

  static tls(url: string, message: string): CrawlError {
    return new CrawlError(url, "tls", `TLS/connection error: ${message}`);
  }
}

/**
 * Markers for TLS / client-certificate / status-0 connection failures.
 *
 * These surface differently across runtimes (Bun/Node/undici) and the cloud
 * impersonation fetcher, but all mean "couldn't complete a TLS handshake /
 * never got an HTTP status" rather than a normal HTTP-level failure. Detecting
 * them lets us fall back to a standard fetch (dropping impersonation) instead
 * of treating them as a generic network error and silently dropping the page.
 *
 * Markers are intentionally broad substring matches to catch varied runtime
 * phrasings; the only cost of a false positive is one extra standard-fetch
 * fallback attempt, never a wrong audit result. (Bun/undici/Node TLS errors
 * don't embed hostnames, so generic "ssl"/"tls" substrings are safe here.)
 */
const TLS_ERROR_MARKERS = [
  "tls",
  "ssl",
  "certificate",
  "cert_",
  "self-signed",
  "self signed",
  "handshake",
  "alpn",
  "eproto",
  "err_tls",
  "unable to verify",
  "unable to get local issuer",
  "depth_zero_self_signed",
  "wrong_version_number",
  "client certificate",
  "client-cert",
  "decryption failed",
  "bad record mac",
  "sslv3",
];

/** Max nested `error.cause` levels to walk (undici can chain a few deep). */
const MAX_CAUSE_DEPTH = 5;

/**
 * A `status` of 0 means the request never produced an HTTP response (the TLS
 * handshake / connection never completed). Treated as a TLS/connection failure.
 */
export const NEVER_CONNECTED_STATUS = 0;

/**
 * Detect whether a thrown fetch error / status code indicates a TLS,
 * client-certificate, or status-0 ("never connected") failure.
 *
 * `status === 0` from the impersonation fetcher means the request never
 * produced an HTTP response — treated as a TLS/connection failure here so the
 * caller can fall back to a standard fetch. Walks nested `error.cause` chains
 * (bounded by MAX_CAUSE_DEPTH) since runtimes wrap the real TLS error a few
 * levels deep (e.g. undici's "fetch failed" → cause → cause).
 */
export function isTlsError(error: unknown, status?: number): boolean {
  if (status === NEVER_CONNECTED_STATUS) return true;

  const parts: string[] = [];
  let current = error as { message?: unknown; cause?: unknown; code?: unknown } | null | undefined;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current.message === "string") parts.push(current.message);
    if (typeof current.code === "string") parts.push(current.code);
    current = current.cause as typeof current;
  }

  const haystack = parts.join(" ").toLowerCase();
  if (!haystack) return false;
  return TLS_ERROR_MARKERS.some((marker) => haystack.includes(marker));
}

interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
}

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoffMultiplier: 2,
  jitter: true,
};

function isRetryable(error: CrawlError): boolean {
  return (
    error.type === "timeout" ||
    error.type === "rate_limit" ||
    error.type === "network" ||
    error.type === "tls"
  );
}

function withRetry<A, R>(
  effect: Effect.Effect<A, CrawlError, R>,
  policy: RetryPolicy = defaultRetryPolicy,
): Effect.Effect<A, CrawlError, R> {
  let schedule = pipe(
    Schedule.exponential(Duration.millis(policy.baseDelayMs), policy.backoffMultiplier),
    Schedule.compose(Schedule.recurs(Math.max(0, policy.maxAttempts - 1))),
  );

  if (policy.jitter) {
    schedule = Schedule.addDelay(schedule, () =>
      Duration.millis(Math.random() * policy.baseDelayMs * 0.5),
    );
  }

  return Effect.retry(effect, {
    schedule,
    while: (error) => isRetryable(error),
  });
}

interface RequestTiming {
  fetchStart: number;
  responseTime: number;
}

// Exported so audit-time re-fetch passes (e.g. soft-404 confirmation) can build
// requests identical to the crawl's — same UA + sec-fetch/sec-ch headers — so an
// origin that varies on them can't diverge between crawl and confirmation (#1177).
export function applyBrowserHeaders(headers: Headers, userAgent: string): void {
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", userAgent);
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", "en-US,en;q=0.9");
  }
  if (!headers.has("Upgrade-Insecure-Requests")) {
    headers.set("Upgrade-Insecure-Requests", "1");
  }
  if (!headers.has("sec-ch-ua")) {
    headers.set("sec-ch-ua", CHROME_SEC_CH_UA);
  }
  if (!headers.has("sec-ch-ua-mobile")) {
    headers.set("sec-ch-ua-mobile", "?0");
  }
  if (!headers.has("sec-ch-ua-platform")) {
    headers.set("sec-ch-ua-platform", '"macOS"');
  }
  if (!headers.has("sec-fetch-dest")) {
    headers.set("sec-fetch-dest", "document");
  }
  if (!headers.has("sec-fetch-mode")) {
    headers.set("sec-fetch-mode", "navigate");
  }
  if (!headers.has("sec-fetch-site")) {
    headers.set("sec-fetch-site", "none");
  }
  if (!headers.has("sec-fetch-user")) {
    headers.set("sec-fetch-user", "?1");
  }
}

function requestWithTiming(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  userAgent: string,
): Effect.Effect<{ response: Response; timing: RequestTiming }, CrawlError, never> {
  return Effect.tryPromise({
    // Forward the fiber-interrupt signal so a wedged socket is aborted and the host-slot release runs (#405).
    try: async (signal) => {
      const fetchStart = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onInterrupt = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onInterrupt, { once: true });

      try {
        const headers = new Headers(options.headers);
        applyBrowserHeaders(headers, userAgent);

        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        const responseTime = Date.now();
        return { response, timing: { fetchStart, responseTime } };
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onInterrupt);
      }
    },
    catch: (error) => {
      const message = (error as Error).message?.toLowerCase() ?? "";
      const isAbort = (error as Error).name === "AbortError" || message.includes("timed out");
      if (isAbort) return CrawlError.timeout(url);
      if (isTlsError(error)) return CrawlError.tls(url, (error as Error).message);
      return CrawlError.network(url, (error as Error).message);
    },
  });
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  loadTime: number;
  /** Absent for cloud-rendered fetches — submit+queue+render wall time is not server TTFB. */
  ttfb?: number;
  downloadTime?: number;
  headers: ResponseHeaders;
  securityHeaders: SecurityHeaders;
  contentType: string | null;
  body: string;
  sizeBytes: number;
  redirectChain: RedirectChain;
  /** Which fetcher/egress served this page (e.g. "cloud-render", "fetch", "browser") — persisted per page (#512). */
  fetcherId?: string;
  /** Why a fallback egress served this page, when it did (e.g. "render-block") (#512). */
  fallbackReason?: string;
  /** sha256 of the normalized raw source, when the conditional-render gate probed and rendered — persisted as the page's source_hash for next-run reuse (#839). */
  sourceHash?: string;
  /** Browser render cost only, threaded from the browser-queue fetcher's server-measured value (#826). Absent for non-rendered fetches. */
  renderTimeMs?: number;
  /** Queue delivery lag + browser-pool acquisition + concurrency-slot wait before rendering started (#826). Absent for non-rendered fetches. */
  queueWaitMs?: number;
}

/** Structured context emitted when a TLS/status-0 failure or fallback occurs. */
export interface TlsEvent {
  /** "fallback" = impersonation failed, retrying with standard fetch.
   *  "fallback_ok" = standard fetch succeeded after impersonation failed.
   *  "fallback_failed" = standard fetch also failed.
   *  "error" = a TLS/status-0 failure on the standard (non-impersonation) path. */
  kind: "fallback" | "fallback_ok" | "fallback_failed" | "error";
  url: string;
  /** Fetcher id that produced the original TLS failure (e.g. "browser-queue"). */
  fetcherId?: string;
  /** Recovered HTTP status from the standard-fetch fallback. Set only on "fallback_ok". */
  recoveredStatus?: number;
  /**
   * True when the failure never completed a connection / produced no HTTP
   * status: "error" (a thrown TLS exception) and "fallback_failed" when the
   * fallback also failed on TLS. False when the fallback failed with an HTTP
   * status (e.g. 429); unset on the transient "fallback" / recovered "fallback_ok".
   */
  wasNeverConnected?: boolean;
  message: string;
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  followRedirects: boolean;
  headers?: Record<string, string>;
  fetcher?: DocumentFetcher;
  /**
   * Structured logging hook for TLS/status-0 failures and standard-fetch
   * fallbacks. Defaults to a no-op so the package stays silent unless the
   * consumer (CLI/crawler) wires a logger. Lets these failures be observed
   * instead of vanishing into a generic network error.
   */
  onTlsEvent?: (event: TlsEvent) => void;
  /**
   * sha256 of the stored copy's normalized source, forwarded to the fetcher so
   * the conditional-render gate can reuse the stored render when unchanged
   * (#839). Only the render-all gate reads it; every other fetcher ignores it.
   */
  storedSourceHash?: string;
}

function extractResponseHeaders(headers: Headers): ResponseHeaders {
  // `getSetCookie()` returns each Set-Cookie header exactly as sent, unlike
  // `.get()` which comma-joins duplicates — ambiguous with the comma inside a
  // cookie's own `Expires=Wed, 09 Jun 2021...` attribute. Joined with "\n"
  // (can't appear in a header value), aligned with the CLI fetch path
  // (packages/fetchers/src/index.ts) and the hosted render path so rules see
  // one shape regardless of which fetcher produced the page.
  const setCookies = headers.getSetCookie();
  return {
    contentType: headers.get("content-type"),
    contentEncoding: headers.get("content-encoding"),
    cacheControl: headers.get("cache-control"),
    expires: headers.get("expires"),
    vary: headers.get("vary"),
    etag: headers.get("etag"),
    server: headers.get("server"),
    lastModified: headers.get("last-modified"),
    link: headers.get("link"),
    serverTiming: headers.get("server-timing"),
    age: headers.get("age"),
    xCache: headers.get("x-cache"),
    cfCacheStatus: headers.get("cf-cache-status"),
    xVercelCache: headers.get("x-vercel-cache"),
    altSvc: headers.get("alt-svc"),
    acceptRanges: headers.get("accept-ranges"),
    setCookie: setCookies.length > 0 ? setCookies.join("\n") : null,
  };
}

function extractSecurityHeaders(headers: Headers): SecurityHeaders {
  return {
    hsts: headers.get("strict-transport-security"),
    csp: headers.get("content-security-policy"),
    xFrameOptions: headers.get("x-frame-options"),
    xContentTypeOptions: headers.get("x-content-type-options"),
    referrerPolicy: headers.get("referrer-policy"),
    permissionsPolicy: headers.get("permissions-policy"),
    xRobotsTag: headers.get("x-robots-tag"),
  };
}

function normalizeContentType(value: string | null): string | null {
  if (!value) return null;
  return value.split(";")[0]?.trim().toLowerCase() ?? null;
}

function normalizeServerTimingValue(value: string): string {
  return value.replace(/(?<!,)\s+(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+;)/g, ",");
}

function setHeaderSafely(headers: Headers, key: string, value: string): void {
  const sanitized = value.replace(/[\r\n]+/g, " ").trim();
  if (!sanitized) return;

  const lowerKey = key.toLowerCase();
  const candidates =
    lowerKey === "server-timing"
      ? Array.from(new Set([normalizeServerTimingValue(sanitized), sanitized]))
      : [sanitized];

  for (const candidate of candidates) {
    try {
      headers.set(key, candidate);
      return;
    } catch {
      // Ignore invalid header values and continue.
    }
  }
}

function headersFromRecord(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "set-cookie") {
      // A DocumentFetcher's `headers["set-cookie"]` is "\n"-joined, one entry
      // per real Set-Cookie header. `setHeaderSafely`
      // below strips \r\n (turning it into one space-joined, corrupted
      // cookie), so append each cookie separately instead — `Headers.append`
      // keeps repeated Set-Cookie entries distinct, matching native
      // multi-Set-Cookie semantics, and a legal cookie value/attribute can't
      // itself contain a raw newline (RFC 6265 excludes control characters).
      for (const cookie of value.split("\n")) {
        const trimmed = cookie.trim();
        if (!trimmed) continue;
        try {
          headers.append("set-cookie", trimmed);
        } catch {
          // Ignore invalid header values and continue.
        }
      }
      continue;
    }
    setHeaderSafely(headers, key, value);
  }
  return headers;
}

function parseContentLength(headers: Headers, body: string): number {
  const sizeHeader = headers.get("content-length");
  const sizeBytes = sizeHeader ? Number.parseInt(sizeHeader, 10) : new Blob([body]).size;
  return Number.isNaN(sizeBytes) ? new Blob([body]).size : sizeBytes;
}

/**
 * Classify an HTTP status into a fetch failure (or let it through). Exported so
 * tests can drive the real classification through the injectable fetch seam.
 */
export function applyStatusGuards(
  url: string,
  status: number,
  headers: Headers,
  body?: string,
): Effect.Effect<void, CrawlError, never> {
  if (status === 429) {
    const retryAfter = headers.get("retry-after");
    const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
    return Effect.fail(CrawlError.rateLimit(url, retryAfterSeconds));
  }

  if (status === 403) {
    return Effect.fail(CrawlError.blocked(url));
  }

  if (status >= 500) {
    // Cloudflare/PerimeterX/Akamai bot walls serve their JS challenge as a 503,
    // which is the site refusing the crawler, not an outage — classify it as
    // blocked (non-retryable; a challenge never clears on retry) so a walled
    // root gets the actionable blocked notice instead of "unreachable" (#802).
    if (status === 503) {
      // Cloudflare stamps challenge responses explicitly — a body-independent
      // signal (a 503 passed through from a down origin never carries it).
      if (headers.get("cf-mitigated") === "challenge") {
        return Effect.fail(CrawlError.blocked(url, "Blocked by Cloudflare challenge (503)"));
      }
      if (body) {
        const challenge = detectWafChallengePage({
          status,
          headers: {
            server: headers.get("server"),
            cfCacheStatus: headers.get("cf-cache-status"),
            xCache: headers.get("x-cache"),
          },
          html: body,
        });
        if (challenge.detected) {
          return Effect.fail(
            CrawlError.blocked(
              url,
              `Blocked by ${challenge.provider ?? "bot protection"} challenge (503)`,
            ),
          );
        }
      }
    }
    return Effect.fail(CrawlError.network(url, `Server error: ${status}`));
  }

  return Effect.void;
}

function fetchWithDocumentFetcher(
  url: string,
  headers: Record<string, string>,
  options: FetchOptions,
): Effect.Effect<FetchResult, CrawlError, never> {
  if (!options.fetcher) {
    return Effect.fail(CrawlError.network(url, "No custom fetcher configured"));
  }

  return Effect.gen(function* () {
    // `signal` is aborted when this fiber is interrupted (e.g. the per-URL
    // watchdog timeout or crawler.stop()). Forwarding it lets the fetcher
    // actually cancel a wedged request — without it a never-returning cloud
    // render would park here uninterruptibly, never run the host-slot release
    // in processUrl's `finally`, and deadlock the crawl.
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        options.fetcher!.fetch({
          url,
          method: "GET",
          headers,
          timeoutMs: options.timeoutMs,
          followRedirects: options.followRedirects,
          signal,
          storedSourceHash: options.storedSourceHash,
        }),
      catch: (error) =>
        isTlsError(error)
          ? CrawlError.tls(url, (error as Error).message)
          : CrawlError.network(url, (error as Error).message),
    });

    // status === 0 from the impersonation fetcher means the request never
    // produced an HTTP response (TLS handshake / client-cert failure) — surface
    // it as a TLS error so the caller can fall back to a standard fetch instead
    // of treating a never-connected page as a real (network) failure.
    if (isTlsError(undefined, response.status)) {
      return yield* Effect.fail(
        CrawlError.tls(url, `impersonation fetch returned status ${response.status}`),
      );
    }

    const responseHeaders = headersFromRecord(response.headers);
    yield* applyStatusGuards(url, response.status, responseHeaders, response.body);

    // Cloud-rendered fetches measure submit + queue + browser render, not
    // server response time — leaving ttfb/downloadTime unset makes the perf
    // rules skip instead of reporting a false "very slow server" signal.
    const isCloudRender = response.fetcherMethod === "cloud-render";
    const ttfb = response.timing.responseAt - response.timing.startedAt;
    const loadTime = Math.max(0, response.timing.finishedAt - response.timing.startedAt);
    const downloadTime = Math.max(0, loadTime - ttfb);
    const contentType = normalizeContentType(responseHeaders.get("content-type"));
    const sizeBytes = parseContentLength(responseHeaders, response.body);

    return {
      url,
      finalUrl: response.finalUrl,
      status: response.status,
      loadTime,
      ttfb: isCloudRender ? undefined : ttfb,
      downloadTime: isCloudRender ? undefined : downloadTime,
      headers: extractResponseHeaders(responseHeaders),
      securityHeaders: extractSecurityHeaders(responseHeaders),
      contentType,
      body: response.body,
      sizeBytes,
      redirectChain: response.redirectChain,
      // Egress/method that served this page + any fallback reason, threaded from
      // the document fetcher so the crawler can persist it per page (#512).
      fetcherId: response.fetcherMethod,
      fallbackReason: response.fallbackReason,
      // Normalized-source hash, set only when the conditional-render gate probed
      // and rendered — persisted as the page's source_hash for next-run reuse (#839).
      sourceHash: response.sourceHash,
      // Queue-wait vs render-time breakdown, set only by the browser-queue
      // fetcher (#826).
      renderTimeMs: response.renderTimeMs,
      queueWaitMs: response.queueWaitMs,
    };
  });
}

/**
 * Standard (non-impersonation) fetch path: plain `fetch` with browser-like
 * headers, manual redirect following, and reachability/redirect detection.
 * Used both as the default path (no custom fetcher) and as the fallback when an
 * impersonation/custom fetcher fails with a TLS/status-0 error.
 */
function fetchPageStandard(
  url: string,
  options: FetchOptions,
): Effect.Effect<FetchResult, CrawlError, never> {
  return Effect.gen(function* () {
    let headers = new Headers({
      "User-Agent": options.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      ...options.headers,
    });

    const MAX_REDIRECTS = 10;
    const hops: RedirectHop[] = [];
    const visited = new Set<string>();
    let currentUrl = url;
    let isLoop = false;
    let endsInError = false;
    let finalResponse: Response | null = null;
    let finalTiming: RequestTiming | null = null;
    let lastResponse: Response | null = null;
    let lastTiming: RequestTiming | null = null;

    for (let i = 0; i < MAX_REDIRECTS; i++) {
      if (visited.has(currentUrl)) {
        isLoop = true;
        break;
      }
      visited.add(currentUrl);

      const { response, timing } = yield* requestWithTiming(
        currentUrl,
        {
          method: "GET",
          headers,
          redirect: "manual",
        },
        options.timeoutMs,
        options.userAgent,
      );

      lastResponse = response;
      lastTiming = timing;

      hops.push({
        url: currentUrl,
        statusCode: response.status,
        type: "http",
      });

      if (options.followRedirects && response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          endsInError = true;
          finalResponse = response;
          finalTiming = timing;
          break;
        }
        const nextUrl = new URL(location, currentUrl).toString();
        headers = headersForRedirect(headers, currentUrl, nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      if (response.status >= 400) {
        endsInError = true;
      }

      finalResponse = response;
      finalTiming = timing;
      break;
    }

    if (!finalResponse && lastResponse && lastTiming) {
      finalResponse = lastResponse;
      finalTiming = lastTiming;
      endsInError = true;
    }

    if (!finalResponse || !finalTiming) {
      return yield* Effect.fail(CrawlError.network(url, "Failed to fetch final response"));
    }

    const ttfb = finalTiming.responseTime - finalTiming.fetchStart;

    const readBody = Effect.tryPromise({
      // Race the body read against the interrupt signal so a stalled stream doesn't leak the host slot (#405).
      try: async (signal) => {
        let onAbort: (() => void) | undefined;
        try {
          return await Promise.race([
            readBodyCapped(finalResponse, DEFAULT_MAX_DOCUMENT_BODY_BYTES),
            new Promise<never>((_, reject) => {
              if (signal.aborted) return reject(new Error("aborted"));
              onAbort = () => reject(new Error("aborted"));
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      },
      catch: (error) =>
        CrawlError.parse(url, `Failed to read response: ${(error as Error).message}`),
    });

    // A 503 needs its body to tell a bot-challenge interstitial from a real
    // outage (#802). 503 always fails the guard below, so consuming the stream
    // here is safe; an unreadable body falls through to the generic server error.
    const challengeBody =
      finalResponse.status === 503
        ? yield* Effect.orElseSucceed(readBody, () => undefined)
        : undefined;

    yield* applyStatusGuards(url, finalResponse.status, finalResponse.headers, challengeBody);

    const body = yield* readBody;

    const loadTime = Date.now() - finalTiming.fetchStart;
    const downloadTime = loadTime - ttfb;

    const contentType = normalizeContentType(finalResponse.headers.get("content-type"));
    const sizeBytes = parseContentLength(finalResponse.headers, body);

    const finalUrl = hops.length > 0 ? hops[hops.length - 1]!.url : url;

    let httpsToHttp = false;
    let httpToHttps = false;
    for (let i = 0; i < hops.length - 1; i++) {
      const from = hops[i]!.url;
      const to = hops[i + 1]!.url;
      if (from.startsWith("https://") && to.startsWith("http://")) {
        httpsToHttp = true;
      }
      if (from.startsWith("http://") && to.startsWith("https://")) {
        httpToHttps = true;
      }
    }

    const redirectChain: RedirectChain = {
      sourceUrl: url,
      finalUrl,
      hops,
      chainLength: Math.max(0, hops.length - 1),
      isLoop,
      endsInError,
      httpsToHttp,
      httpToHttps,
    };

    return {
      url,
      finalUrl,
      status: finalResponse.status,
      loadTime,
      ttfb,
      downloadTime,
      headers: extractResponseHeaders(finalResponse.headers),
      securityHeaders: extractSecurityHeaders(finalResponse.headers),
      contentType,
      body,
      sizeBytes,
      redirectChain,
      // Plain-HTTP path — served directly by `fetch`, no cloud render (#512).
      fetcherId: "fetch",
    };
  });
}

export function fetchPage(
  url: string,
  options: FetchOptions,
): Effect.Effect<FetchResult, CrawlError, never> {
  const emit = (event: TlsEvent): void => {
    try {
      options.onTlsEvent?.(event);
    } catch (hookError) {
      // A broken consumer hook must never break a crawl, but surface it so it's
      // diagnosable instead of vanishing entirely.
      console.error("onTlsEvent hook threw:", hookError);
    }
  };

  // No custom fetcher → standard fetch path directly. Surface TLS failures
  // with context so they aren't silent. wasNeverConnected: a thrown TLS
  // exception means no HTTP status was ever produced.
  if (!options.fetcher) {
    return fetchPageStandard(url, options).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.type === "tls") {
            emit({ kind: "error", url, wasNeverConnected: true, message: error.message });
          }
        }),
      ),
    );
  }

  const fetcherId = options.fetcher.id;
  // Headers passed to the custom fetcher only; the standard-fetch fallback
  // rebuilds its own from options inside fetchPageStandard.
  const headers = {
    "User-Agent": options.userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    ...options.headers,
  };

  // Impersonation/custom fetcher path. On a TLS/status-0 failure, fall back to a
  // standard fetch (dropping impersonation) so the audit can still detect
  // reachability + redirects instead of silently dropping the page.
  return fetchWithDocumentFetcher(url, headers, options).pipe(
    Effect.catchIf(
      (error) => error.type === "tls",
      (error) =>
        Effect.gen(function* () {
          emit({
            kind: "fallback",
            url,
            fetcherId,
            message: `${error.message} — falling back to standard fetch`,
          });

          // onTlsEvent unset: fetchPageStandard never emits; fallback events go
          // via emit() here. The fallback is a best-effort last resort after
          // impersonation already failed, so cap retries low to avoid adding
          // minutes of backoff to a large audit of a TLS-misconfigured site.
          const fallbackOptions: FetchOptions = {
            ...options,
            fetcher: undefined,
            onTlsEvent: undefined,
          };
          const result = yield* Effect.either(
            withRetry(fetchPageStandard(url, fallbackOptions), {
              ...defaultRetryPolicy,
              maxAttempts: 2,
            }),
          );

          if (result._tag === "Left") {
            emit({
              kind: "fallback_failed",
              url,
              fetcherId,
              // never connected only when the fallback also failed on TLS.
              wasNeverConnected: result.left.type === "tls",
              message: result.left.message,
            });
            return yield* Effect.fail(result.left);
          }

          emit({
            kind: "fallback_ok",
            url,
            fetcherId,
            recoveredStatus: result.right.status,
            message: `standard fetch recovered ${url} (status ${result.right.status})`,
          });
          return result.right;
        }),
    ),
  );
}

/** Crawl-loop fetch seam — defaults to fetchPageWithRetry, injectable for deterministic tests (#315). */
export type CrawlFetcher = (
  url: string,
  options: FetchOptions,
) => Effect.Effect<FetchResult, CrawlError, never>;

export function fetchPageWithRetry(
  url: string,
  options: FetchOptions,
): Effect.Effect<FetchResult, CrawlError, never> {
  // INVARIANT: the custom-fetcher path runs exactly ONE outer attempt. fetchPage
  // already owns the impersonation→standard-fetch fallback and its own retry
  // budget internally, so a retryable (e.g. tls) error returned from it must NOT
  // be re-driven through the whole impersonation+fallback dance again. Do not
  // raise this above 1 for the fetcher path without removing the inner fallback
  // retry first — otherwise retries multiply (outer × inner).
  const maxAttempts = options.fetcher ? 1 : 3;
  return withRetry(fetchPage(url, options), {
    ...defaultRetryPolicy,
    maxAttempts,
  });
}

export function fetchPageSafe(
  url: string,
  options: FetchOptions,
): Effect.Effect<FetchResult | null, never, never> {
  return pipe(
    fetchPageWithRetry(url, options),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}
