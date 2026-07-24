import type { RedirectChain } from "@squirrelscan/core-contracts";

export interface FetcherCapabilities {
  jsRendering: boolean;
  cookies: boolean;
  screenshot: boolean;
}

export interface FetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  followRedirects?: boolean;
  /**
   * Caller cancellation signal. Combined with the fetcher's own per-request
   * timeout. The crawler wires this to the per-URL watchdog so a wedged fetch
   * (e.g. a cloud render that never returns) is actually aborted — letting the
   * fiber release its host-scheduler slot instead of leaking it and deadlocking
   * the crawl. Fetchers MUST honor it.
   */
  signal?: AbortSignal;
  /**
   * sha256 of the NORMALIZED raw source of the stored copy of this URL, when one
   * exists (#839). Read only by the conditional-render gate: if a cheap probe's
   * normalized source hashes to this value the stored render is reused instead of
   * re-rendered. Its presence also signals "a stored page exists", so the gate
   * probes even when the request carries no If-None-Match / If-Modified-Since.
   * Ignored by every other fetcher.
   */
  storedSourceHash?: string;
}

export interface FetchTiming {
  startedAt: number;
  responseAt: number;
  finishedAt: number;
}

export interface FetchResponse {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  timing: FetchTiming;
  redirectChain: RedirectChain;
  /** Which fetcher/egress produced this response (e.g. "cloud-render", "fetch", "browser"). */
  fetcherMethod?: string;
  /** Why this response came from a fallback path, when it did (e.g. "render-block"). */
  fallbackReason?: string;
  /**
   * sha256 of the normalized raw source computed by the conditional-render gate
   * from its probe (#839). Set only when the gate rendered after probing, so the
   * crawler can persist it as the page's `source_hash` for next-run reuse. Absent
   * on every direct (unprobed) fetch.
   */
  sourceHash?: string;
  /**
   * Browser render cost only (page.goto + content + link extraction), as
   * measured server-side by crawler-worker — set only by the browser-queue
   * fetcher (#826). Absent for every non-rendered fetch.
   */
  renderTimeMs?: number;
  /**
   * Queue delivery lag + browser-pool acquisition + concurrency-slot wait
   * before rendering started, derived server-side as totalMs - renderTimeMs
   * (#826). Absent for every non-rendered fetch.
   */
  queueWaitMs?: number;
}

export interface DocumentFetcher {
  id: string;
  capabilities: FetcherCapabilities;
  fetch(req: FetchRequest): Promise<FetchResponse>;
}

export interface BrowserQueueFetcherConfig {
  serviceUrl: string;
  apiKey?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  runId?: string;
  userId?: string;
  crawlId?: string;
  apiBaseUrl?: string;
}

interface RenderJobCreateResponse {
  jobId: string;
}

interface RenderJobStatusResponse {
  status: "pending" | "running" | "completed" | "failed";
  result?: {
    sourceUrl: string;
    finalUrl: string;
    status: number;
    headers: Record<string, string>;
    body: string;
    redirectChain?: RedirectChain;
    startedAt: number;
    responseAt: number;
    finishedAt: number;
    /** Mirrors crawler-worker's RenderJobStatusPayload.result (#826). */
    renderTimeMs?: number;
    queueWaitMs?: number;
  };
  error?: string;
}

// Unlike every other header, repeated Set-Cookie headers are NOT combined by
// the Headers object at insertion time (cookies can't be safely comma-joined —
// Expires values contain their own commas — so the Fetch spec keeps them
// separate). That means `forEach` fires once per Set-Cookie header, and a
// naive `result[key] = value` assignment overwrites on each call, silently
// keeping only the LAST cookie a page sets (squirrelscan/repo#973).
// `getSetCookie()` returns the exact array of Set-Cookie values kept separate
// by the Headers object, so we join them with "\n" — a delimiter that can't
// appear in a header value — instead of the ", " that `.get()` would use,
// which is ambiguous with the comma inside a cookie's own
// `Expires=Wed, 09 Jun 2021...` attribute. Downstream cookie parsing
// (packages/rules/src/security/cookie-flags.ts) splits back into individual
// cookies on this exact separator, and the cloud render path
// (apps/crawler-worker/src/index.ts) produces the same shape.
function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    result[key.toLowerCase()] = value;
  });
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) result["set-cookie"] = setCookies.join("\n");
  return result;
}

// Bun throws "BrotliDecompressionError"/"ZlibError" when a server lies about (or truncates) its encoding.
function isDecompressionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("DecompressionError") || error.message.includes("ZlibError"))
  );
}

