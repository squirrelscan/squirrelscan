// Script content fetcher for security scanning
// Fetches actual JS content for secrets detection

import { Effect } from "effect";

import {
  ASSET_FETCH_REFUSED_ERROR,
  ASSET_FETCH_SKIPPED_ERROR,
  SCRIPT_FETCH_LIMITS,
  SQUIRRELSCAN_USER_AGENT,
} from "@squirrelscan/utils/constants";
import {
  EgressRefusedError,
  egressGuardedSend,
  type EgressPolicy,
} from "@squirrelscan/utils/public-egress";
import { fetchUndecoded, readBodyCapped } from "@squirrelscan/utils/response-body";
import { isHttpOrHttpsUrl, safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";
import type { FetchBudget, FetchOutcome } from "./fetch-budget";
import { customHeadersFor, type HeaderScope } from "./lib/header-scope";
import { rateLimitedFlag, wafBlockedFlag } from "./lib/asset-status";
import { normalizeEncoding } from "./resource-checker";
import { mergeHeaderRecords } from "@squirrelscan/utils/headers";

export interface ScriptFetchResult {
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  content: string | null;
  redirected?: boolean;
  finalUrl?: string;
  fromCache?: boolean;
  sourceMapHeader?: string;
  /**
   * content-encoding observed on this fetch: a transfer coding or `null` for
   * identity/absent. Absent (`undefined`) when no response was seen. (#9)
   */
  contentEncoding?: string | null;
  /** Throttled by the origin (429/430, or 503 with Retry-After) (#703). */
  rateLimited?: boolean;
  /** A WAF or bot challenge answered in place of the script (#703). */
  wafBlocked?: boolean;
  /** Never requested: the `maxTotalBytes` or `totalTimeoutMs` bound was reached (#1255). */
  fetchSkipReason?: "memory-cap" | "time-budget";
}

export interface ScriptFetcherOptions {
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  maxScripts?: number;
  maxSizeBytes?: number;
  pageCount?: number;
  /** Custom HTTP request headers attached to every script fetch (#494). Secret values — never logged. */
  customHeaders?: Record<string, string>;
  /** Hosts that get `customHeaders` (#732); absent: every request does. */
  headerScope?: HeaderScope;
  /**
   * #1252: shared tarpit-aware budget (same object as the resource checker's, so
   * scripts + assets share ONE budget). Skips a script before its fetch once the
   * budget is spent or its host is tarpitting. Absent (CLI) → fetch as today.
   */
  budget?: FetchBudget;
  /**
   * #710: keep the body of a non-JavaScript response too. The web app manifest
   * is fetched through this path and is JSON, which the JS-only gate would drop.
   * Default false, so every script caller keeps its gate.
   */
  anyContentType?: boolean;
  /**
   * Fetch up to `maxScripts` scripts, not the share of the page count the audit
   * normally allows (at least 10, 10% of the pages, at most 50). Set when
   * `[storage] store_scripts` asks for every bundle (#1255).
   */
  fetchAll?: boolean;
  /**
   * Stop requesting once the bodies fetched so far total this many decoded
   * bytes (#1255): they are all held for the rules phase, so storing hundreds of
   * bundles must not grow memory with their count. A skipped script reads as
   * unrequested, with `fetchSkipReason` "memory-cap". Absent: no bound.
   */
  maxTotalBytes?: number;
  /** Stop requesting this long after the first request (`fetchSkipReason` "time-budget"). Absent: no bound. */
  totalTimeoutMs?: number;
  /**
   * Every hop is vetted against this policy before it is sent (see
   * `@squirrelscan/utils/public-egress`); a refused one is never requested and
   * reads as ASSET_FETCH_REFUSED_ERROR. Absent: hosts are unrestricted.
   */
  egress?: EgressPolicy;
}

const DEFAULT_OPTIONS: ScriptFetcherOptions = {
  concurrency: SCRIPT_FETCH_LIMITS.FETCH_CONCURRENCY,
  timeoutMs: SCRIPT_FETCH_LIMITS.FETCH_TIMEOUT_MS,
  userAgent: SQUIRRELSCAN_USER_AGENT,
  maxScripts: SCRIPT_FETCH_LIMITS.MAX_SCRIPTS_TO_FETCH,
  maxSizeBytes: SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES,
};

/**
 * How many scripts the script rules evaluate for an audit of `pageCount` pages:
 * what an audit fetches when it is not storing scripts (#1280). A run that
 * stores scripts fetches more, but only this many go to the rules.
 */
export function scriptRuleLimit(pageCount: number | undefined, maxScripts?: number): number {
  return calculateScriptLimit(pageCount, maxScripts ?? SCRIPT_FETCH_LIMITS.MAX_SCRIPTS_TO_FETCH);
}

function calculateScriptLimit(
  pageCount: number | undefined,
  defaultLimit: number
): number {
  if (!pageCount) return defaultLimit;
  return Math.min(defaultLimit, Math.max(10, Math.ceil(pageCount * 0.1)));
}

function isJavaScriptContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.includes("javascript") ||
    lower.includes("ecmascript") ||
    lower.includes("application/x-js")
  );
}

