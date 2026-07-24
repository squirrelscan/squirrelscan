// CloudServicesClient — the CLI's typed client for the credit-gated cloud
// service-proxy (`/v1/services/*`) and credit balance (`/v1/credits`).
//
// Transport contract mirrors `apps/cli/src/controllers/report/publish.ts`:
// Bearer-token auth, a hard per-request timeout, and retry on TRANSPORT errors
// only (never on HTTP error responses). Retrying these POSTs is safe for the
// IDEMPOTENT endpoints because the server derives the idempotency key from the
// request payload (org + payload hash), so a transport retry of the identical
// request is deduplicated server side — it never double-charges (a
// delivered-then-retried request comes back 409 `duplicate_request`).
//
// EXCEPTION — `render` is NOT idempotent: each submit performs fresh browser
// work and is charged on submit with a server-side nonce (no payload-hash
// dedup), so a transport retry would charge AGAIN. The `render()` method
// therefore pins `maxAttempts: 1` (send at most once); a lost response surfaces
// as a per-url failure and the CLI fetcher falls back to plain HTTP for that
// url. Every non-2xx response and transport failure throws a `CloudClientError`;
// the prefetch layer catches and converts to per-rule `skipped` envelopes.

import type {
  AiParseRequest,
  AiParseResponse,
  AuthorityRequest,
  AuthorityResponse,
  ArchiveIndexingRequest,
  ArchiveIndexingResponse,
  BlocklistCheckRequest,
  BlocklistCheckResponse,
  ContentGapsRequest,
  ContentGapsResponse,
  CreditFeature,
  CreditPrice,
  DeadLinksRequest,
  DeadLinksResponse,
  DomainStatsRequest,
  DomainStatsResponse,
  EditorSummaryRequest,
  EditorSummaryResponse,
  KeywordGapsRequest,
  KeywordGapsResponse,
  PlanDefinition,
  ReportBranding,
  RenderJobResponse,
  RenderRequest,
  RenderResultResponse,
  SiteMetadataRequest,
  SiteMetadataResponse,
  TechDetectRequest,
  TechDetectResponse,
} from "@squirrelscan/core-contracts";

import { CloudClientError, codeForStatus } from "./errors";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface CloudClientConfig {
  /** API origin, no trailing slash (e.g. `https://api.squirrelscan.com`). */
  apiUrl: string;
  /** CLI auth token (`sqcli_…`) sent as `Authorization: Bearer`. */
  token: string;
  /** `User-Agent` header — e.g. `squirrel/0.0.40`. */
  userAgent?: string;
  /** Per-request hard timeout. Default 120s (cloud providers run up to ~90s). */
  timeoutMs?: number;
  /** Max attempts on transport failure (not HTTP errors). Default 3. */
  maxAttempts?: number;
  /**
   * Extra headers sent on every request — e.g. the cloud-audit container passes
   * `X-Squirrel-Run-Id` (with `token` = INTERNAL_API_KEY) so /v1/services/* can
   * resolve + charge the run's org (#344).
   */
  extraHeaders?: Record<string, string>;
}

/** Per-call options shared by every service method. */
export interface CallOpts {
  /** Caller abort signal, combined with the per-request timeout. */
  signal?: AbortSignal;
  /**
   * Override the instance `maxAttempts` for THIS call only. Used by `render`
   * (pins `1`) so a non-idempotent charge-on-submit is sent at most once.
   */
  maxAttempts?: number;
}

/** `GET /v1/credits` response. */
export interface CreditsResponse {
  balance: { monthly: number; pack: number; total: number; periodEnd: string | null };
  plan: PlanDefinition;
  pricing: Record<CreditFeature, CreditPrice>;
  pricingVersion: number;
  /** White-label branding (#810) — present only for Team orgs. */
  branding?: ReportBranding;
}

