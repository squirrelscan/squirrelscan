// Local-browser render fetcher over the Chrome DevTools Protocol (#2306).
//
// `--render-cdp <url>` points the audit at a Chrome the user already runs (agent-browser, Playwright,
// browserless, a CI image). Each HTML page the CRAWLER chose to fetch is opened in a new tab of that
// browser's default profile, so its saved cookies and storage apply, and the rendered DOM comes back
// with the main document's status, headers and redirect chain. Nothing goes to the squirrelscan cloud.
//
// The crawler decides which URLs are fetched (robots.txt, page limits, scope) and calls the fetcher
// only for those, so the browser never opens a page the crawler would skip. A page the browser cannot
// render (error, timeout, non-HTML, bot wall) is served by the plain-HTTP fallback, and an endpoint
// that cannot be reached turns the whole run to plain HTTP for good, with the reason reported.
//
// No dependency: the protocol is JSON over the runtime's own WebSocket.

import type { RedirectChain } from "@squirrelscan/core-contracts";

import { egressRefuses } from "@squirrelscan/utils/public-egress";

import type { DocumentFetcher, FetchRequest, FetchResponse } from "./index";

/** The id the report, the crawler and the controller recognise this fetcher by. */
export const CDP_RENDER_FETCHER_ID = "cdp-render";

/** Every fallback reason this fetcher gives starts with this, so a report line can name the renderer. */
export const CDP_REASON_PREFIX = "Chrome";

const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** Quiet time after the load event with no request in flight, so client code can build the page. */
const DEFAULT_SETTLE_MS = 400;
/** The most the page may keep requesting after load before we take the DOM as it is. */
const MAX_SETTLE_WAIT_MS = 5_000;
/** A bot wall or error status the plain request may answer differently. */
const BLOCK_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 503]);

export interface CdpRenderFetcherOptions {
  /** `ws://host:port/devtools/browser/<id>` or `http://host:port` (resolved through `/json/version`). */
  endpoint: string;
  /** Plain-HTTP fetcher: serves pages the browser cannot, and every page once the endpoint is lost. */
  fallback: DocumentFetcher;
  /** Called once when the whole run moves to plain HTTP, with the reason for the report. */
  onFallback?: (reason: string) => void;
  /** Called for a page the browser did not render and the plain fetch served. */
  onPageFallback?: (url: string, reason: string) => void;
  connectTimeoutMs?: number;
  settleMs?: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

/** A browser-level CDP connection: request/response by id, events by method. */
class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private readonly closeHandlers = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error)
          waiter.reject(new Error(msg.error.message ?? "CDP error"));
        else waiter.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? [])
          l(msg.params ?? {}, msg.sessionId);
      }
    });
    const onClose = () => {
      if (this.closed) return;
      this.closed = true;
      for (const waiter of this.pending.values())
        waiter.reject(new Error("browser connection closed"));
      this.pending.clear();
      for (const h of this.closeHandlers) h();
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
  }

  static connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("connection refused"));
      });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    if (this.closed)
      return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        })
      );
    });
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * The browser-level WebSocket URL for an endpoint. A `ws(s)://` URL is used as given; an
 * `http(s)://host:port` one is asked for its `webSocketDebuggerUrl` at `/json/version`.
 */
