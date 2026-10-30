// Simple reachability check for URLs
// Uses request tool with browser-like headers
// Detects WAF/bot protection on target site

import { redactUrl, redactUrlsInText } from "@squirrelscan/core-contracts";
import { ownSiteHostMatcher } from "@squirrelscan/utils/own-site";
import {
  EGRESS_OFF_SITE_REFUSAL,
  EgressRefusedError,
  egressGuardedSend,
  ownHostsPinned,
  refusedWithoutLookup,
  resolveHostAddresses,
  type EgressPolicy,
} from "@squirrelscan/utils/public-egress";
import { decodedBody, fetchUndecoded } from "@squirrelscan/utils/response-body";
import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";
import { Effect, Duration } from "effect";

import { pinOwnHosts } from "@/crawl/pin-own-hosts";
import { requestOnceScoped, RequestError } from "@/tools/request";
import { logger } from "@/utils/logger";
import { detectWaf, type WafProvider } from "@/utils/waf";

const REACHABILITY_TIMEOUT_MS = 10000;
const REACHABILITY_BODY_SAMPLE_BYTES = 10240;
const REACHABILITY_BODY_SAMPLE_TIMEOUT_MS = 1500;

// The probe runs before any crawling, and a single transient blip used to abort
// the whole audit (the crawler itself has retried since forever). Retry only
// errors that can plausibly succeed on a second try, and bound the total spend
// so a genuinely dead host still fails fast.
export const REACHABILITY_MAX_ATTEMPTS = 3;
const REACHABILITY_RETRY_BASE_DELAY_MS = 300;
const REACHABILITY_TOTAL_BUDGET_MS = 20000;

/**
 * Errors worth a second attempt. Definitive answers (DNS says the name does not
 * exist, the port actively refused, the certificate is bad) are not retried:
 * they resolve in milliseconds and repeating them only delays the failure.
 */