export interface CloudServicesClient {
  /** Current credit balance + plan + pricing table (CLI preflight). */
  getBalance(opts?: Pick<CallOpts, "signal">): Promise<CreditsResponse>;
  /** Classify a batch of pages (page type + parsability). */
  aiParse(req: AiParseRequest, opts?: CallOpts): Promise<AiParseResponse>;
  /** Authority signals for a batch of pages. */
  authoritySignals(req: AuthorityRequest, opts?: CallOpts): Promise<AuthorityResponse>;
  /** Check a batch of external URLs against the shared dead-link cache + live fetch. */
  deadLinks(req: DeadLinksRequest, opts?: CallOpts): Promise<DeadLinksResponse>;
  /** Match URLs/selectors against server-side EasyList/EasyPrivacy. */
  blocklistCheck(req: BlocklistCheckRequest, opts?: CallOpts): Promise<BlocklistCheckResponse>;
  /** Keyword gap analysis for the site (single run). */
  keywordGaps(req: KeywordGapsRequest, opts?: CallOpts): Promise<KeywordGapsResponse>;
  /** Content gap analysis for the site (single run). */
  contentGaps(req: ContentGapsRequest, opts?: CallOpts): Promise<ContentGapsResponse>;
  /**
   * Fingerprint the site's technology stack (single run). Idempotent — the
   * server derives the key from the payload, so a transport retry is deduped.
   * Returns the current stack + added/removed diff vs the org's prior scan.
   */
  detectTechnologies(req: TechDetectRequest, opts?: CallOpts): Promise<TechDetectResponse>;
  /**
   * Resolve the durable per-domain "site profile" (Stage 0 of the cloud
   * pipeline). Idempotent — the server derives the key from the payload + a
   * coarse 30-day refresh nonce, so a transport retry is deduped and a repeat
   * audit of the same domain in-window is a 0-credit cache hit.
   */
  siteMetadata(req: SiteMetadataRequest, opts?: CallOpts): Promise<SiteMetadataResponse>;
  /**
   * Generate the credited editor's audit summary (single run). Idempotent — the
   * server derives the key from the audit + ranked-issue payload, so a transport
   * retry is deduped. Any signed-in plan runs it; out of credits → 402 (#684).
   */
  editorSummary(req: EditorSummaryRequest, opts?: CallOpts): Promise<EditorSummaryResponse>;
  /**
   * Fetch credited domain-level SEO stats (single run). Idempotent — the server
   * derives the key from the audit + domain payload, so a transport retry is
   * deduped, and a repeat audit of the same domain in-window is a 0-credit cache
   * hit. Any signed-in plan runs it (out of credits → 402, #684); a domain with
   * no SEO footprint gets 404 `no_data` (uncharged). Both degrade silently.
   */
  domainStats(req: DomainStatsRequest, opts?: CallOpts): Promise<DomainStatsResponse>;
  archiveIndexing(req: ArchiveIndexingRequest, opts?: CallOpts): Promise<ArchiveIndexingResponse>;
  /**
   * Submit a cloud render job (202 — poll renderResult). Debits on submit.
   * Sent AT MOST ONCE (pins `maxAttempts: 1`) — non-idempotent, so a transport
   * retry would double-charge; a lost response surfaces as a per-url failure.
   */
  render(req: RenderRequest, opts?: CallOpts): Promise<RenderJobResponse>;
  /** Poll a render job. Free. */
  renderResult(jobId: string, opts?: Pick<CallOpts, "signal">): Promise<RenderResultResponse>;
}

/** Build the combined timeout + caller abort signal. */
function buildSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/**
 * Read + JSON-parse a response body, bounded by the SAME per-request signal that
 * bounds the connection (#1214). The signal is passed to fetch, but a body read
 * started after the headers landed is not reliably tied to it on every runtime —
 * a stalled stream (headers sent, body never finishes) could then outlive the
 * timeout and hang the caller (run 01KXYKKYMM wedged 52min this way). Reading
 * via our own reader (not `res.json()`) means an abort can CANCEL the stream —
 * releasing the socket instead of leaving a pending read holding the connection
 * open, which would block container exit on event-loop drain.
 */
