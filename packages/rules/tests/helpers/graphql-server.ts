// A stubbed `fetch` for the GraphQL probing rules: records every request the
// code under test sends and answers from a route table, so a test can assert
// exactly what went out. Unrouted URLs answer a 404 HTML page, like a site
// with no GraphQL endpoint.

import type { RuleContext } from "../../src/types";
import type { EndpointCandidate, EndpointSurface } from "../../src/endpoint-surface";
import { createProbeBudget, type ProbeLevel } from "../../src/probe-budget";
import type { RobotsTxtData } from "@squirrelscan/core-contracts";

export interface SentRequest {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  redirect: RequestRedirect | undefined;
}

export type Route = (req: SentRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

export function html(body = "<!doctype html><title>Not found</title>", status = 404): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// The real fetch, captured when the first stub goes in. A test that stubs twice
// would otherwise save the first stub as its "original" and leave it installed
// for every later file in the same bun process.
let realFetch: typeof fetch | undefined;

/** Install the stub. Returns the request log and a restore function. */
export function stubFetch(routes: Record<string, Route>): {
  sent: SentRequest[];
  restore: () => void;
} {
  realFetch ??= globalThis.fetch;
  const sent: SentRequest[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers)) headers[k] = v;
    const req: SentRequest = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : init?.body ? "<non-string body>" : null,
      headers,
      credentials: init?.credentials,
      redirect: init?.redirect,
    };
    sent.push(req);
    const u = new URL(url);
    const route = routes[`${u.origin}${u.pathname}`];
    return route ? route(req) : html();
  };
  globalThis.fetch = stub as typeof fetch;
  return {
    sent,
    restore: () => {
      if (realFetch) globalThis.fetch = realFetch;
      realFetch = undefined;
    },
  };
}

export const BASE = "https://example.com";

export function candidate(
  path: string,
  over: Partial<EndpointCandidate> = {}
): EndpointCandidate {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const sameOrigin = new URL(url).origin === BASE;
  return {
    url,
    method: "POST",
    source: "static-js",
    discoveredVia: "fetch",
    sameOrigin,
    probeEligible: sameOrigin,
    ...over,
  };
}

export function surface(candidates: EndpointCandidate[]): EndpointSurface {
  return { candidates, total: candidates.length, truncated: false, scriptsSkipped: 0 };
}

export function robots(disallow: string[]): RobotsTxtData {
  return {
    exists: true,
    url: `${BASE}/robots.txt`,
    content: null,
    sizeBytes: 0,
    sitemaps: [],
    rules: [{ userAgent: "*", rules: disallow.map((path) => ({ type: "disallow" as const, path })) }],
    errors: [],
  };
}

export function ruleCtx(opts: {
  level?: ProbeLevel;
  budgetMs?: number;
  surface?: EndpointSurface;
  robotsTxt?: RobotsTxtData | null;
  now?: () => number;
  noProbe?: boolean;
}): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: `${BASE}/`,
      pages: [],
      robotsTxt: opts.robotsTxt ?? null,
      sitemaps: null,
    },
    endpointSurface: opts.surface,
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({
          level: opts.level ?? "active",
          budgetMs: opts.budgetMs ?? 60_000,
          ...(opts.now ? { now: opts.now } : {}),
        }),
    options: {},
  };
}
