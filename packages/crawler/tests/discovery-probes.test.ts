// squirrelscan/squirrelscan#409 — the pre-crawl discovery probes can be turned
// off, follow the rule selection, and queue behind the per-host throttle.
//
// A common fail2ban "sensitive files" jail bans a client that asks for
// /swagger.json or /openapi.json, so on such a host the probes got the audit
// banned before its first page, and nothing short of not sending them helped.
// Every assertion here is on what reached the origin.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import { PROBE_NOT_ATTEMPTED_ERROR, WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";

import { createCrawler, preambleBudgetMs } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<a href="/one">one</a></body></html>`;

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 2,
  concurrency: 2,
  perHostConcurrency: 5,
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

interface Hit {
  path: string;
  userAgent: string;
  accept: string;
  startedAt: number;
  endedAt: number;
}

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

// Every path answers: the robots.txt names a sitemap, real pages are HTML and
// everything else is a 404 after `latencyMs`, so overlapping requests show up.
function serve(latencyMs = 0): { url: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const hit: Hit = {
        path,
        userAgent: req.headers.get("user-agent") ?? "",
        accept: req.headers.get("accept") ?? "",
        startedAt: performance.now(),
        endedAt: 0,
      };
      hits.push(hit);
      if (latencyMs > 0) await Bun.sleep(latencyMs);
      hit.endedAt = performance.now();
      if (path === "/robots.txt") {
        return new Response(`User-agent: *\nSitemap: http://localhost:${server.port}/sitemap.xml\n`);
      }
      if (path === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>http://localhost:${server.port}/one</loc></url></urlset>`,
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
    markdown: await read(s.getMarkdownProbe(crawlId)),
    wellKnown: await read(s.getWellKnownProbe(crawlId)),
    agentAccess: await read(s.getAgentAccess(crawlId)),
    rsl: await read(s.getRsl(crawlId)),
  };
}

const PROBE_ONLY_PATHS = ["/llms.txt", "/llms-full.txt", "/index.md", ...WELL_KNOWN_PATHS];
const count = (hits: Hit[], path: string) => hits.filter((h) => h.path === path).length;
// Homepage fetches only the probes make: markdown negotiation and the AI-crawler UAs.
const homepageProbes = (hits: Hit[]) =>
  hits.filter(
    (h) =>
      h.path === "/" &&
      (h.accept.startsWith("text/markdown") || /GPTBot|Claude-User/.test(h.userAgent)),
  );

