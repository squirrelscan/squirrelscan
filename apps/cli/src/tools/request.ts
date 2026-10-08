// Global HTTP request tool with Effect
// Provides consistent user-agent, retry, rate-limiting across all requests
// Uses plain fetch with browser-like headers

import { withRequestDeadline } from "@squirrelscan/crawler/deadline";
import { Effect, Schedule, Duration, Data } from "effect";

import { CHROME_USER_AGENT, CHROME_SEC_CH_UA } from "@/constants";
import { logger } from "@/utils/logger";

// ============================================
// CONFIGURATION
// ============================================

export interface RequestToolConfig {
  userAgent: string;
  timeout: number;
  followRedirects: boolean;
  retryAttempts: number;
  retryDelayMs: number;
  rateLimitPerSecond: number;
}

export interface RequestTiming {
  fetchStart: number;
  responseTime: number;
}

const defaultConfig: RequestToolConfig = {
  userAgent: CHROME_USER_AGENT,
  timeout: 30000,
  followRedirects: true,
  retryAttempts: 3,
  retryDelayMs: 1000,
  rateLimitPerSecond: 0, // 0 = disabled, rely on per-host delays in crawler
};

let config: RequestToolConfig = { ...defaultConfig };
let lastRequestTime = 0;

// ============================================
// ERRORS
// ============================================

export class RequestError extends Data.TaggedError("RequestError")<{
  url: string;
  message: string;
  statusCode?: number;
}> {
  static network(url: string, message: string): RequestError {
    return new RequestError({ url, message });
  }

  static http(url: string, statusCode: number, message: string): RequestError {
    return new RequestError({ url, message, statusCode });
  }

  static timeout(url: string): RequestError {
    return new RequestError({ url, message: "Request timed out" });
  }
}

// ============================================
// LIFECYCLE (no-op stubs for backwards compat)
// ============================================

/**
 * Initialize request tool (no-op - TLS client removed)
 * @deprecated TLS impersonation removed, this is now a no-op
 */
export async function initTlsClient(): Promise<void> {
  // No-op - TLS client removed, using plain fetch with browser headers
}

/**
 * Destroy request tool (no-op - TLS client removed)
 * @deprecated TLS impersonation removed, this is now a no-op
 */
export async function destroyTlsClient(): Promise<void> {
  // No-op - TLS client removed
}

// ============================================
// INITIALIZATION
// ============================================

export function initRequestTool(cfg: Partial<RequestToolConfig>): void {
  config = { ...defaultConfig, ...cfg };
}

export function getRequestConfig(): RequestToolConfig {
  return { ...config };
}

/**
 * Check if browser impersonation is available
 * @deprecated TLS impersonation removed, always returns false
 */
export function isImpersonationAvailable(): boolean {
  return false;
}

// ============================================
// BROWSER HEADERS
// ============================================

/**
 * Apply browser-like headers to a Headers object
 * Helps with WAF compatibility even without TLS impersonation
 */
function applyBrowserHeaders(headers: Headers, userAgent: string): void {
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", userAgent);
  }
  if (!headers.has("Accept")) {
    headers.set(
      "Accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    );
  }
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", "en-US,en;q=0.9");
  }
  if (!headers.has("Accept-Encoding")) {
    headers.set("Accept-Encoding", "gzip, deflate, br");
  }
  if (!headers.has("Upgrade-Insecure-Requests")) {
    headers.set("Upgrade-Insecure-Requests", "1");
  }
  // Chrome client hints - helps with WAF detection
  if (!headers.has("sec-ch-ua")) {
    headers.set("sec-ch-ua", CHROME_SEC_CH_UA);
  }
  if (!headers.has("sec-ch-ua-mobile")) {
    headers.set("sec-ch-ua-mobile", "?0");
  }
  if (!headers.has("sec-ch-ua-platform")) {
    headers.set("sec-ch-ua-platform", '"macOS"');
  }
  // Fetch metadata headers - modern browsers send these
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