function emptyScriptResult(url: string): ScriptFetchResult {
  return {
    url,
    status: null,
    error: null,
    contentType: null,
    sizeBytes: null,
    content: null,
    redirected: false,
    finalUrl: undefined,
  };
}

/**
 * One attempt, under a deadline that stays armed until the body has been read
 * (#1729). Clearing the timer where the response resolves disarms the abort at
 * the HEADERS, and `readBodyCapped` below caps BYTES rather than seconds, so a
 * script origin that answers 200 and then trickles or stalls its body would
 * park the audit forever. Scripts are fetched during rules enrichment, after
 * the crawl, so that shows up as an audit that has its pages and never finishes.
 */
async function fetchScriptAttempt(
  url: string,
  options: ScriptFetcherOptions
): Promise<ScriptFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  const defaultResult = emptyScriptResult(url);

  try {
    // #1395: follow redirects manually so per hop the http/https scheme
    // allowlist applies and secret customHeaders are stripped on a cross-origin
    // redirect (native redirect:"follow" replays them; a Location: file:// would
    // otherwise be fetched and its content scanned/captured).
    const {
      response,
      finalUrl: resolvedFinalUrl,
      redirected,
    } = await safeRedirectFetch(
      url,
      {
        method: "GET",
        headers: mergeHeaderRecords(
          { "User-Agent": options.userAgent, Accept: "application/javascript, text/javascript, */*" },
          customHeadersFor(url, options.customHeaders, options.headerScope),
        ),
        signal: controller.signal,
      },
      // #2717: undecoded on every hop; readBodyCapped decodes within its cap.
      options.egress ? egressGuardedSend(fetchUndecoded, options.egress) : fetchUndecoded
    );

    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength
      ? Number.parseInt(contentLength, 10)
      : null;

    const sourceMapHeader =
      response.headers.get("sourcemap") ||
      response.headers.get("x-sourcemap") ||
      undefined;

    // #9: a transfer coding (gzip/br/…) or null for identity/absent. The body
    // is decoded as it is read but this header stays intact, so it remains
    // observable even though `sizeBytes` below measures the DECODED text.
    const contentEncoding = normalizeEncoding(
      response.headers.get("content-encoding")
    );

    const wasRedirected = redirected;
    const finalUrl = wasRedirected ? resolvedFinalUrl : undefined;

    if (
      declaredSize &&
      declaredSize >
        (options.maxSizeBytes ?? SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES)
    ) {
      return {
        ...defaultResult,
        status: response.status,
        contentType,
        sizeBytes: declaredSize,
        redirected: wasRedirected,
        finalUrl,
        sourceMapHeader,
        contentEncoding,
        error: "script too large",
      };
    }

    if (!response.ok) {
      return {
        ...defaultResult,
        status: response.status,
        contentType,
        redirected: wasRedirected,
        finalUrl,
        sourceMapHeader,
        contentEncoding,
        error: `HTTP ${response.status}`,
        rateLimited: rateLimitedFlag(response.status, response.headers),
        wafBlocked: wafBlockedFlag(response.status, response.headers),
      };
    }

    if (!options.anyContentType && !isJavaScriptContentType(contentType)) {
      return {
        ...defaultResult,
        status: response.status,
        contentType,
        redirected: wasRedirected,
        finalUrl,
        sourceMapHeader,
        contentEncoding,
        error: "not javascript",
      };
    }

    const maxSizeBytes = options.maxSizeBytes ?? SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES;
    // Read one byte past the limit rather than the limit itself: the check below
    // rejects anything OVER the cap, so reading exactly `maxSizeBytes` would
    // truncate an oversized script to precisely the limit and the rejection
    // would never fire. At cap+1 an oversized body still trips it, while the
    // read stays bounded in BYTES — previously this was an unbounded `.text()`
    // whose size was only measured once the whole body was already in memory.
    // The bound in SECONDS is the still-armed deadline above, not this cap: a
    // body can sit under the cap and never arrive.
    const text = await readBodyCapped(response, maxSizeBytes + 1);
    const sizeBytes = new TextEncoder().encode(text).length;

    if (sizeBytes > maxSizeBytes) {
      return {
        ...defaultResult,
        status: response.status,
        contentType,
        sizeBytes,
        redirected: wasRedirected,
        finalUrl,
        sourceMapHeader,
        contentEncoding,
        error: "script too large",
      };
    }

    return {
      ...defaultResult,
      status: response.status,
      contentType,
      sizeBytes,
      content: text,
      redirected: wasRedirected,
      finalUrl,
      sourceMapHeader,
      contentEncoding,
    };
  } finally {
    clearTimeout(timeoutId);
    // Closes the connection (#766): a capped read stops reading, but Bun
    // keeps downloading the body until the signal aborts.
    controller.abort();
  }
}

