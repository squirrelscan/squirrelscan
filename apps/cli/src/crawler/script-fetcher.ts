// Script content fetcher for security scanning
// Fetches actual JS content for secrets detection

import { Effect } from "effect";

import { SCRIPT_FETCH_LIMITS, SQUIRRELSCAN_USER_AGENT } from "@/constants";
import {
  getGlobalContentStore,
  hashContent,
} from "@/crawler/storage/content-store";

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
  /** SourceMap or X-SourceMap response header value, if present */
  sourceMapHeader?: string;
}

export interface ScriptFetcherOptions {
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  maxScripts?: number;
  maxSizeBytes?: number;
  pageCount?: number; // For dynamic script limit calculation
}

const DEFAULT_OPTIONS: ScriptFetcherOptions = {
  concurrency: SCRIPT_FETCH_LIMITS.FETCH_CONCURRENCY,
  timeoutMs: SCRIPT_FETCH_LIMITS.FETCH_TIMEOUT_MS,
  userAgent: SQUIRRELSCAN_USER_AGENT,
  maxScripts: SCRIPT_FETCH_LIMITS.MAX_SCRIPTS_TO_FETCH,
  maxSizeBytes: SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES,
};

/**
 * Calculate dynamic script limit based on page count.
 * 10% of pages, minimum 10, maximum defaultLimit.
 */
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
    // Single GET request with redirect: follow (removed unnecessary HEAD request)
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent,
        Accept: "application/javascript, text/javascript, */*",
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

    // Capture SourceMap header (both standard and X- prefix)
    const sourceMapHeader =
      response.headers.get("sourcemap") ||
      response.headers.get("x-sourcemap") ||
      undefined;

    // Track redirect info from the response
    const wasRedirected = response.redirected;
    const finalUrl = wasRedirected ? response.url : undefined;

    // Check if response is too large before downloading body
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

    // Only fetch content for successful JS responses
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

    // Validate content type
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

    // Fetch the content
    const text = await response.text();
    const sizeBytes = new TextEncoder().encode(text).length;

    // Check size after download (in case Content-Length was missing)
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

    // Retry on transient errors
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

function fetchSingleScript(
  url: string,
  options: ScriptFetcherOptions
): Effect.Effect<ScriptFetchResult, never, never> {
  return Effect.gen(function* () {
    const store = getGlobalContentStore();
    const cacheKey = hashContent(url);

    // Check cache first
    const cached = store.getString(cacheKey);
    if (cached !== null) {
      const sizeBytes = new TextEncoder().encode(cached).length;
      return {
        url,
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes,
        content: cached,
        redirected: false,
        finalUrl: undefined,
        fromCache: true,
      } satisfies ScriptFetchResult;
    }

    // Fetch from network
    const result = yield* Effect.promise(() =>
      fetchSingleScriptAsync(url, options)
    );

    // Cache successful fetches with content
    if (result.content !== null && result.error === null) {
      store.put(result.content, "application/javascript");
    }

    return result;
  });
}

/**
 * Fetch JavaScript file contents for security scanning.
 * Returns content for each script that can be scanned for secrets.
 */
export function fetchScriptContents(
  urls: string[],
  options?: Partial<ScriptFetcherOptions>
): Effect.Effect<ScriptFetchResult[], never, never> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.concurrency = Math.max(1, opts.concurrency);

  return Effect.gen(function* () {
    if (urls.length === 0) return [];

    const uniqueUrls = [...new Set(urls)];

    // Apply dynamic limit based on page count (10% of pages, min 10, max configured)
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
