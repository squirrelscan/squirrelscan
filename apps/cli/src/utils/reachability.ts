// Simple reachability check for URLs
// Uses request tool with browser-like headers
// Detects WAF/bot protection on target site

import { Effect, Duration } from "effect";

import { requestOnce, RequestError } from "@/tools/request";
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
  const body = response.body;
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

/**
 * Check if a URL is reachable
 * Uses browser-like headers for WAF compatibility
 * Detects WAF/bot protection on target site
 *
 * Transient failures are retried with a short backoff (see
 * isTransientReachabilityError); definitive ones fail on the first attempt.
 */
export async function checkReachability(
  url: string
): Promise<ReachabilityResult> {
  const deadline = Date.now() + REACHABILITY_TOTAL_BUDGET_MS;
  let result = await attemptReachability(url);

  for (let attempt = 2; attempt <= REACHABILITY_MAX_ATTEMPTS; attempt++) {
    if (result.reachable || !isTransientReachabilityError(result.error)) break;
    const delay = REACHABILITY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 2);
    if (Date.now() + delay >= deadline) break;
    logger.debug(
      "reachability retry",
      url,
      `attempt ${attempt}`,
      result.error ?? ""
    );
    await sleep(delay);
    result = await attemptReachability(url);
  }

  return result;
}

async function attemptReachability(url: string): Promise<ReachabilityResult> {
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
      REACHABILITY_TIMEOUT_MS
    );
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
      return { reachable: true, statusCode: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { reachable: false, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    // Use the request utility with browser-like headers
    logger.debug("reachability check", url);

    const response = await Effect.runPromise(
      requestOnce(url, { method: "GET" }).pipe(
        // Override timeout for reachability (shorter than crawl timeout)
        Effect.timeoutFail({
          duration: Duration.millis(REACHABILITY_TIMEOUT_MS),
          onTimeout: () =>
            new RequestError({
              url,
              message: "Connection timed out",
            }),
        })
      )
    );

    // Server responded - site is reachable
    // We accept any status code here since even 404/500 means the server is up
    // The actual crawl will handle HTTP errors appropriately

    // Detect WAF/bot protection from response headers and optional body sample.
    // Body checks improve detection for challenge/interstitial pages.
    let bodySample: string | undefined;
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || response.status === 403) {
      try {
        bodySample = await readBodySample(
          response,
          REACHABILITY_BODY_SAMPLE_BYTES,
          REACHABILITY_BODY_SAMPLE_TIMEOUT_MS
        );
      } catch {
        bodySample = undefined;
      }
    }
    const wafResult = detectWaf(response.headers, bodySample);

    return {
      reachable: true,
      statusCode: response.status,
      wafDetected: wafResult.detected,
      wafProvider: wafResult.provider ?? undefined,
    };
  } catch (error) {
    // Handle RequestError from request utility
    if (error instanceof RequestError) {
      return {
        reachable: false,
        error: error.message,
      };
    }

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