export function isTransientReachabilityError(
  error: string | undefined
): boolean {
  if (!error) return false;
  const message = error.toLowerCase();
  if (
    message.includes("dns") ||
    message.includes("host not found") ||
    message.includes("refused") ||
    message.includes("certificate") ||
    message.includes("ssl") ||
    message.includes("tls")
  ) {
    return false;
  }
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("socket") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("fetch failed")
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ReachabilityResult {
  reachable: boolean;
  error?: string;
  statusCode?: number;
  /** True if WAF/bot protection detected on target */
  wafDetected?: boolean;
  /** Detected WAF provider if wafDetected is true */
  wafProvider?: WafProvider;
}

async function readBodySample(
  response: Response,
  maxBytes: number,
  timeoutMs: number
): Promise<string | undefined> {
  const body = decodedBody(response);
  if (!body) return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  const deadline = Date.now() + timeoutMs;

  async function readChunkWithTimeout(
    remainingMs: number
  ): Promise<{ done: boolean; value?: Uint8Array }> {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Cancel immediately on timeout so slow/streaming bodies don't linger.
        reader
          .cancel()
          .catch(() => {})
          .finally(() => reject(new Error("Body read timeout")));
      }, remainingMs);
      reader
        .read()
        .then((chunk) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(chunk);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  try {
    while (bytesRead < maxBytes) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs === 0) {
        await reader.cancel();
        return text || undefined;
      }

      const chunk = await readChunkWithTimeout(remainingMs);

      if (chunk.done) break;

      const value = chunk.value;
      if (!value) break;
      const allowedLength = Math.min(value.length, maxBytes - bytesRead);
      if (allowedLength > 0) {
        text += decoder.decode(value.subarray(0, allowedLength), {
          stream: true,
        });
        bytesRead += allowedLength;
      }

      if (bytesRead >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    // Ignore body sampling errors; reachability decision still relies on headers/status
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return text || undefined;
}

/** Which hosts the probe may follow a redirect to (`squirrel audit --offline`, #819). */
export interface ReachabilityScope {
  /** Only the audited site: its host, its `www` or apex twin, `domains` and their subdomains. */
  ownSiteOnly?: boolean;
  /** `[project] domains`, named as the site's own. */
  domains?: readonly string[];
}

/** The status reported for a start URL that redirects off the site in an offline audit (not followed). */
const OFF_SITE_REDIRECT_STATUS = 302;

/** What the probe says when the site's host resolves to an address it never requests. */
const EGRESS_REFUSED_REACHABILITY =
  "Not requested: it resolves or redirects to a link-local or cloud metadata address";

/**
 * The send for a pinned probe (squirrelscan/repo#3430): the start URL's host is
 * resolved, refused when it answers a link-local or metadata address, and
 * connected to by the address checked, the way the crawl will. Undefined when
 * the site's own hosts are not pinned (opted out, or an environment proxy).
 */
function reachabilitySend(
  url: string,
  scope?: ReachabilityScope
): ((url: string, init: RequestInit) => Promise<Response>) | undefined {
  const pinned = ownHostsPinned({ pinOwnHosts: pinOwnHosts() });
  if (!pinned && scope?.ownSiteOnly !== true) return undefined;
  const policy: EgressPolicy = {
    allowPrivateNetwork: true,
    resolve: resolveHostAddresses,
  };
  // --offline (#819): the start URL's redirects stay on the audited site too.
  // With the own hosts not pinned (opted out, or an environment proxy) they
  // still go out by name; only the hops that leave the site are refused.
  if (scope?.ownSiteOnly === true) {
    const own = ownSiteHostMatcher({ baseUrl: url, domains: scope.domains });
    policy.allowHost = own;
    if (!pinned) policy.trustTarget = (hop) => own(hop.hostname);
  }
  // An address the user named as the site is theirs to audit, as the crawl
  // treats it: only where the site's DNS or redirects lead is guarded.
  if (refusedWithoutLookup(url, policy)) return undefined;
  // Redirects are followed hop by hop through the guard (safeRedirectFetch), so
  // the WAF check still reads the page a redirect lands on, and a hop that
  // resolves to a refused address is never sent.
  const guarded = egressGuardedSend(fetchUndecoded, policy);
  return (hopUrl, init) =>
    safeRedirectFetch(hopUrl, init, guarded).then((result) => result.response);
}

/**
 * Check if a URL is reachable
 * Uses browser-like headers for WAF compatibility
 * Detects WAF/bot protection on target site
 *
 * Transient failures are retried with a short backoff (see
 * isTransientReachabilityError); definitive ones fail on the first attempt.
 */
export async function checkReachability(
  url: string,
  scope?: ReachabilityScope,
  requestScoped: typeof requestOnceScoped = requestOnceScoped,
  /** Epoch ms the whole probe must be done by (`--max-duration`, #1271); each attempt is cut to what is left. */
  budgetDeadlineAt?: number
): Promise<ReachabilityResult> {
  const deadline = Math.min(
    Date.now() + REACHABILITY_TOTAL_BUDGET_MS,
    budgetDeadlineAt ?? Number.POSITIVE_INFINITY
  );
  const attemptTimeout = (): number =>
    Math.max(1, Math.min(REACHABILITY_TIMEOUT_MS, deadline - Date.now()));
  let result = await attemptReachability(
    url,
    scope,
    requestScoped,
    attemptTimeout()
  );

  for (let attempt = 2; attempt <= REACHABILITY_MAX_ATTEMPTS; attempt++) {
    if (result.reachable || !isTransientReachabilityError(result.error)) break;
    const delay = REACHABILITY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 2);
    if (Date.now() + delay >= deadline) break;
    logger.debug(
      "reachability retry",
      redactUrl(url),
      `attempt ${attempt}`,
      redactUrlsInText(result.error ?? "")
    );
    await sleep(delay);
    result = await attemptReachability(
      url,
      scope,
      requestScoped,
      attemptTimeout()
    );
  }

  return result;
}

async function attemptReachability(
  url: string,
  scope: ReachabilityScope | undefined,
  requestScoped: typeof requestOnceScoped,
  timeoutMs: number = REACHABILITY_TIMEOUT_MS
): Promise<ReachabilityResult> {
  // Fast path for localhost/loopback using native fetch (no WAF detection needed)
  let isLocalhost = false;
  try {
    const parsed = new URL(url);
    isLocalhost =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
  } catch {
    // Invalid URL - will be caught later
    isLocalhost = false;
  }
  if (isLocalhost) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("Connection timed out"),
      timeoutMs
    );
    try {
      // Undecoded (#2717): Bun inflates a Content-Encoding body in full even
      // when it is cancelled unread, as this one is.
      const send = reachabilitySend(url, scope);
      const response = send
        ? await send(url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          })
        : await fetchUndecoded(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
          });
      await response.body?.cancel().catch(() => {});
      return { reachable: true, statusCode: response.status };
    } catch (error) {
      // --offline (#819): the start URL answered with a redirect to another
      // site, which is not followed. It is reachable; the crawl records the
      // redirect.
      if (
        error instanceof EgressRefusedError &&
        error.message === EGRESS_OFF_SITE_REFUSAL
      ) {
        return { reachable: true, statusCode: OFF_SITE_REDIRECT_STATUS };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        reachable: false,
        error:
          error instanceof EgressRefusedError
            ? EGRESS_REFUSED_REACHABILITY
            : message,
      };
    } finally {
      clearTimeout(timeout);
      // Closes the connection (#766): the cancelled body does not, Bun keeps
      // downloading it until the signal aborts.
      controller.abort();
    }
  }

  try {
    // Use the request utility with browser-like headers
    logger.debug("reachability check", redactUrl(url));

    // The deadline stays armed through the body sample, so a server that
    // sends headers and then stalls cannot park the probe (#192).
    const outcome = await Effect.runPromise(
      requestScoped(
        url,
        { method: "GET" },
        async (res) => {
          // Server responded - site is reachable
          // We accept any status code here since even 404/500 means the server is up
          // The actual crawl will handle HTTP errors appropriately

          // Detect WAF/bot protection from response headers and optional body sample.
          // Body checks improve detection for challenge/interstitial pages.
          let bodySample: string | undefined;
          const contentType =
            res.headers.get("content-type")?.toLowerCase() ?? "";
          if (contentType.includes("text/html") || res.status === 403) {
            try {
              bodySample = await readBodySample(
                res,
                REACHABILITY_BODY_SAMPLE_BYTES,
                REACHABILITY_BODY_SAMPLE_TIMEOUT_MS
              );
            } catch {
              bodySample = undefined;
            }
          } else {
            await res.body?.cancel().catch(() => {});
          }
          return {
            status: res.status,
            wafResult: detectWaf(res.headers, bodySample),
          };
        },
        // Shorter than the crawl timeout
        timeoutMs,
        reachabilitySend(url, scope)
      ).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () =>
            new RequestError({
              url,
              message: "Connection timed out",
            }),
        }),
        Effect.either
      )
    );

    // Keep typed request failures inside the Effect value. `runPromise` wraps
    // failures in a FiberFailure, which would hide RequestError from the
    // handling below (notably the deliberate offline off-site redirect case).
    if (outcome._tag === "Left") {
      const error = outcome.left;
      if (error.message === EGRESS_OFF_SITE_REFUSAL) {
        return { reachable: true, statusCode: OFF_SITE_REDIRECT_STATUS };
      }
      return {
        reachable: false,
        // Every EgressRefusedError message starts with "refused" (nothing was sent).
        error: /^refused\b/.test(error.message)
          ? EGRESS_REFUSED_REACHABILITY
          : error.message,
      };
    }

    const response = outcome.right;
    const wafResult = response.wafResult;

    return {
      reachable: true,
      statusCode: response.status,
      wafDetected: wafResult.detected,
      wafProvider: wafResult.provider ?? undefined,
    };
  } catch (error) {
    const err = error as Error;
    const message = (err.message ?? "").toLowerCase();

    if (message.includes("getaddrinfo") || message.includes("dns")) {
      return {
        reachable: false,
        error: "DNS lookup failed - domain may not exist",
      };
    }

    if (
      message.includes("econnrefused") ||
      message.includes("connection refused")
    ) {
      return {
        reachable: false,
        error: "Connection refused - server may be down",
      };
    }

    if (message.includes("enotfound")) {
      return {
        reachable: false,
        error: "Host not found",
      };
    }

    if (
      message.includes("certificate") ||
      message.includes("ssl") ||
      message.includes("tls")
    ) {
      return {
        reachable: false,
        error: "SSL/TLS error - certificate issue",
      };
    }

    return {
      reachable: false,
      error: err.message,
    };
  }
}
