// `squirrel channel` (#569): a stdio MCP *channel* server for Claude Code.
//
// Built on the low-level SDK v1 `Server` on purpose: Claude Code refuses to
// register a channel that negotiates MCP revision 2026-07-28, and v1 tops out
// at 2025-11-25. Kept apart from `src/mcp/server.ts` so migrating `squirrel mcp`
// to a newer SDK cannot change what the channel negotiates.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { fetchActiveOrgContext } from "@/controllers/orgs/resolve";
import { cliApi } from "@/lib/api-client";
import { resolveCredential, warnIfSessionUnreadable } from "@/self/credentials";
import { logger } from "@/utils/logger";

import { version } from "../../package.json";
import {
  type ChannelCategory,
  type ChannelEvent,
  DEFAULT_CHANNEL_CATEGORIES,
  LOGIN_REQUIRED_EVENT,
  buildInstructions,
} from "./events";
import {
  type FetchPage,
  type PollResult,
  parseFeedPage,
  pollOnce,
} from "./poller";
import { type StateStore, createFileStateStore } from "./state";

export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const MIN_POLL_INTERVAL_SECONDS = 5;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
// The active org can change while a session stays open (dashboard switch), so re-resolve it every this many polls.
const ORG_RECHECK_POLLS = 10;

export interface ChannelOptions {
  intervalSeconds?: number;
  categories?: readonly ChannelCategory[];
}

export function createChannelServer(): Server {
  return new Server(
    { name: "squirrelscan", version },
    {
      // Presence of this key is what registers the channel. The permission relay capability is deliberately not declared: nobody but Claude Code may approve tool use in the session.
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: buildInstructions(),
    }
  );
}

export async function sendChannelEvent(
  server: Server,
  event: ChannelEvent
): Promise<void> {
  await server.notification({
    method: "notifications/claude/channel",
    params: { content: event.content, meta: event.meta },
  });
}

// Delay before the next poll: the base interval, doubled per consecutive 429/5xx/network failure and capped.
export function nextDelayMs(
  intervalMs: number,
  consecutiveFailures: number
): number {
  if (consecutiveFailures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

const liveFetchPage: FetchPage = async ({ after, limit }) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (after !== null) query.set("after", after);
  const result = await cliApi.request<unknown>(
    `/v1/notifications?${query.toString()}`,
    { method: "GET", auth: "required", timeoutMs: REQUEST_TIMEOUT_MS }
  );
  if (!result.ok) return { ok: false, status: result.status };
  const page = parseFeedPage(result.data);
  // A 2xx with an unusable body is treated like a server error.
  return page ? { ok: true, page } : { ok: false, status: 502 };
};

export interface LoopDeps {
  resolveLogin: () => unknown;
  resolveOrgId: () => Promise<string | null>;
  fetchPage: FetchPage;
  createStore: (orgId: string) => StateStore;
  emit: (event: ChannelEvent) => Promise<void>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Poll until aborted. Exported with injectable deps so the loop is testable.
export async function runPollLoop(
  options: Required<ChannelOptions>,
  deps: LoopDeps,
  signal: AbortSignal
): Promise<void> {
  const intervalMs = options.intervalSeconds * 1000;
  const categories = new Set<string>(options.categories);
  let failures = 0;
  let announcedLogin = false;
  let orgId: string | null = null;
  let store: StateStore | null = null;
  let pollsSinceOrgCheck = 0;

  while (!signal.aborted) {
    let delay = nextDelayMs(intervalMs, failures);
    try {
      if (!deps.resolveLogin()) {
        // One explanatory event per process, then keep checking for a login.
        if (!announcedLogin) {
          announcedLogin = true;
          await deps.emit(LOGIN_REQUIRED_EVENT);
        }
        orgId = null;
        store = null;
      } else {
        if (!store) {
          orgId = await deps.resolveOrgId();
          if (orgId) store = deps.createStore(orgId);
          pollsSinceOrgCheck = 0;
        } else if (++pollsSinceOrgCheck >= ORG_RECHECK_POLLS) {
          pollsSinceOrgCheck = 0;
          // A failed lookup keeps the current org; a different org gets its own state and starts from "now".
          const current = await deps.resolveOrgId();
          if (current && current !== orgId) {
            orgId = current;
            store = deps.createStore(current);
          }
        }
        const result: PollResult = store
          ? await pollOnce({
              fetchPage: deps.fetchPage,
              store,
              emit: deps.emit,
              categories,
            })
          : { ok: false, status: 0 };
        if (result.ok) {
          failures = 0;
          announcedLogin = false;
        } else if (result.status === 401 || result.status === 403) {
          // Signed out, expired, or an API key (the feed is login-only): same fixed explanation, then keep trying slowly.
          if (!announcedLogin) {
            announcedLogin = true;
            await deps.emit(LOGIN_REQUIRED_EVENT);
          }
          store = null;
          failures = Math.max(failures, 1);
        } else {
          failures += 1;
        }
        delay = nextDelayMs(intervalMs, failures);
      }
    } catch (error) {
      // A thrown poll must never end the server: back off and go again.
      logger.debug("channel: poll failed", error);
      failures += 1;
      delay = nextDelayMs(intervalMs, failures);
    }
    await deps.sleep(delay, signal);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

async function resolveOrgId(): Promise<string | null> {
  const context = await fetchActiveOrgContext(REQUEST_TIMEOUT_MS);
  return context?.activeOrgId ?? null;
}

// Process-wide redirect so stray stdout output cannot corrupt the JSON-RPC stream.
function redirectConsoleLogToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

// Start the stdio channel and block until the client disconnects.
export async function runChannelServer(
  options: ChannelOptions = {}
): Promise<void> {
  redirectConsoleLogToStderr();
  warnIfSessionUnreadable();
  const resolved: Required<ChannelOptions> = {
    intervalSeconds: Math.max(
      options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
      MIN_POLL_INTERVAL_SECONDS
    ),
    categories: options.categories ?? DEFAULT_CHANNEL_CATEGORIES,
  };

  const server = createChannelServer();
  const abort = new AbortController();
  const stop = () => abort.abort();
  server.onclose = stop;
  // The stdio transport does not surface stdin EOF, which is how a client hanging up looks.
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);

  let started = false;
  // Events sent before the client finished the handshake would be dropped.
  server.oninitialized = () => {
    if (started) return;
    started = true;
    void runPollLoop(
      resolved,
      {
        resolveLogin: resolveCredential,
        resolveOrgId,
        fetchPage: liveFetchPage,
        createStore: (orgId) => createFileStateStore(orgId),
        emit: (event) => sendChannelEvent(server, event),
        sleep: abortableSleep,
      },
      abort.signal
    ).finally(() => process.exit(0));
  };

  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) =>
    abort.signal.addEventListener("abort", () => resolve())
  );
}