export async function resolveCdpWebSocketUrl(
  endpoint: string,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<string> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`'${endpoint}' is not a URL`);
  }
  if (url.protocol === "ws:" || url.protocol === "wss:") return endpoint;
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("expected a ws:// or http:// endpoint");
  const versionUrl = new URL("/json/version", url);
  const res = await fetch(versionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${versionUrl.href} answered ${res.status}`);
  const info = (await res.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof info.webSocketDebuggerUrl !== "string")
    throw new Error("no webSocketDebuggerUrl in /json/version");
  // The browser reports the address it sees itself on (often 127.0.0.1 or a container name):
  // keep the host the user gave us, which is the one that reached it.
  const ws = new URL(info.webSocketDebuggerUrl);
  ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  ws.host = url.host;
  return ws.href;
}

function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      out[k.toLowerCase()] = String(v);
  }
  return out;
}

class RenderBlocked extends Error {}
class NotHtml extends Error {}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

export interface CdpRenderFetcher extends DocumentFetcher {
  /** Drops the browser connection (the tabs are already closed); safe to call when never connected. */
  close(): Promise<void>;
}

export function createCdpRenderFetcher(
  opts: CdpRenderFetcherOptions
): CdpRenderFetcher {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  let connection: Promise<CdpConnection> | undefined;
  let fallbackActive = false;

  function activateFallback(reason: string): void {
    if (fallbackActive) return;
    fallbackActive = true;
    opts.onFallback?.(reason);
  }

  function ensureConnection(): Promise<CdpConnection> {
    connection ??= (async () => {
      const wsUrl = await resolveCdpWebSocketUrl(
        opts.endpoint,
        opts.connectTimeoutMs
      );
      const conn = await CdpConnection.connect(
        wsUrl,
        opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      );
      conn.onClose(() => {
        activateFallback(`${CDP_REASON_PREFIX} connection lost`);
      });
      return conn;
    })();
    return connection;
  }

  async function renderPage(
    conn: CdpConnection,
    req: FetchRequest
  ): Promise<FetchResponse> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    const startedAt = Date.now();
    const { targetId } = (await conn.send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId: string };
    let sessionId: string | undefined;
    const offs: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      ({ sessionId } = (await conn.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string });
      const sid = sessionId;
      const forSession =
        (fn: Listener): Listener =>
        (params, s) => {
          if (s === sid) fn(params, s);
        };
      const listen = (method: string, fn: Listener) =>
        offs.push(conn.on(method, forSession(fn)));

      // Main-frame document requests; a redirect reuses the request id.
      const hops: RedirectChain["hops"] = [];
      let mainRequestId: string | undefined;
      let mainStatus = 0;
      let mainHeaders: Record<string, string> = {};
      let mainMime = "";
      let responseAt = startedAt;
      let loaded = false;
      const inflight = new Set<string>();
      let mainUrl = "";
      let lastActivity = Date.now();
      let failed: Error | undefined;

      listen("Network.requestWillBeSent", (p) => {
        const requestId = String(p.requestId);
        inflight.add(requestId);
        lastActivity = Date.now();
        if (p.type === "Document" && p.frameId === targetId) {
          const redirect = p.redirectResponse as
            | { url?: string; status?: number }
            | undefined;
          if (mainRequestId === requestId && redirect) {
            hops.push({
              url: String(redirect.url ?? ""),
              statusCode: Number(redirect.status ?? 0),
              type: "http",
            });
          } else if (mainRequestId !== requestId) {
            mainRequestId = requestId;
          }
        }
      });
      listen("Network.responseReceived", (p) => {
        lastActivity = Date.now();
        if (p.requestId === mainRequestId && p.type === "Document") {
          const r = p.response as {
            status?: number;
            headers?: unknown;
            mimeType?: string;
          };
          mainStatus = Number(r.status ?? 0);
          mainHeaders = lowerHeaders(r.headers);
          mainMime = String(r.mimeType ?? "");
          mainUrl = String((p.response as { url?: string }).url ?? "");
          responseAt = Date.now();
        }
      });
      const done = (p: Record<string, unknown>) => {
        inflight.delete(String(p.requestId));
        lastActivity = Date.now();
      };
      listen("Network.loadingFinished", done);
      listen("Network.loadingFailed", (p) => {
        done(p);
        if (p.requestId === mainRequestId && !mainStatus)
          failed = new Error(String(p.errorText ?? "navigation failed"));
      });
      listen("Page.loadEventFired", () => {
        loaded = true;
        lastActivity = Date.now();
      });
      // Vet each redirect hop of a document request like the plain fetcher does (#2830): a hop to a
      // link-local or metadata address off the site is never requested.
      listen("Fetch.requestPaused", (p) => {
        void (async () => {
          const requestId = String(p.requestId);
          try {
            const url = String((p.request as { url?: string }).url ?? "");
            const isHop = p.redirectedRequestId !== undefined;
            if (isHop && req.egress && (await egressRefuses(url, req.egress))) {
              await conn.send(
                "Fetch.failRequest",
                { requestId, errorReason: "BlockedByClient" },
                sid
              );
              return;
            }
            await conn.send("Fetch.continueRequest", { requestId }, sid);
          } catch {
            // A closed target or connection: the render rejects through its own timers.
          }
        })();
      });

      await Promise.all([
        conn.send("Page.enable", {}, sid),
        conn.send("Network.enable", {}, sid),
        conn.send(
          "Fetch.enable",
          { patterns: [{ resourceType: "Document", requestStage: "Request" }] },
          sid
        ),
      ]);
      if (req.headers?.["User-Agent"])
        await conn.send(
          "Network.setUserAgentOverride",
          { userAgent: req.headers["User-Agent"] },
          sid
        );

      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`render timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        if (req.signal) {
          onAbort = () => reject(abortError());
          if (req.signal.aborted) onAbort();
          else req.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      deadline.catch(() => {});

      const work = (async () => {
        await conn.send("Page.navigate", { url: req.url }, sid);
        // Load event, then a quiet moment (no request in flight) so client code has built the page.
        const loadWaitStart = Date.now();
        for (;;) {
          if (failed) throw failed;
          if (loaded) break;
          if (Date.now() - loadWaitStart > timeoutMs) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        const settleStart = Date.now();
        while (
          Date.now() - settleStart < MAX_SETTLE_WAIT_MS &&
          (inflight.size > 0 || Date.now() - lastActivity < settleMs)
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }
        if (failed) throw failed;
        if (!mainStatus) throw new Error("no document response observed");
        if (BLOCK_STATUSES.has(mainStatus)) throw new RenderBlocked();
        if (!/html/i.test(mainMime)) throw new NotHtml();
        const evaluated = (await conn.send(
          "Runtime.evaluate",
          {
            expression:
              "JSON.stringify({href:location.href,html:'<!DOCTYPE html>'+document.documentElement.outerHTML})",
            returnByValue: true,
          },
          sid
        )) as { result?: { value?: string } };
        const parsed = JSON.parse(evaluated.result?.value ?? "{}") as {
          href?: string;
          html?: string;
        };
        return { href: parsed.href ?? req.url, html: parsed.html ?? "" };
      })();

      const { href, html } = await Promise.race([work, deadline]);
      const finishedAt = Date.now();
      // The last hop is the landing page with its own status; a document that rewrote its URL
      // (history.pushState, a client redirect) lands on `href`.
      const landing = {
        url: mainUrl || req.url,
        statusCode: mainStatus,
        type: "http" as const,
      };
      const allHops: RedirectChain["hops"] = [...hops, landing];
      let httpsToHttp = false;
      let httpToHttps = false;
      for (let i = 0; i < allHops.length - 1; i++) {
        const from = allHops[i]?.url ?? "";
        const to = allHops[i + 1]?.url ?? "";
        if (from.startsWith("https://") && to.startsWith("http://"))
          httpsToHttp = true;
        if (from.startsWith("http://") && to.startsWith("https://"))
          httpToHttps = true;
      }
      return {
        url: req.url,
        finalUrl: href,
        status: mainStatus,
        headers: mainHeaders,
        body: html,
        timing: { startedAt, responseAt, finishedAt },
        redirectChain: {
          sourceUrl: req.url,
          finalUrl: href,
          hops: allHops,
          chainLength: Math.max(0, allHops.length - 1),
          isLoop: false,
          endsInError: mainStatus >= 400,
          httpsToHttp,
          httpToHttps,
        },
        fetcherMethod: CDP_RENDER_FETCHER_ID,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) req.signal?.removeEventListener("abort", onAbort);
      for (const off of offs) off();
      await conn.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  return {
    id: CDP_RENDER_FETCHER_ID,
    capabilities: { jsRendering: true, cookies: true, screenshot: false },
    async close() {
      const pending = connection;
      connection = undefined;
      fallbackActive = true;
      if (pending) (await pending.catch(() => undefined))?.close();
    },
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      const plain = (reason?: string) =>
        opts.fallback
          .fetch(req)
          .then((r) => (reason ? { ...r, fallbackReason: reason } : r));
      // The browser cannot do these: a HEAD or other method, or a page the caller wants unfollowed.
      if (
        fallbackActive ||
        (req.method && req.method.toUpperCase() !== "GET") ||
        req.followRedirects === false
      )
        return plain();
      if (req.signal?.aborted) throw abortError();

      let conn: CdpConnection;
      try {
        conn = await ensureConnection();
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        activateFallback(`${CDP_REASON_PREFIX} endpoint unreachable (${why})`);
        return plain("render-unavailable");
      }
      if (!conn.isOpen) return plain("render-unavailable");

      try {
        return await renderPage(conn, req);
      } catch (error) {
        if (req.signal?.aborted) throw error;
        if (error instanceof RenderBlocked) {
          opts.onPageFallback?.(req.url, "blocked by site");
          return plain("render-block");
        }
        const why =
          error instanceof NotHtml
            ? "not an HTML document"
            : error instanceof Error
              ? error.message
              : String(error);
        opts.onPageFallback?.(req.url, why);
        return plain("render-failed");
      }
    },
  };
}
