// HTTP mode — Bun.serve-based server that generates pages on the fly from a
// SiteModel. No pages are pre-rendered to disk; each request renders exactly
// one page's HTML and discards it, so this scales to a 25k-page model without
// holding rendered bytes in memory.

import type { SiteModel } from "./types";

import { buildRobotsTxt, buildSitemapXml, renderPageHtml } from "./html-render";
import { createRng, deriveSeed, type Rng } from "./prng";

export interface LatencyRange {
  minMs: number;
  maxMs: number;
}

export interface ServeSiteOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  hostname?: string;
  /** Artificial per-response delay — simulates a slow/tarpit origin. */
  latencyMs?: number | LatencyRange;
}

export interface ServedSite {
  server: ReturnType<typeof Bun.serve>;
  /** Origin, no trailing slash, e.g. "http://localhost:54213". */
  url: string;
  stop: () => void;
}

// Seeded off `model.seed` (never bare Math.random()) so a latency RANGE is at
// least reproducible-per-model, even though true per-request ordering isn't
// guaranteed under concurrent load — this is a timing simulation, not model
// content, so that caveat is acceptable.
function resolveLatencyMs(rng: Rng, latency: number | LatencyRange | undefined): number {
  if (latency === undefined) return 0;
  if (typeof latency === "number") return latency;
  const { minMs, maxMs } = latency;
  return minMs + rng() * Math.max(0, maxMs - minMs);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Serves `model` over HTTP. Caller must call `stop()` when done (tests: afterEach). */
export function serveSite(model: SiteModel, opts: ServeSiteOptions = {}): ServedSite {
  const byPath = new Map(model.pages.map((p) => [p.path, p]));
  const latencyRng = createRng(deriveSeed(model.seed, "latency"));
  // Set once the listener is up (see below) — closed over by fetch, always
  // populated before the server can accept its first connection.
  let origin = "";

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname,
    async fetch(req) {
      if (opts.latencyMs !== undefined) {
        await sleep(resolveLatencyMs(latencyRng, opts.latencyMs));
      }

      const url = new URL(req.url);

      if (url.pathname === "/robots.txt") {
        return new Response(buildRobotsTxt(origin), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url.pathname === "/sitemap.xml") {
        return new Response(buildSitemapXml(model.sitemapPaths, origin), {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      }

      const page = byPath.get(url.pathname);
      if (!page) {
        return new Response("Not Found", { status: 404 });
      }
      if (page.statusCode >= 300 && page.statusCode < 400 && page.redirectTo) {
        return new Response(null, {
          status: page.statusCode,
          headers: { location: `${origin}${page.redirectTo}` },
        });
      }

      const html = renderPageHtml(page, origin);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });

  // "0.0.0.0"/undefined is what Bun listens on but isn't always connectable
  // as a literal fetch() target — normalize to localhost for the returned URL.
  const connectHost =
    !server.hostname || server.hostname === "0.0.0.0" ? "localhost" : server.hostname;
  origin = `http://${connectHost}:${server.port}`;

  return {
    server,
    url: origin,
    stop: () => server.stop(true),
  };
}