async function readJson<T>(res: Response, signal: AbortSignal, path: string): Promise<T> {
  // No body stream (empty/consumed) — keep res.json()'s native error shape.
  if (!res.body) return (await res.json()) as T;
  const reader = res.body.getReader();
  const abortError = () =>
    new CloudClientError("network_error", 0, `Cloud response from ${path} aborted mid-body`);
  if (signal.aborted) {
    await reader.cancel().catch(() => {});
    throw abortError();
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Always-raced below; this guards the post-loop window so an abort landing
  // between the last race and removeEventListener can't be an unhandledRejection.
  aborted.catch(() => {});
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), aborted]);
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    // Abort or stream error: cancel the reader so the socket is released, not
    // left pending — the whole point of the explicit bound. (A cancelled
    // reader's abandoned read() resolves done, so the lost race is inert.)
    void reader.cancel().catch(() => {});
    throw error instanceof CloudClientError
      ? error
      : new CloudClientError(
          "network_error",
          0,
          `Cloud response from ${path} failed mid-body: ${(error as Error)?.message ?? "unknown"}`,
          { cause: error },
        );
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return JSON.parse(text) as T;
}

/**
 * Parse an error body's `required` field (insufficient_credits) from the typed
 * `{ error: { required } }` envelope (#214). The API emits this shape on every
 * `/v1/services/*` 402, so the legacy top-level fallback is gone (#377).
 */
function extractRequired(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const envelope = (body as { error?: unknown }).error;
  if (envelope && typeof envelope === "object" && "required" in envelope) {
    const r = (envelope as { required?: unknown }).required;
    if (typeof r === "number") return r;
  }
  return undefined;
}

/**
 * Read the typed error envelope's `code` (SCREAMING_SNAKE). Lets the client split
 * two responses that share an HTTP status — DUPLICATE_REQUEST vs RUN_NOT_ACTIVE,
 * both 409 (#475) — so a reaped-run charge isn't misreported as a replay.
 */
function extractErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const envelope = (body as { error?: unknown }).error;
  if (envelope && typeof envelope === "object" && "code" in envelope) {
    const c = (envelope as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

/** Exponential backoff with jitter so concurrent CLI runs don't retry in lockstep against a recovering API. */
function backoff(attempt: number): Promise<void> {
  const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000) + Math.random() * 250;
  // setTimeout (not Bun.sleep): cloud-client is also imported by worker-agent's workerd surface.
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// Transient statuses safe to retry on an IDEMPOTENT read. 429 is excluded: we don't honour
// Retry-After, so blind backoff could hammer a rate-limited API — let the caller surface it.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

export function createCloudClient(config: CloudClientConfig): CloudServicesClient {
  const base = config.apiUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${config.token}`,
      "User-Agent": config.userAgent ?? "squirrel/cloud-client",
      ...config.extraHeaders,
      ...extra,
    };
  }

  // Fetch with timeout + retry. Writers (no retryStatus) retry transport throws only — an HTTP
  // response of any status and an abort/timeout are both terminal, preserving charge-on-submit
  // safety. Idempotent reads pass retryStatus to also retry transient 5xx/408 within the same
  // timeout budget; timeout stays terminal so a hung endpoint can't inflate the worst-case wait.
  async function send(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    attempts: number,
    retryStatus?: (status: number) => boolean,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(`${base}${path}`, { ...init, signal });
        // Idempotent reads retry transient HTTP; the final attempt returns the response so parse() surfaces the status.
        if (retryStatus?.(res.status) && attempt < attempts) {
          // #1214: release the abandoned body before backing off. A retryable
          // response whose body then stalls (headers sent, stream never finishes)
          // would otherwise hold the socket open across the retry — outside the
          // readJson body-read bound the terminal path gets — leaking the
          // connection past the per-request timeout and blocking container exit.
          // Fire-and-forget (like readJson's catch-path cancel): cancel() only
          // initiates the release; awaiting it would add an unbounded await that a
          // never-settling cancel could hang on, defeating the deadline it guards.
          void res.body?.cancel().catch(() => {});
          await backoff(attempt);
          continue;
        }
        return res;
      } catch (error) {
        // Abort (caller cancel or the per-request timeout) is terminal — every further attempt fails instantly on the same signal.
        if (signal.aborted) {
          throw new CloudClientError("network_error", 0, `Cloud request to ${path} aborted`, {
            cause: error,
          });
        }
        lastError = error;
        if (attempt < attempts) await backoff(attempt);
      }
    }
    throw new CloudClientError(
      "network_error",
      0,
      `Cloud request to ${path} failed: ${(lastError as Error)?.message ?? "unknown"}`,
      { cause: lastError },
    );
  }

  /** POST JSON and parse a typed 2xx body, or throw a mapped CloudClientError. */
  async function postJson<T>(path: string, body: unknown, opts?: CallOpts): Promise<T> {
    const signal = buildSignal(timeoutMs, opts?.signal);
    const res = await send(
      path,
      {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
      signal,
      // Per-call override (render pins 1 — non-idempotent charge-on-submit). No retryStatus: never retry HTTP responses.
      opts?.maxAttempts ?? maxAttempts,
    );
    return parse<T>(res, path, signal);
  }

  async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    // Idempotent read → retry transient 5xx/408 (timeout stays terminal via the shared signal).
    const combined = buildSignal(timeoutMs, signal);
    const res = await send(
      path,
      { method: "GET", headers: headers() },
      combined,
      maxAttempts,
      isRetryableStatus,
    );
    return parse<T>(res, path, combined);
  }

  async function parse<T>(res: Response, path: string, signal: AbortSignal): Promise<T> {
    // Body reads are bounded + cancellable via the per-request signal (#1214)
    // so a stalled stream can't outlive timeoutMs — see readJson.
    if (res.ok) return await readJson<T>(res, signal, path);
    let body: unknown;
    try {
      body = await readJson(res, signal, path);
    } catch {
      body = undefined;
    }
    const message =
      (body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : undefined) ?? `Cloud request to ${path} failed (${res.status})`;
    // RUN_NOT_ACTIVE and DUPLICATE_REQUEST are both 409 — split on the envelope
    // code so a reaped-run charge isn't reported as a replay (#475).
    const code =
      extractErrorCode(body) === "RUN_NOT_ACTIVE" ? "run_inactive" : codeForStatus(res.status);
    throw new CloudClientError(code, res.status, message, {
      required: extractRequired(body),
    });
  }

  return {
    getBalance: (opts) => getJson<CreditsResponse>("/v1/credits", opts?.signal),
    aiParse: (req, opts) => postJson<AiParseResponse>("/v1/services/ai-parse", req, opts),
    authoritySignals: (req, opts) =>
      postJson<AuthorityResponse>("/v1/services/authority-signals", req, opts),
    deadLinks: (req, opts) => postJson<DeadLinksResponse>("/v1/services/dead-links", req, opts),
    blocklistCheck: (req, opts) =>
      postJson<BlocklistCheckResponse>("/v1/services/blocklist-check", req, opts),
    keywordGaps: (req, opts) =>
      postJson<KeywordGapsResponse>("/v1/services/keyword-gaps", req, opts),
    contentGaps: (req, opts) =>
      postJson<ContentGapsResponse>("/v1/services/content-gaps", req, opts),
    detectTechnologies: (req, opts) =>
      postJson<TechDetectResponse>("/v1/services/technologies", req, opts),
    siteMetadata: (req, opts) => postJson<SiteMetadataResponse>("/v1/services/metadata", req, opts),
    editorSummary: (req, opts) =>
      postJson<EditorSummaryResponse>("/v1/services/editor-summary", req, opts),
    domainStats: (req, opts) =>
      postJson<DomainStatsResponse>("/v1/services/domain-stats", req, opts),
    archiveIndexing: (req, opts) =>
      postJson<ArchiveIndexingResponse>("/v1/services/archive-indexing", req, opts),
    // render is charge-on-submit + non-idempotent: send AT MOST once so a
    // transport retry can never double-charge (lost response → per-url fallback).
    render: (req, opts) =>
      postJson<RenderJobResponse>("/v1/services/render", req, { ...opts, maxAttempts: 1 }),
    renderResult: (jobId, opts) =>
      getJson<RenderResultResponse>(
        `/v1/services/render/${encodeURIComponent(jobId)}`,
        opts?.signal,
      ),
  };
}
