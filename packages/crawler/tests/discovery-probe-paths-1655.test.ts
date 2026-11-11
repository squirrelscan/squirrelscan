// squirrelscan/squirrelscan#1655: individual discovery probe paths can be approved, a redirect may
// not leave an approved path, and a block signal stops the optional probes still waiting.
// Every assertion is on what reached the origin or what the crawl stored for the rules.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  PROBE_PATH_NOT_APPROVED_ERROR,
  PROBE_REDIRECT_NOT_FOLLOWED_ERROR,
  PROBE_STOPPED_ERROR,
  WELL_KNOWN_PATHS,
} from "@squirrelscan/core-contracts/storage";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<a href="/one">one</a></body></html>`;

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 2,
  concurrency: 2,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 5_000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
};

// The path-shaped probes only, so the request log holds nothing else the probes send.
const PATH_PROBES = ["llms-txt", ...WELL_KNOWN_PATHS] as const;
const PROBE_ONLY_PATHS = ["/llms.txt", "/llms-full.txt", ...WELL_KNOWN_PATHS];

interface Hit {
  path: string;
  startedAt: number;
  endedAt: number;
}

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

type Handler = (path: string, origin: string, host: string) => Response | undefined;

function serve(handler: Handler = () => undefined, latencyMs = 0): { url: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const hit: Hit = { path, startedAt: performance.now(), endedAt: 0 };
      hits.push(hit);
      if (latencyMs > 0) await Bun.sleep(latencyMs);
      hit.endedAt = performance.now();
      const origin = `http://localhost:${server.port}`;
      const custom = handler(path, origin, req.headers.get("host") ?? "");
      if (custom) return custom;
      if (path === "/robots.txt")
        return new Response(`User-agent: *\nSitemap: ${origin}/sitemap.xml\n`);
      if (path === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>${origin}/one</loc></url></urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (path === "/" || path === "/one") {
        return new Response(PAGE, { headers: { "content-type": "text/html" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}/`, hits };
}

async function crawl(origin: string, config: Partial<CrawlerConfig>) {
  const crawler = await Effect.runPromise(createCrawler({ config: { ...CONFIG, ...config } }));
  const crawlId = await Effect.runPromise(crawler.start(origin, origin));
  const read = <T>(effect: Effect.Effect<T, unknown, never>) =>
    Effect.runPromise(effect as Effect.Effect<T, never, never>);
  const s = crawler.storage;
  return {
    pages: (await read(s.getPages(crawlId))).length,
    robots: await read(s.getRobotsTxt(crawlId)),
    llms: await read(s.getLlmsTxt(crawlId)),
    wellKnown: await read(s.getWellKnownProbe(crawlId)),
  };
}

const probeHits = (hits: Hit[]) =>
  hits.filter((h) => PROBE_ONLY_PATHS.includes(h.path)).map((h) => h.path);

describe("discovery_probe_paths allowlist (#1655)", () => {
  test("only /llms.txt approved: exactly that optional request, no variants", async () => {
    const origin = serve();
    const out = await crawl(origin.url, {
      discoveryProbes: PATH_PROBES,
      discoveryProbePaths: ["/llms.txt"],
    });

    expect(probeHits(origin.hits)).toEqual(["/llms.txt"]);
    // /llms.txt answered 404: a real absence. Every well-known path is "not approved", never missing.
    expect(out.llms?.llmsTxt.exists).toBe(false);
    expect(out.wellKnown?.probes).toHaveLength(WELL_KNOWN_PATHS.length);
    for (const probe of out.wellKnown?.probes ?? []) {
      expect(probe.status).toBe(0);
      expect(probe.error).toBe(PROBE_PATH_NOT_APPROVED_ERROR);
    }
    // robots.txt and sitemap discovery are not probes and still run.
    expect(origin.hits.some((h) => h.path === "/robots.txt")).toBe(true);
    expect(origin.hits.some((h) => h.path === "/sitemap.xml")).toBe(true);
    expect(out.pages).toBe(2);
  }, 20_000);

  test("only /AGENTS.md approved: no other AGENTS.md variant, no llms request", async () => {
    const origin = serve();
    const out = await crawl(origin.url, {
      discoveryProbes: PATH_PROBES,
      discoveryProbePaths: ["/AGENTS.md"],
    });

    expect(probeHits(origin.hits)).toEqual(["/AGENTS.md"]);
    // llms.txt was selected but not approved: no row, and a marker the rule reads as "not approved".
    expect(out.llms).toBeNull();
    const llmsMarker = out.wellKnown?.probes.find((p) => p.path === "/llms.txt");
    expect(llmsMarker?.error).toBe(PROBE_PATH_NOT_APPROVED_ERROR);
    const agents = out.wellKnown?.probes.find((p) => p.path === "/AGENTS.md");
    expect(agents?.status).toBe(404);
  }, 20_000);

  test("/llms-full.txt is requested only when it is approved too", async () => {
    const origin = serve();
    await crawl(origin.url, {
      discoveryProbes: ["llms-txt"],
      discoveryProbePaths: ["/llms.txt", "/llms-full.txt"],
    });
    expect(probeHits(origin.hits).sort()).toEqual(["/llms-full.txt", "/llms.txt"]);
  }, 20_000);

  test("unset allowlist sends every selected probe (the control)", async () => {
    const origin = serve();
    await crawl(origin.url, { discoveryProbes: PATH_PROBES });
    expect(new Set(probeHits(origin.hits))).toEqual(new Set(PROBE_ONLY_PATHS));
  }, 20_000);

  test("an approved path keeps the per-host limit", async () => {
    const origin = serve(() => undefined, 25);
    await crawl(origin.url, {
      discoveryProbes: PATH_PROBES,
      discoveryProbePaths: ["/llms.txt", "/AGENTS.md", "/agents.md", "/security.txt"],
      perHostConcurrency: 1,
    });
    const probes = origin.hits.filter((h) => PROBE_ONLY_PATHS.includes(h.path));
    expect(probes).toHaveLength(4);
    probes.sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < probes.length; i++) {
      expect(probes[i]!.startedAt).toBeGreaterThanOrEqual(probes[i - 1]!.endedAt - 1);
    }
  }, 20_000);
});

describe("redirects from an approved path (#1655)", () => {
  test("a redirect to another path is not followed and is not a missing file", async () => {
    const origin = serve((path) =>
      path === "/llms.txt" || path === "/AGENTS.md"
        ? new Response(null, { status: 302, headers: { location: "/admin/excluded" } })
        : undefined,
    );
    const out = await crawl(origin.url, {
      discoveryProbes: PATH_PROBES,
      discoveryProbePaths: ["/llms.txt", "/AGENTS.md"],
    });

    expect(origin.hits.some((h) => h.path === "/admin/excluded")).toBe(false);
    // llms.txt got no answer: no row, so the rule says "not checked".
    expect(out.llms).toBeNull();
    const agents = out.wellKnown?.probes.find((p) => p.path === "/AGENTS.md");
    expect(agents?.status).toBe(0);
    expect(agents?.error).toBe(PROBE_REDIRECT_NOT_FOLLOWED_ERROR);
  }, 20_000);

  test("a same-path hop to the canonical host is followed", async () => {
    // localhost redirects to 127.0.0.1, which answers the file: the path never changes.
    const origin = serve((path, base, host) => {
      if (path !== "/llms.txt") return undefined;
      return host.startsWith("localhost")
        ? new Response(null, {
            status: 301,
            headers: { location: `${base.replace("localhost", "127.0.0.1")}/llms.txt` },
          })
        : new Response("# Site\n\n- [a](/a)\n", { headers: { "content-type": "text/plain" } });
    });
    const out = await crawl(origin.url, {
      discoveryProbes: ["llms-txt"],
      discoveryProbePaths: ["/llms.txt"],
    });
    expect(out.llms?.llmsTxt.exists).toBe(true);
    expect(origin.hits.filter((h) => h.path === "/llms.txt")).toHaveLength(2);
  }, 20_000);

  test("without an allowlist a cross-path redirect behaves as before", async () => {
    const origin = serve((path) =>
      path === "/AGENTS.md"
        ? new Response(null, { status: 302, headers: { location: "/moved" } })
        : undefined,
    );
    await crawl(origin.url, { discoveryProbes: ["/AGENTS.md"] });
    expect(origin.hits.some((h) => h.path === "/moved")).toBe(true);
  }, 20_000);
});

describe("block signals stop the optional probes (#1655)", () => {
  test("a 429 on the first well-known path stops the rest, which stay not checked", async () => {
    const first = WELL_KNOWN_PATHS[0];
    const origin = serve((path) =>
      path === first ? new Response("slow down", { status: 429 }) : undefined,
    );
    const out = await crawl(origin.url, { discoveryProbes: ["markdown", ...WELL_KNOWN_PATHS] });

    expect(probeHits(origin.hits)).toEqual([first]);
    const probes = out.wellKnown?.probes ?? [];
    const blocked = probes.find((p) => p.path === first);
    // The 429 itself is no answer about the file: status 0, not a 4xx the rules could read as absence.
    expect(blocked?.status).toBe(0);
    const stopped = probes.filter((p) => p.path !== first);
    expect(stopped.length).toBeGreaterThan(0);
    for (const p of stopped) {
      expect(p.status).toBe(0);
      expect(p.error).toBe(PROBE_STOPPED_ERROR);
    }
    // robots.txt and the sitemap are not optional: they keep working.
    expect(origin.hits.some((h) => h.path === "/robots.txt")).toBe(true);
    expect(origin.hits.some((h) => h.path === "/sitemap.xml")).toBe(true);
    expect(out.pages).toBe(2);
  }, 20_000);

  test("a Cloudflare challenge on /llms.txt stops the well-known sweep", async () => {
    const origin = serve((path) =>
      path === "/llms.txt"
        ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
        : undefined,
    );
    const out = await crawl(origin.url, { discoveryProbes: PATH_PROBES });

    expect(probeHits(origin.hits)).toEqual(["/llms.txt"]);
    expect(out.llms).toBeNull();
    expect((out.wellKnown?.probes ?? []).every((p) => p.status === 0)).toBe(true);
  }, 20_000);

  test("a lone 403 does not stop the probes", async () => {
    const origin = serve((path) =>
      path === "/openapi.json" ? new Response("forbidden", { status: 403 }) : undefined,
    );
    const out = await crawl(origin.url, { discoveryProbes: PATH_PROBES });

    expect(new Set(probeHits(origin.hits))).toEqual(new Set(PROBE_ONLY_PATHS));
    expect(out.wellKnown?.probes.find((p) => p.path === "/openapi.json")?.status).toBe(403);
  }, 20_000);
});