// ============================================
// DEADLINE-SCOPED FETCH
// ============================================

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Read the body inside the request deadline and hand back a detached Response.
 *
 * The deadline stays armed until the body has been read, so an origin that
 * sends headers and then stalls aborts the read instead of parking the caller.
 * `url` and `redirected` do not survive the copy by themselves, so they are
 * carried over.
 */
async function bufferResponse(response: Response): Promise<Response> {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? null
    : await response.arrayBuffer();
  const copy = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(copy, "url", { value: response.url });
  Object.defineProperty(copy, "redirected", { value: response.redirected });
  return copy;
}

function toRequestError(url: string, error: unknown): RequestError {
  if ((error as Error).name === "AbortError") {
    return RequestError.timeout(url);
  }
  if ((error as Error).message?.includes("timed out")) {
    return RequestError.timeout(url);
  }
  return RequestError.network(url, (error as Error).message);
}

/**
 * One attempt: fetch under a deadline that covers the body read.
 *
 * `use` reads or cancels the body before it returns; the deadline is disarmed
 * as soon as it does. Every helper in this file goes through here, so no caller
 * can end up with a Response whose body read is unbounded.
 */
function fetchWithDeadline<T>(
  url: string,
  options: RequestInit | undefined,
  headers: Headers,
  redirect: RequestRedirect,
  timeoutMs: number,
  use: (response: Response, timing: RequestTiming) => Promise<T>
): Effect.Effect<T, RequestError, never> {
  return Effect.tryPromise({
    try: async () => {
      const fetchStart = Date.now();
      let responseTime = fetchStart;
      return await withRequestDeadline(
        timeoutMs,
        async (signal) => {
          const response = await fetch(url, {
            ...options,
            headers,
            signal,
            redirect,
          });
          responseTime = Date.now();
          return response;
        },
        (response) => use(response, { fetchStart, responseTime })
      );
    },
    catch: (error) => toRequestError(url, error),
  });
}

function logRequest(
  url: string,
  options: RequestInit | undefined,
  response: Response,
  timing: RequestTiming
): void {
  logger.debug("request", {
    url,
    method: options?.method ?? "GET",
    status: response.status,
    ttfb: timing.responseTime - timing.fetchStart,
  });
}

// ============================================
// EFFECT-BASED REQUEST
// ============================================

/**
 * Make an HTTP request with retry and rate limiting
 * Returns an Effect that can be composed with other Effects
 */
export function request(
  url: string,
  options?: RequestInit
): Effect.Effect<Response, RequestError, never> {
  return requestWithTiming(url, options).pipe(
    Effect.map((result) => result.response)
  );
}

export function requestWithTiming(
  url: string,
  options?: RequestInit
): Effect.Effect<
  { response: Response; timing: RequestTiming },
  RequestError,
  never
> {
  return Effect.gen(function* () {
    // Rate limiting - ensure minimum delay between requests (skip if disabled)
    if (config.rateLimitPerSecond > 0) {
      const now = Date.now();
      const minDelay = 1000 / config.rateLimitPerSecond;
      const elapsed = now - lastRequestTime;
      if (elapsed < minDelay) {
        yield* Effect.sleep(Duration.millis(minDelay - elapsed));
      }
      lastRequestTime = Date.now();
    }

    // Build request with Chrome-like headers for better WAF compatibility
    const headers = new Headers(options?.headers);
    applyBrowserHeaders(headers, config.userAgent);

    const redirectMode =
      options?.redirect ?? (config.followRedirects ? "follow" : "manual");

    const result = yield* fetchWithDeadline(
      url,
      options,
      headers,
      redirectMode,
      config.timeout,
      async (response, timing) => ({
        response: await bufferResponse(response),
        timing,
      })
    );

    logRequest(url, options, result.response, result.timing);
    return result;
  }).pipe(
    // Retry with exponential backoff on network errors
    Effect.retry(
      Schedule.exponential(Duration.millis(config.retryDelayMs)).pipe(
        Schedule.compose(Schedule.recurs(config.retryAttempts)),
        // Only retry on network errors, not HTTP errors
        Schedule.whileInput(
          (error: RequestError) => error.statusCode === undefined
        )
      )
    )
  );
}

