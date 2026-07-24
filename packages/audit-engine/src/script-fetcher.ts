// Script content fetcher for security scanning
// Fetches actual JS content for secrets detection

import { Effect } from "effect";

import { SCRIPT_FETCH_LIMITS, SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import type { FetchBudget, FetchOutcome } from "./fetch-budget";

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
  /**
   * #1252: shared tarpit-aware budget (same object as the resource checker's, so
   * scripts + assets share ONE budget). Skips a script before its fetch once the
   * budget is spent or its host is tarpitting. Absent (CLI) → fetch as today.
   */
  budget?: FetchBudget;
}

const DEFAULT_OPTIONS: ScriptFetcherOptions = {
  concurrency: SCRIPT_FETCH_LIMITS.FETCH_CONCURRENCY,
  timeoutMs: SCRIPT_FETCH_LIMITS.FETCH_TIMEOUT_MS,
  userAgent: SQUIRRELSCAN_USER_AGENT,
  maxScripts: SCRIPT_FETCH_LIMITS.MAX_SCRIPTS_TO_FETCH,
  maxSizeBytes: SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES,
};

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

async function fetchSingleScriptAsync(
  url: string,
  options: ScriptFetcherOptions,
  retryCount = 0
): Promise<ScriptFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  const defaultResult: ScriptFetchResult = {
    url,
    status: null,
    error: null,
    contentType: null,
    sizeBytes: null,
    content: null,
    redirected: false,
    finalUrl: undefined,
  };

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent,
        Accept: "application/javascript, text/javascript, */*",
        ...options.customHeaders,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength
      ? Number.parseInt(contentLength, 10)
      : null;

    const sourceMapHeader =
      response.headers.get("sourcemap") ||
      response.headers.get("x-sourcemap") ||
      undefined;

    const wasRedirected = response.redirected;
    const finalUrl = wasRedirected ? response.url : undefined;

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
        error: `HTTP ${response.status}`,
      };
    }

    if (!isJavaScriptContentType(contentType)) {
      return {
        ...defaultResult,
        status: response.status,
        contentType,
        redirected: wasRedirected,
        finalUrl,
        sourceMapHeader,
        error: "not javascript",
      };
    }

    const text = await response.text();
    const sizeBytes = new TextEncoder().encode(text).length;

    if (
      sizeBytes >
      (options.maxSizeBytes ?? SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES)
    ) {
      return {
        ...defaultResult,
        status: response.status,
        contentType,
        sizeBytes,
        redirected: wasRedirected,
        finalUrl,
        sourceMapHeader,
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
    };
  } catch (error) {
    clearTimeout(timeoutId);

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
      return { ...defaultResult, error: "timeout" };
    }
    return { ...defaultResult, error: (error as Error).message || "error" };
  }
}

/** Map a completed script fetch to a tarpit outcome — any error (incl. timeout) strikes. */
function scriptOutcome(result: ScriptFetchResult): FetchOutcome {
  if (result.error === "timeout") return "timeout";
  if (result.error != null) return "error";
  return "ok";
}

function fetchSingleScript(
  url: string,
  options: ScriptFetcherOptions
): Effect.Effect<ScriptFetchResult, never, never> {
  // No caching in package version — CLI wraps with content-store caching
  return Effect.promise(async () => {
    // #1252: skip before launching once the budget is spent or the host tarpits.
    if (options.budget?.shouldSkip(url)) {
      return {
        url,
        status: null,
        error: "skipped",
        contentType: null,
        sizeBytes: null,
        content: null,
        redirected: false,
        finalUrl: undefined,
      } satisfies ScriptFetchResult;
    }
    const startedAt = Date.now();
    const result = await fetchSingleScriptAsync(url, options);
    options.budget?.record(url, Date.now() - startedAt, scriptOutcome(result));
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

    const dynamicLimit = calculateScriptLimit(
      opts.pageCount,
      opts.maxScripts ?? SCRIPT_FETCH_LIMITS.MAX_SCRIPTS_TO_FETCH
    );
    const limitedUrls =
      uniqueUrls.length > dynamicLimit
        ? uniqueUrls.slice(0, dynamicLimit)
        : uniqueUrls;

    const fetches = limitedUrls.map((url) => fetchSingleScript(url, opts));

    return yield* Effect.all(fetches, { concurrency: opts.concurrency });
  });
}