async function fetchSingleScriptAsync(
  url: string,
  options: ScriptFetcherOptions,
  retryCount = 0
): Promise<ScriptFetchResult> {
  try {
    if (options.egress && !isHttpOrHttpsUrl(url)) {
      throw new EgressRefusedError("refused scheme");
    }
    return await fetchScriptAttempt(url, options);
  } catch (error) {
    // Refused by the egress policy: nothing was sent, and a retry is refused too.
    if (error instanceof EgressRefusedError) {
      return { ...emptyScriptResult(url), error: ASSET_FETCH_REFUSED_ERROR };
    }
    // Retries live outside the attempt so each one arms its own deadline; a
    // retry started inside the attempt's `finally` would inherit an expired
    // timer, or keep the spent one alive for the length of the retry.
    if (
      retryCount < SCRIPT_FETCH_LIMITS.MAX_RETRIES &&
      (error as Error).name !== "AbortError"
    ) {
      const delay =
        SCRIPT_FETCH_LIMITS.RETRY_DELAY_MS * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchSingleScriptAsync(url, options, retryCount + 1);
    }

    if ((error as Error).name === "AbortError") {
      return { ...emptyScriptResult(url), error: "timeout" };
    }
    return {
      ...emptyScriptResult(url),
      error: (error as Error).message || "error",
    };
  }
}

/**
 * Map a completed script fetch to a tarpit outcome — any error (incl. timeout)
 * strikes. A body kept whatever its type (the manifest pass, #710) has no
 * "not JavaScript" error, so there an HTTP answer is an answer, not a failing
 * host: a site whose linked manifests 404 is not a tarpit. Slow answers still
 * strike on their latency.
 */
function scriptOutcome(result: ScriptFetchResult, anyContentType = false): FetchOutcome {
  if (result.error === "timeout") return "timeout";
  if (anyContentType && result.status !== null && result.error?.startsWith("HTTP ")) return "ok";
  if (result.error != null) return "error";
  return "ok";
}

function fetchSingleScript(
  url: string,
  options: ScriptFetcherOptions
): Effect.Effect<ScriptFetchResult, never, never> {
  // No cache: every audit, and `squirrel analyze`, fetches its scripts afresh.
  return Effect.promise(async () => {
    // #1252: skip before launching once the budget is spent or the host tarpits.
    if (options.budget?.shouldSkip(url)) {
      return { ...emptyScriptResult(url), error: ASSET_FETCH_SKIPPED_ERROR };
    }
    const startedAt = Date.now();
    const result = await fetchSingleScriptAsync(url, options);
    // A refusal is an answer for the budget: only its latency strikes (see the
    // resource checker).
    const outcome =
      result.error === ASSET_FETCH_REFUSED_ERROR
        ? "ok"
        : scriptOutcome(result, options.anyContentType === true);
    options.budget?.record(url, Date.now() - startedAt, outcome);
    return result;
  });
}

export function fetchScriptContents(
  urls: string[],
  options?: Partial<ScriptFetcherOptions>
): Effect.Effect<ScriptFetchResult[], never, never> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.concurrency = Math.max(1, opts.concurrency);

  return Effect.gen(function* () {
    if (urls.length === 0) return [];

    const uniqueUrls = [...new Set(urls)];

    const configuredLimit =
      opts.maxScripts ?? SCRIPT_FETCH_LIMITS.MAX_SCRIPTS_TO_FETCH;
    const dynamicLimit = opts.fetchAll
      ? configuredLimit
      : calculateScriptLimit(opts.pageCount, configuredLimit);
    const limitedUrls =
      uniqueUrls.length > dynamicLimit
        ? uniqueUrls.slice(0, dynamicLimit)
        : uniqueUrls;

    const startedAt = Date.now();
    let heldBytes = 0;
    const fetches = limitedUrls.map((url) =>
      Effect.suspend(() => {
        // Checked as each fetch is about to start, so what is already in flight
        // (at most `concurrency` bodies) is the whole overshoot.
        if (opts.maxTotalBytes != null && heldBytes >= opts.maxTotalBytes) {
          return Effect.succeed<ScriptFetchResult>({
            ...emptyScriptResult(url),
            error: ASSET_FETCH_SKIPPED_ERROR,
            fetchSkipReason: "memory-cap",
          });
        }
        if (
          opts.totalTimeoutMs != null &&
          Date.now() - startedAt >= opts.totalTimeoutMs
        ) {
          return Effect.succeed<ScriptFetchResult>({
            ...emptyScriptResult(url),
            error: ASSET_FETCH_SKIPPED_ERROR,
            fetchSkipReason: "time-budget",
          });
        }
        return fetchSingleScript(url, opts).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              heldBytes += result.content?.length ?? 0;
            })
          )
        );
      })
    );

    return yield* Effect.all(fetches, { concurrency: opts.concurrency });
  });
}