/**
 * Make a single HTTP request without retries
 * Use this for quick checks like reachability where fast failure is preferred
 */
export function requestOnce(
  url: string,
  options?: RequestInit
): Effect.Effect<Response, RequestError, never> {
  return requestOnceWithTiming(url, options).pipe(
    Effect.map((result) => result.response)
  );
}

export function requestOnceWithTiming(
  url: string,
  options?: RequestInit
): Effect.Effect<
  { response: Response; timing: RequestTiming },
  RequestError,
  never
> {
  return Effect.gen(function* () {
    // Build request with Chrome-like headers for better WAF compatibility
    const headers = new Headers(options?.headers);
    applyBrowserHeaders(headers, config.userAgent);

    const result = yield* fetchWithDeadline(
      url,
      options,
      headers,
      config.followRedirects ? "follow" : "manual",
      config.timeout,
      async (response, timing) => ({
        response: await bufferResponse(response),
        timing,
      })
    );

    logRequest(url, options, result.response, result.timing);
    return result;
  });
  // Note: No retry wrapper - this is a single-attempt request
}

/**
 * Single attempt whose caller reads the body itself, inside the deadline.
 *
 * For callers that only want part of a body (a sample, a header check) and
 * would waste time buffering the rest. `use` must read or cancel the body
 * before it returns. `timeoutMs` overrides the configured timeout.
 */
export function requestOnceScoped<T>(
  url: string,
  options: RequestInit | undefined,
  use: (response: Response) => Promise<T>,
  timeoutMs: number = config.timeout
): Effect.Effect<T, RequestError, never> {
  return Effect.suspend(() => {
    const headers = new Headers(options?.headers);
    applyBrowserHeaders(headers, config.userAgent);
    return fetchWithDeadline(
      url,
      options,
      headers,
      config.followRedirects ? "follow" : "manual",
      timeoutMs,
      (response) => use(response)
    );
  });
}

/**
 * Make a request and parse JSON response
 */
export function requestJson<T>(
  url: string,
  options?: RequestInit
): Effect.Effect<T, RequestError, never> {
  return request(url, options).pipe(
    Effect.flatMap((response) => {
      if (!response.ok) {
        return Effect.fail(
          RequestError.http(url, response.status, response.statusText)
        );
      }
      return Effect.tryPromise({
        try: () => response.json() as Promise<T>,
        catch: () => RequestError.network(url, "Failed to parse JSON response"),
      });
    })
  );
}

/**
 * Make a request and get text response
 */
export function requestText(
  url: string,
  options?: RequestInit
): Effect.Effect<string, RequestError, never> {
  return request(url, options).pipe(
    Effect.flatMap((response) => {
      if (!response.ok) {
        return Effect.fail(
          RequestError.http(url, response.status, response.statusText)
        );
      }
      return Effect.tryPromise({
        try: () => response.text(),
        catch: () => RequestError.network(url, "Failed to read response text"),
      });
    })
  );
}

// ============================================
// ASYNC CONVENIENCE WRAPPERS
// ============================================

/**
 * Make a request and return a Promise
 * Use this when you need to call from non-Effect code
 */
export async function requestAsync(
  url: string,
  options?: RequestInit
): Promise<Response> {
  return Effect.runPromise(request(url, options));
}

export async function requestOnceAsync(
  url: string,
  options?: RequestInit
): Promise<Response> {
  return Effect.runPromise(requestOnce(url, options));
}

export async function requestJsonAsync<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  return Effect.runPromise(requestJson<T>(url, options));
}

export async function requestTextAsync(
  url: string,
  options?: RequestInit
): Promise<string> {
  return Effect.runPromise(requestText(url, options));
}
