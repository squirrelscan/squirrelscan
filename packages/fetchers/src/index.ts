import type { RedirectChain } from "@squirrelscan/core-contracts";
import {
  DEFAULT_MAX_DOCUMENT_BODY_BYTES,
  fetchUndecoded,
  headersForRedirect,
  isDecompressionError,
  isHttpOrHttpsUrl,
  readBodyCapped,
} from "@squirrelscan/utils";
import {
  egressGuardedSend,
  egressRefuses,
  type EgressPolicy,
} from "@squirrelscan/utils/public-egress";

/**
 * Enforce the one invariant every redirect chain must satisfy: an HTTP hop that
 * is FOLLOWED by another hop redirected at the HTTP level, so a 2xx recorded
 * against it is not a status that hop can have returned — it belongs to some
 * other response, and in practice to the landing page. Downgrade it to `0`
 * ("no status observed for this hop") instead of passing it on.
 *
 * `javascript` and `meta-refresh` hops are left alone: a client-side redirect is
 * a document that loaded with 200 and THEN redirected, so 2xx is the correct
 * status there and carries real information.
 *
 * Applied at every producer that does not derive hops from responses it watched
 * itself, so no consumer can read a fabricated `200 → 200` as a redirect
 * (#1510). Producers that follow redirects by hand only ever append a hop after
 * seeing a 3xx, so they satisfy this by construction and do not need it.
 */
export function withObservedHopStatuses(hops: RedirectChain["hops"]): RedirectChain["hops"] {
  return hops.map((hop, i) =>
    i < hops.length - 1 &&
    hop.type === "http" &&
    hop.statusCode >= 200 &&
    hop.statusCode < 300
      ? { ...hop, statusCode: 0 }
      : hop,
  );
}

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
  /**
   * Egress policy for every REDIRECT hop (repo#2830): a redirect to a
   * link-local or cloud metadata address outside the crawl's hosts ends the
   * fetch at that hop, never requested. The URL asked for is not vetted.
   * Honored by the plain fetch fetcher, which runs on this machine; a render
   * fetcher's browser runs in the cloud, behind its egress proxy.
   */
  egress?: EgressPolicy;
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
// keeping only the LAST cookie a page sets.
// `getSetCookie()` returns the exact array of Set-Cookie values kept separate
// by the Headers object, so we join them with "\n" — a delimiter that can't
// appear in a header value — instead of the ", " that `.get()` would use,
// which is ambiguous with the comma inside a cookie's own
// `Expires=Wed, 09 Jun 2021...` attribute. Downstream cookie parsing
// (packages/rules/src/security/cookie-flags.ts) splits back into individual
// cookies on this exact separator; hosted rendering produces the same shape.
function headersToRecord(headers: Headers): Record<string, string> {
  // Object.create(null), NOT {}: header names are chosen by the audited site and
  // `__proto__` is a valid HTTP token, so `result["__proto__"] = value` on a
  // plain object hits the inherited setter and silently discards the header
  // instead of recording it — a header an audit is specifically meant to see.
  const result: Record<string, string> = Object.create(null);
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    result[key.toLowerCase()] = value;
  });
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) result["set-cookie"] = setCookies.join("\n");
  return result;
}

type Send = (url: string, init: RequestInit) => Promise<Response>;

// `decompress: false` is a Bun fetch option returning the undecoded bytes.
// Plain fetch, not fetchUndecoded, on purpose: the decode fallbacks read this
// body raw, as identity, which is their whole point.
const fetchRaw: Send = (url, init) => fetch(url, { ...init, decompress: false } as RequestInit);

/** `send`, vetted and pinned by `egress` when there is one (repo#2830). */
function guardedBy(send: Send, egress: EgressPolicy | undefined): Send {
  return egress ? egressGuardedSend(send, egress) : send;
}

