/**
 * @squirrelscan/api-client — a tiny, dependency-free HTTP client for the
 * squirrelscan API.
 *
 * Framework-agnostic by design: bind it once to a base URL + token source via
 * `createApiClient()`, then call `request()` / `send()` / `fetch()`. It owns the
 * plumbing every caller otherwise hand-rolls — base URL joining, the
 * `User-Agent`, bearer auth, JSON encode/decode, per-request timeout, and
 * network-error retry — so call sites state intent and nothing else.
 *
 * It carries no app dependencies (no settings, no logger, no env access), which
 * is what lets it be extracted as a public SDK and reused beyond the CLI
 * (dashboard, workers, third parties). The host supplies the base URL + token
 * resolution; the package supplies the transport.
 *
 * Three layers — pick the smallest that fits:
 *  - `request<T>()` — awaited; returns a typed `{ ok, status, data }`. Never
 *    throws for an HTTP status (inspect `.status`); a transport failure or a
 *    missing `required` credential surfaces as `{ ok:false, status:0 }`.
 *  - `send()` — fire-and-forget best-effort. Never throws, never blocks past its
 *    timeout; reports a non-2xx via `onDebug`. For lifecycle/telemetry writes
 *    where losing one is acceptable.
 *  - `fetch()` / `headers()` / `url()` — the raw plumbing for callers that need
 *    bespoke error mapping and only want the boilerplate gone.
 */

export type ApiAuth = "required" | "optional" | "none";

export type ApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiClientConfig {
  /** API origin (no trailing slash), or a thunk resolved per call so env / live
   *  overrides apply at request time rather than at construction. */
  baseUrl: string | (() => string);
  /** Resolve a bearer token per call. Sync or async; `null`/`undefined` = anon. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Static `User-Agent` header (e.g. `squirrel/0.0.50`). */
  userAgent?: string;
  /** Default per-request timeout. Default 10s. */
  defaultTimeoutMs?: number;
  /** Sink for best-effort `send()` non-2xx traces. Default: noop. */
  onDebug?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ApiRequestInit {
  method?: ApiMethod;
  /** JSON-serialized into the body; also sets `Content-Type: application/json`. */
  body?: unknown;
  /**
   * Bearer token. `undefined` (default) resolves via `config.getToken`; pass an
   * explicit string to override, or `null` to force unauthenticated.
   */
  token?: string | null;
  /**
   * - `optional` (default): attach a credential if one resolves, else send anon.
   * - `required`: short-circuit to `{ ok:false, status:0 }` when none resolves.
   * - `none`: never attach a credential.
   */
  auth?: ApiAuth;
  timeoutMs?: number;
  /** Network-error (not HTTP-status) retries with linear backoff. Default 0. */
  retries?: number;
}

export interface ApiResult<T> {
  ok: boolean;
  /** HTTP status, or `0` for a transport failure / missing required credential. */
  status: number;
  data: T | null;
}

export interface ApiClient {
  /** Absolute URL for a path against the configured base. */
  url(path: string): string;
  /** Request headers (User-Agent + JSON content-type; auth when `token` set). */
  headers(token?: string | null): Record<string, string>;
  /** Low-level fetch: base URL + timeout + network-retry, no auth added. */
  fetch(
    path: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number; retries?: number },
  ): Promise<Response>;
  /** Awaited typed request; never throws for an HTTP status. */
  request<T = unknown>(path: string, init?: ApiRequestInit): Promise<ApiResult<T>>;
  /** Fire-and-forget best-effort write; never throws. */
  send(path: string, init?: ApiRequestInit): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createApiClient(config: ApiClientConfig): ApiClient {
  const resolveBase = (): string =>
    typeof config.baseUrl === "function" ? config.baseUrl() : config.baseUrl;

  const url = (path: string): string => `${resolveBase()}${path}`;

  const headers = (token?: string | null): Record<string, string> => {
    const result: Record<string, string> = { "Content-Type": "application/json" };
    if (config.userAgent) {
      result["User-Agent"] = config.userAgent;
    }
    if (token) {
      result.Authorization = `Bearer ${token}`;
    }
    return result;
  };

  const doFetch = async (
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number; retries?: number } = {},
  ): Promise<Response> => {
    const timeoutMs = opts.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempts = Math.max(1, (opts.retries ?? 0) + 1);
    let lastError: unknown = new Error("unreachable");

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fetch(url(path), {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }

    throw lastError;
  };

  const resolveToken = async (init: ApiRequestInit): Promise<string | null> => {
    if (init.token !== undefined) return init.token;
    if (init.auth === "none") return null;
    return (await config.getToken?.()) ?? null;
  };

  const parseJson = async <T>(response: Response): Promise<T | null> => {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  };

  const request = async <T = unknown>(
    path: string,
    init: ApiRequestInit = {},
  ): Promise<ApiResult<T>> => {
    const token = await resolveToken(init);
    if (init.auth === "required" && !token) {
      return { ok: false, status: 0, data: null };
    }

    try {
      const response = await doFetch(
        path,
        {
          method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
          headers: headers(token),
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        },
        { timeoutMs: init.timeoutMs, retries: init.retries },
      );
      return { ok: response.ok, status: response.status, data: await parseJson<T>(response) };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  };

  const send = async (path: string, init: ApiRequestInit = {}): Promise<void> => {
    const result = await request(path, init);
    if (!result.ok) {
      // Distinguish "server said no" (HTTP status) from "couldn't reach the
      // server" (status 0 — transport failure / missing required credential) so
      // a debug log can tell them apart.
      config.onDebug?.(
        result.status === 0 ? "api-client: transport failure" : "api-client: non-2xx",
        { path, status: result.status },
      );
    }
  };

  return { url, headers, fetch: doFetch, request, send };
}