// Fetch tolerant of a bad Content-Encoding: on decompress failure, refetch raw (identity) so the page isn't dropped #292.
async function fetchTolerant(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!isDecompressionError(error)) throw error;
    // `decompress: false` is a Bun fetch option returning the undecoded bytes.
    return await fetch(url, { ...init, decompress: false } as RequestInit);
  }
}

export function createFetchDocumentFetcher(): DocumentFetcher {
  return {
    id: "fetch",
    capabilities: {
      jsRendering: false,
      cookies: true,
      screenshot: false,
    },
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutMs = req.timeoutMs ?? 30000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      // Honor the caller's cancellation signal alongside our own timeout, so an
      // interrupted crawl (per-URL watchdog / stop) actually aborts the fetch.
      const signal = req.signal
        ? AbortSignal.any([controller.signal, req.signal])
        : controller.signal;

      const sourceUrl = req.url;
      let currentUrl = sourceUrl;
      let responseAt = startedAt;
      let finishedAt = startedAt;

      const hops: RedirectChain["hops"] = [];
      const visited = new Set<string>();
      let isLoop = false;
      let endsInError = false;

      let finalStatus = 0;
      let finalHeaders: Headers | null = null;
      let finalBody = "";

      const followRedirects = req.followRedirects ?? true;

      try {
        for (let i = 0; i < 10; i++) {
          if (visited.has(currentUrl)) {
            isLoop = true;
            endsInError = true;
            break;
          }
          visited.add(currentUrl);

          const requestInit: RequestInit = {
            method: req.method ?? "GET",
            headers: req.headers,
            redirect: "manual",
            signal,
          };
          const response = await fetchTolerant(currentUrl, requestInit);

          responseAt = Date.now();
          finalStatus = response.status;
          finalHeaders = response.headers;
          hops.push({
            url: currentUrl,
            statusCode: response.status,
            type: "http",
          });

          if (followRedirects && response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
              endsInError = true;
              break;
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }

          if (response.status >= 400) {
            endsInError = true;
          }

          try {
            finalBody = await response.text();
          } catch (error) {
            // Body-time decode failure (large/streamed bodies) — recover the raw body, else keep an empty page.
            if (!isDecompressionError(error)) throw error;
            try {
              const raw = await fetch(currentUrl, {
                ...requestInit,
                decompress: false,
              } as RequestInit);
              finalBody = await raw.text();
            } catch {
              finalBody = "";
            }
          }
          finishedAt = Date.now();
          break;
        }
      } finally {
        clearTimeout(timeout);
      }

      if (!finalHeaders) {
        throw new Error(`Failed to fetch ${req.url}`);
      }

      if (finishedAt < responseAt) {
        finishedAt = Date.now();
      }

      let httpsToHttp = false;
      let httpToHttps = false;
      for (let i = 0; i < hops.length - 1; i++) {
        const from = hops[i]?.url ?? "";
        const to = hops[i + 1]?.url ?? "";
        if (from.startsWith("https://") && to.startsWith("http://")) {
          httpsToHttp = true;
        }
        if (from.startsWith("http://") && to.startsWith("https://")) {
          httpToHttps = true;
        }
      }

      const redirectChain: RedirectChain = {
        sourceUrl,
        finalUrl: currentUrl,
        hops,
        chainLength: Math.max(0, hops.length - 1),
        isLoop,
        endsInError,
        httpsToHttp,
        httpToHttps,
      };

      return {
        url: sourceUrl,
        finalUrl: currentUrl,
        status: finalStatus,
        headers: headersToRecord(finalHeaders),
        body: finalBody,
        timing: {
          startedAt,
          responseAt,
          finishedAt,
        },
        redirectChain,
        fetcherMethod: "fetch",
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timed out after");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), boundedTimeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function parseJsonWithTimeout<T>(
  response: Response,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  return await withTimeout(
    response.json() as Promise<T>,
    boundedTimeoutMs,
    `${label} response timed out after ${boundedTimeoutMs}ms`,
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${boundedTimeoutMs}ms`));
    }, boundedTimeoutMs);
  });

  // Combine the caller's cancellation signal (if any) with our timeout signal
  // so an interrupted crawl aborts in-flight render-job requests promptly.
  const { signal: callerSignal, ...restInit } = init;
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;

  try {
    const response = await Promise.race([
      fetch(url, {
        ...restInit,
        signal,
      }),
      timeoutPromise,
    ]);
    return response as Response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${boundedTimeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createBrowserQueueDocumentFetcher(
  config: BrowserQueueFetcherConfig,
): DocumentFetcher {
  const serviceUrl = config.serviceUrl.replace(/\/$/, "");
  const pollIntervalMs = config.pollIntervalMs ?? 800;
  const defaultTimeoutMs = config.timeoutMs ?? 90_000;

  return {
    id: "browser-queue",
    capabilities: {
      jsRendering: true,
      cookies: true,
      screenshot: false,
    },
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      const startedAt = Date.now();
      // Cap to the browser queue's own configured timeout — callers (e.g. the
      // crawler) may pass a longer timeoutMs that isn't appropriate for a
      // render-job polling loop.
      const overallTimeoutMs = Math.max(
        1,
        Math.min(req.timeoutMs ?? defaultTimeoutMs, defaultTimeoutMs),
      );
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const remainingMs = (): number => Math.max(0, overallTimeoutMs - (Date.now() - startedAt));
      const boundedRequestTimeoutMs = (capMs: number): number =>
        Math.max(1, Math.min(capMs, remainingMs()));

      const createResponse = await fetchWithTimeout(
        `${serviceUrl}/internal/render-jobs`,
        {
          method: "POST",
          headers,
          signal: req.signal,
          body: JSON.stringify({
            url: req.url,
            runId: config.runId,
            userId: config.userId,
            crawlId: config.crawlId,
            apiBaseUrl: config.apiBaseUrl,
            method: req.method ?? "GET",
            headers: req.headers ?? {},
            timeoutMs: req.timeoutMs ?? defaultTimeoutMs,
            followRedirects: req.followRedirects ?? true,
          }),
        },
        boundedRequestTimeoutMs(10_000),
      );

      if (!createResponse.ok) {
        throw new Error(`Failed to enqueue browser render job (${createResponse.status})`);
      }

      const createData = await parseJsonWithTimeout<RenderJobCreateResponse>(
        createResponse,
        boundedRequestTimeoutMs(5_000),
        "Render job enqueue",
      );
      if (!createData.jobId) {
        throw new Error("Browser render enqueue response missing jobId");
      }

      while (remainingMs() > 0) {
        if (req.signal?.aborted) {
          throw new Error("Browser render job aborted");
        }
        let statusData: RenderJobStatusResponse;
        try {
          const statusResponse = await fetchWithTimeout(
            `${serviceUrl}/internal/render-jobs/${createData.jobId}`,
            { headers, signal: req.signal },
            boundedRequestTimeoutMs(8_000),
          );
          if (!statusResponse.ok) {
            throw new Error(`Failed to read browser render job (${statusResponse.status})`);
          }

          statusData = await parseJsonWithTimeout<RenderJobStatusResponse>(
            statusResponse,
            boundedRequestTimeoutMs(2_000),
            "Render job status",
          );
        } catch (error) {
          if (isTimeoutError(error)) {
            if (remainingMs() <= 0) {
              break;
            }
            await sleep(Math.max(1, Math.min(pollIntervalMs, remainingMs())));
            continue;
          }
          throw error;
        }

        if (statusData.status === "failed") {
          throw new Error(statusData.error ?? "Browser render job failed");
        }
        if (statusData.status === "completed" && statusData.result) {
          return {
            url: statusData.result.sourceUrl,
            finalUrl: statusData.result.finalUrl,
            status: statusData.result.status,
            headers: statusData.result.headers,
            body: statusData.result.body,
            redirectChain: statusData.result.redirectChain ?? {
              sourceUrl: statusData.result.sourceUrl,
              finalUrl: statusData.result.finalUrl,
              hops: [
                {
                  url: statusData.result.sourceUrl,
                  statusCode: statusData.result.status,
                  type: "http",
                },
              ],
              chainLength: 0,
              isLoop: false,
              endsInError: statusData.result.status >= 400,
              httpsToHttp: false,
              httpToHttps: false,
            },
            timing: {
              startedAt: statusData.result.startedAt,
              responseAt: statusData.result.responseAt,
              finishedAt: statusData.result.finishedAt,
            },
            renderTimeMs: statusData.result.renderTimeMs,
            queueWaitMs: statusData.result.queueWaitMs,
          };
        }

        await sleep(Math.max(1, Math.min(pollIntervalMs, remainingMs())));
      }

      throw new Error("Browser render job timed out");
    },
  };
}

// HTTP-first hybrid + CSR-shell detection (#294) — shared by CLI and the cloud
// container so both honor render mode "auto" the same way.
export {
  CSR_MIN_SCRIPTS_WHEN_SPARSE,
  CSR_MIN_VISIBLE_TEXT_CHARS,
  extractVisibleText,
  looksClientRendered,
} from "./csr-detect";
export { createHybridDocumentFetcher, defaultShouldUpgrade } from "./hybrid";
export type { HybridFetcherOptions } from "./hybrid";
// Conditional-GET gate in front of a render fetcher — reuse cached renders on
// 304 instead of re-rendering unchanged pages every re-run (#821).
export { createConditionalRenderDocumentFetcher } from "./conditional-render";
export type { ConditionalRenderFetcherOptions } from "./conditional-render";