// Fetch tolerant of a bad Content-Encoding: on decompress failure, refetch raw (identity) so the page isn't dropped #292.
// Undecoded on every hop (#2717): the runtime would otherwise inflate a bomb in
// full before readBodyCapped's cap applies. With `egress`, both requests are
// vetted and sent by `egressGuardedSend`.
async function fetchTolerant(
  url: string,
  init: RequestInit,
  egress?: EgressPolicy,
): Promise<Response> {
  try {
    return await guardedBy(fetchUndecoded, egress)(url, init);
  } catch (error) {
    if (!isDecompressionError(error)) throw error;
    return await guardedBy(fetchRaw, egress)(url, init);
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
      let requestHeaders = new Headers(req.headers);
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
            headers: requestHeaders,
            redirect: "manual",
            signal,
          };
          // A redirect hop goes out vetted (and pinned, outside the hosted
          // proxy) by the policy that let it through below (repo#2830).
          const response = await fetchTolerant(
            currentUrl,
            requestInit,
            i > 0 ? req.egress : undefined,
          );

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
            // An unparseable Location (`http://[`) ends the chain like a
            // missing one, so the page is recorded instead of the whole fetch
            // rejecting with "Invalid URL" (squirrelscan/repo#3382).
            let nextUrl: string;
            try {
              nextUrl = new URL(location, currentUrl).toString();
            } catch {
              endsInError = true;
              break;
            }
            // SECURITY (#1392): a hand-rolled manual-redirect loop bypasses the
            // runtime's native cross-protocol-redirect rejection, so a
            // `Location: file:///…` (or data:/blob:/ftp:/…) would otherwise be
            // re-fetched and its body returned as the page. Refuse any
            // non-http(s) redirect target — terminal error hop, never fetched.
            // Scheme-only: private/loopback HOSTS stay allowed (internal audits).
            if (!isHttpOrHttpsUrl(nextUrl)) {
              endsInError = true;
              break;
            }
            // repo#2830: never to a link-local or metadata address off the site.
            // A resolver failure or timeout here falls through to the guarded
            // send, which vets the hop again and fails it with that error;
            // nothing is sent unvetted.
            if (
              req.egress &&
              (await egressRefuses(nextUrl, req.egress, signal).catch(() => false))
            ) {
              endsInError = true;
              break;
            }
            requestHeaders = headersForRedirect(requestHeaders, currentUrl, nextUrl);
            currentUrl = nextUrl;
            continue;
          }

          if (response.status >= 400) {
            endsInError = true;
          }

          try {
            finalBody = await readBodyCapped(response, DEFAULT_MAX_DOCUMENT_BODY_BYTES);
          } catch (error) {
            // Body-time decode failure (large/streamed bodies) — recover the raw body, else keep an empty page.
            if (!isDecompressionError(error)) throw error;
            try {
              // The same address as the request it repeats (repo#2830): a
              // fresh lookup here could answer differently.
              const raw = await guardedBy(fetchRaw, i > 0 ? req.egress : undefined)(
                currentUrl,
                requestInit,
              );
              finalBody = await readBodyCapped(raw, DEFAULT_MAX_DOCUMENT_BODY_BYTES);
            } catch {
              finalBody = "";
            }
          }
          finishedAt = Date.now();
          break;
        }
      } finally {
        clearTimeout(timeout);
        // Closes the connection (#766): a capped read cancels its stream, but
        // Bun keeps downloading the rest of the body until the signal aborts.
        // A no-op for a body read to the end.
        controller.abort();
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
          const { sourceUrl, finalUrl, status } = statusData.result;
          // The render service reports the landing page; the statuses of the
          // redirects that led to it were never observed. Only the LAST hop can
          // carry `status`, and a supplied chain is sanitised rather than
          // trusted, so neither path can claim a 2xx hop redirected (#1510).
          const redirected = Boolean(finalUrl) && finalUrl !== sourceUrl;
          const fallbackHops: RedirectChain["hops"] = redirected
            ? [
                { url: sourceUrl, statusCode: 0, type: "http" },
                { url: finalUrl, statusCode: status, type: "http" },
              ]
            : [{ url: sourceUrl, statusCode: status, type: "http" }];
          return {
            url: statusData.result.sourceUrl,
            finalUrl: statusData.result.finalUrl,
            status: statusData.result.status,
            headers: statusData.result.headers,
            body: statusData.result.body,
            redirectChain: statusData.result.redirectChain
              ? {
                  ...statusData.result.redirectChain,
                  hops: withObservedHopStatuses(statusData.result.redirectChain.hops),
                }
              : {
                  sourceUrl,
                  finalUrl,
                  hops: fallbackHops,
                  chainLength: Math.max(0, fallbackHops.length - 1),
                  isLoop: false,
                  endsInError: status >= 400,
                  httpsToHttp: sourceUrl.startsWith("https://") && finalUrl.startsWith("http://"),
                  httpToHttps: sourceUrl.startsWith("http://") && finalUrl.startsWith("https://"),
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