describe("discovery probes (#409)", () => {
  test("default: every probe goes out (the control)", async () => {
    const origin = serve();
    const out = await crawl(origin.url, {});

    for (const path of PROBE_ONLY_PATHS) expect(count(origin.hits, path)).toBe(1);
    // markdown negotiation + GPTBot + Claude-User; the browser-UA probe is indistinguishable
    expect(homepageProbes(origin.hits)).toHaveLength(3);
    // The crawl's robots.txt read plus RSL's re-read.
    expect(count(origin.hits, "/robots.txt")).toBe(2);
    expect(out.wellKnown?.probes).toHaveLength(WELL_KNOWN_PATHS.length);
  });

  test("an empty selection sends no probe; robots.txt and sitemaps still run", async () => {
    const origin = serve();
    const out = await crawl(origin.url, { discoveryProbes: [] });

    for (const path of PROBE_ONLY_PATHS) expect(count(origin.hits, path)).toBe(0);
    expect(homepageProbes(origin.hits)).toEqual([]);
    expect(count(origin.hits, "/robots.txt")).toBe(1);
    expect(count(origin.hits, "/sitemap.xml")).toBeGreaterThan(0);
    expect(out.pages).toBe(2);
    expect(out.robots?.exists).toBe(true);

    // Nothing stored, so the rules that read these report "not checked".
    expect(out.llms).toBeNull();
    expect(out.markdown).toBeNull();
    expect(out.wellKnown).toBeNull();
    expect(out.agentAccess).toBeNull();
    expect(out.rsl).toBeNull();
  });

  test("a selection sends exactly the probes it lists", async () => {
    const origin = serve();
    const out = await crawl(origin.url, { discoveryProbes: ["llms-txt", "/AGENTS.md"] });

    expect(count(origin.hits, "/llms.txt")).toBe(1);
    expect(count(origin.hits, "/AGENTS.md")).toBe(1);
    for (const path of WELL_KNOWN_PATHS.filter((p) => p !== "/AGENTS.md")) {
      expect(count(origin.hits, path)).toBe(0);
    }
    expect(count(origin.hits, "/swagger.json")).toBe(0);
    expect(homepageProbes(origin.hits)).toEqual([]);
    expect(out.wellKnown?.probes.map((p) => p.path)).toEqual(["/AGENTS.md"]);
    expect(out.llms).not.toBeNull();
    expect(out.markdown).toBeNull();
  });

  test("probes obey per_host_concurrency and per_host_delay_ms", async () => {
    const DELAY_MS = 40;
    const origin = serve(15);
    await crawl(origin.url, { perHostConcurrency: 1, perHostDelayMs: DELAY_MS });

    const probes = origin.hits.filter((h) => PROBE_ONLY_PATHS.includes(h.path));
    expect(probes).toHaveLength(PROBE_ONLY_PATHS.length);

    // One in flight at a time: each probe starts after the previous one ended.
    // Before #409 the well-known sweep sent all 20 at once.
    for (let i = 1; i < probes.length; i++) {
      expect(probes[i]!.startedAt).toBeGreaterThanOrEqual(probes[i - 1]!.endedAt);
    }
    // And starts are spaced by the per-host delay. The scheduler reserves start
    // slots DELAY_MS apart, so the whole run spans at least that per gap; one
    // gap can arrive a little early (timer and socket jitter), but never as a
    // burst.
    const span = probes.at(-1)!.startedAt - probes[0]!.startedAt;
    expect(span).toBeGreaterThanOrEqual((probes.length - 1) * DELAY_MS - 10);
    for (let i = 1; i < probes.length; i++) {
      expect(probes[i]!.startedAt - probes[i - 1]!.startedAt).toBeGreaterThanOrEqual(DELAY_MS / 2);
    }
  }, 30_000);

  test("a higher per_host_concurrency lets that many probes overlap, and no more", async () => {
    const origin = serve(30);
    await crawl(origin.url, { perHostConcurrency: 3, perHostDelayMs: 0 });

    const wellKnown = origin.hits.filter((h) =>
      (WELL_KNOWN_PATHS as readonly string[]).includes(h.path),
    );
    let peak = 0;
    for (const h of wellKnown) {
      const overlapping = wellKnown.filter(
        (o) => o.startedAt <= h.startedAt && o.endedAt > h.startedAt,
      ).length;
      peak = Math.max(peak, overlapping);
    }
    expect(peak).toBe(3);
  }, 30_000);

  test("probes still queued when the budget runs out skip at the deadline, not after", async () => {
    // A 100ms request timeout makes a 300ms preamble budget, and 100ms spacing
    // fits about three probes into it. The rest must skip when the budget ends
    // instead of each sitting out its own 100ms first (that took ~1.9s).
    const TIMEOUT_MS = 100;
    const BUDGET_MS = preambleBudgetMs(TIMEOUT_MS);
    const origin = serve();
    // Well-known only: llms and markdown would otherwise use up most of the
    // budget before the 20-path queue forms, and the overrun would not show.
    const out = await crawl(origin.url, {
      timeoutMs: TIMEOUT_MS,
      perHostConcurrency: 1,
      perHostDelayMs: 100,
      discoveryProbes: [...WELL_KNOWN_PATHS],
    });

    const first = origin.hits[0]!.startedAt;
    const sitemap = origin.hits.find((h) => h.path === "/sitemap.xml")!;
    expect(sitemap.startedAt - first).toBeLessThan(BUDGET_MS + 250);
    const sent = origin.hits.filter((h) => PROBE_ONLY_PATHS.includes(h.path)).length;
    expect(sent).toBeLessThan(8);
    // The ones that did not go out say why, so their rules report "not checked".
    const skipped = out.wellKnown?.probes.filter((p) => p.error === PROBE_NOT_ATTEMPTED_ERROR);
    expect(skipped?.length).toBeGreaterThan(0);
  }, 30_000);

  test("interrupting the crawl stops the probes still waiting for a slot", async () => {
    const origin = serve();
    const crawler = await Effect.runPromise(
      createCrawler({ config: { ...CONFIG, perHostConcurrency: 1, perHostDelayMs: 100 } }),
    );
    const fiber = Effect.runFork(crawler.start(origin.url, origin.url));
    await Bun.sleep(400);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const interruptedAt = performance.now();
    const sentBefore = origin.hits.filter((h) => PROBE_ONLY_PATHS.includes(h.path)).length;
    expect(sentBefore).toBeGreaterThan(0);
    expect(sentBefore).toBeLessThan(PROBE_ONLY_PATHS.length);

    await Bun.sleep(600);
    // A request already on the wire may land a moment later; nothing new starts.
    const late = origin.hits.filter((h) => h.startedAt > interruptedAt + 50);
    expect(late).toEqual([]);
  }, 30_000);
});
