// A crawl is about the URL the user asked for. A seed redirect that leaves that
// site is refused, never adopted as the crawl's base — adopting it re-points
// every root probe (robots.txt, llms.txt, sitemap discovery, the well-known /
// agent-manifest sweep) at a host the user never named, and files that host's
// content under the seed's name.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { isOffSiteFinalUrl, resolveSeedRedirect } from "../src/frontier";
import { SQLiteStorage } from "../src/storage/sqlite";
import { WELL_KNOWN_PATHS } from "../src/well-known";

// Paths a crawl sweeps against its base origin, beyond the well-known set.
const ROOT_PROBE_PATHS = [
  "/robots.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/sitemap.xml",
  "/sitemap_index.xml",
];

const DISCOVERY_PATHS = [...WELL_KNOWN_PATHS, ...ROOT_PROBE_PATHS];

// Markers that must never reach the report when the redirect target is refused.
const TARGET_TITLE = "Internal Service Console";
const TARGET_BODY = "s3cr3t-internal-marker";
const TARGET_PATH = "/internal-secret";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 5,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 2000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
};

interface RecordingServer {
  origin: string;
  paths: string[];
  stop: () => void;
}

/** Server B: answers everything with the marker document, logging each path. */
function serveTarget(): RecordingServer {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      paths.push(new URL(req.url).pathname);
      return new Response(
        `<!doctype html><html><head><title>${TARGET_TITLE}</title></head><body><p>${TARGET_BODY}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    paths,
    stop: () => server.stop(true),
  };
}

/**
 * Server A: a SINGLE 302 on `/` pointing at `location`; every other path 404s.
 * One redirect is all it takes — the amplification comes from re-basing, not
 * from the server.
 */
function serveSingleRedirect(location: string): RecordingServer {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      paths.push(path);
      if (path === "/") {
        return new Response(null, { status: 302, headers: { location } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    paths,
    stop: () => server.stop(true),
  };
}

const servers: RecordingServer[] = [];

function track(server: RecordingServer): RecordingServer {
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop();
});

async function crawl(targetUrl: string, originalUrl: string, config: Partial<CrawlerConfig> = {}) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: { ...CONFIG, ...config }, storage });
      const crawlId = yield* crawler.start(targetUrl, originalUrl);
      const meta = yield* storage.getCrawl(crawlId);
      const pages = yield* storage.getPages(crawlId);
      const robots = yield* storage.getRobotsTxt(crawlId);
      const llms = yield* storage.getLlmsTxt(crawlId);
      const wellKnown = yield* storage.getWellKnownProbe(crawlId);
      const markdown = yield* storage.getMarkdownProbe(crawlId);
      return { meta, pages, robots, llms, wellKnown, markdown };
    }),
  );
}

describe("seed redirect that leaves the seed's site", () => {
  test("keeps the base pinned to the seed and never sweeps the target", async () => {
    const target = track(serveTarget());
    const seed = track(serveSingleRedirect(`${target.origin}${TARGET_PATH}`));

    const { meta, pages, robots, llms, wellKnown, markdown } = await crawl(
      `${seed.origin}/`,
      `${seed.origin}/`,
    );

    // The audit is about the seed, not whatever it bounced to.
    expect(meta?.baseUrl).toBe(seed.origin);
    expect(meta?.originalUrl).toBe(`${seed.origin}/`);

    // The target saw the one redirect hop and nothing else. Every discovery
    // probe went to the seed.
    expect(new Set(target.paths)).toEqual(new Set([TARGET_PATH]));
    for (const path of DISCOVERY_PATHS) {
      expect(target.paths).not.toContain(path);
    }
    expect(seed.paths).toContain("/robots.txt");
    expect(seed.paths.length).toBeGreaterThan(DISCOVERY_PATHS.length / 2);

    // None of the target's content is anywhere in what the report is built from.
    const stored = JSON.stringify({ pages, robots, llms, wellKnown, markdown });
    expect(stored).not.toContain(TARGET_TITLE);
    expect(stored).not.toContain(TARGET_BODY);

    // The refused seed is the only page attempted, and it stored no body.
    expect(pages.filter((p) => p.html)).toHaveLength(0);
  });

  test("pins to the seed even when the caller pre-resolved the redirect", async () => {
    // The CLI resolves redirects itself and hands start() the ALREADY-RESOLVED
    // URL, with the user's URL as originalUrl. The seed is the user's URL.
    const target = track(serveTarget());
    const seed = track(serveSingleRedirect(`${target.origin}${TARGET_PATH}`));

    const { meta, pages } = await crawl(`${target.origin}${TARGET_PATH}`, `${seed.origin}/`);

    expect(meta?.baseUrl).toBe(seed.origin);
    // The refused target is still recorded, just not adopted — that divergence
    // between seedUrl and baseUrl is what surfaces as the report's finalUrl.
    expect(meta?.seedUrl).toBe(`${target.origin}${TARGET_PATH}`);
    expect(meta?.originalUrl).toBe(`${seed.origin}/`);

    // Non-vacuous: the crawl really did run against the seed (its root probes
    // landed there), and the target really was reachable — it just never saw
    // anything beyond the one hop the seed's own 302 produced.
    expect(seed.paths).toContain("/robots.txt");
    expect(seed.paths.length).toBeGreaterThan(DISCOVERY_PATHS.length / 2);
    expect(new Set(target.paths)).toEqual(new Set([TARGET_PATH]));

    for (const path of DISCOVERY_PATHS) {
      expect(target.paths).not.toContain(path);
    }
    const stored = JSON.stringify(pages);
    expect(stored).not.toContain(TARGET_TITLE);
    expect(stored).not.toContain(TARGET_BODY);
  });
});

describe("scope config the user asked for", () => {
  test("a cross-site landing listed in allowedDomains is still crawled", async () => {
    const target = track(serveTarget());
    const seed = track(serveSingleRedirect(`${target.origin}${TARGET_PATH}`));

    const { meta, pages } = await crawl(`${seed.origin}/`, `${seed.origin}/`, {
      allowedDomains: ["127.0.0.1"],
    });

    // The base still never moves — only the drop guard defers to the config.
    expect(meta?.baseUrl).toBe(seed.origin);
    expect(pages.some((p) => p.finalUrl === `${target.origin}${TARGET_PATH}`)).toBe(true);
  });
});

describe("seed redirect that stays on the seed's site", () => {
  test("same-origin redirect still crawls normally", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        paths.push(path);
        if (path === "/") {
          return new Response(null, { status: 302, headers: { location: "/en" } });
        }
        if (path === "/en") {
          return new Response("<!doctype html><html><head><title>Home</title></head></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    track({ origin, paths, stop: () => server.stop(true) });

    const { meta, pages } = await crawl(`${origin}/`, `${origin}/`);

    expect(meta?.baseUrl).toBe(origin);
    expect(pages.map((p) => p.finalUrl)).toContain(`${origin}/en`);
  });
});

describe("resolveSeedRedirect", () => {
  const adopted = (seed: string, final: string) => resolveSeedRedirect(seed, final);

  test("adopts a redirect within the seed's registrable domain", () => {
    expect(adopted("https://example.com/", "https://www.example.com/")).toEqual({
      baseUrl: "https://www.example.com",
      seedUrl: "https://www.example.com/",
      offSite: false,
    });
    expect(adopted("https://example.com/", "https://app.example.com/home").baseUrl).toBe(
      "https://app.example.com",
    );
    // Multi-label public suffixes come from the real PSL, not a curated table.
    expect(adopted("https://example.co.uk/", "https://www.example.co.uk/").offSite).toBe(false);
  });

  test("adopts an http→https upgrade", () => {
    expect(adopted("http://example.com/", "https://example.com/")).toEqual({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com/",
      offSite: false,
    });
  });

  test("refuses a redirect to another registrable domain", () => {
    expect(adopted("https://example.com/", "https://cdn.example.net/x")).toEqual({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com/",
      offSite: true,
    });
    expect(adopted("https://example.co.uk/", "https://evil.co.uk/").offSite).toBe(true);
  });

  test("refuses a port hop on the same host", () => {
    // The loopback pivot: same hostname, different service.
    expect(adopted("http://127.0.0.1:8750/", "http://127.0.0.1:8751/internal")).toEqual({
      baseUrl: "http://127.0.0.1:8750",
      seedUrl: "http://127.0.0.1:8750/",
      offSite: true,
    });
    expect(adopted("http://localhost:3000/", "http://localhost:9229/json").offSite).toBe(true);
  });

  test("refuses a hop between tenants of a shared hosting platform", () => {
    // allowPrivateDomains keeps `*.pages.dev` per-tenant rather than one site.
    expect(adopted("https://mine.pages.dev/", "https://theirs.pages.dev/").offSite).toBe(true);
  });

  test("refuses a hop between different loopback hosts", () => {
    expect(adopted("http://localhost:8080/", "http://127.0.0.1:8080/").offSite).toBe(true);
  });

  test("keeps the resolved URL as the seed when nothing moved", () => {
    expect(adopted("https://example.com/", "https://example.com/en")).toEqual({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com/en",
      offSite: false,
    });
  });

  test("unparseable input falls back instead of throwing", () => {
    expect(adopted("not a url", "https://example.com/").baseUrl).toBe("https://example.com");
    expect(adopted("https://example.com/", "not a url")).toEqual({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com/",
      offSite: false,
    });
  });

  test("a nested-scheme seed never lends its embedded origin to the base", () => {
    // `new URL("blob:https://evil.test/x").origin` is "https://evil.test" — a
    // host nothing ever fetched. Basing the crawl on it would sweep every root
    // probe against it, so an unusable seed pins to what WAS fetched instead.
    expect(adopted("blob:https://evil.test/x", "https://example.com/")).toEqual({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com/",
      offSite: false,
    });
    expect(adopted("about:blank", "https://example.com/").baseUrl).toBe("https://example.com");
  });

  test("a non-http landing is not adopted", () => {
    expect(adopted("https://example.com/", "blob:https://evil.test/x")).toEqual({
      baseUrl: "https://example.com",
      seedUrl: "https://example.com/",
      offSite: false,
    });
  });

  test("host spellings that normalize to the same site are not off-site", () => {
    expect(adopted("https://example.com/", "https://WWW.EXAMPLE.COM/").offSite).toBe(false);
    // Trailing-dot (fully qualified) form of the same host.
    expect(adopted("https://example.com/", "https://www.example.com./").offSite).toBe(false);
    // Explicit default port is normalized away by WHATWG URL, so it is same-origin.
    expect(adopted("https://example.com/", "https://example.com:443/en").baseUrl).toBe(
      "https://example.com",
    );
  });

  test("userinfo does not smuggle a different host past the check", () => {
    expect(adopted("https://example.com/", "https://example.com@evil.test/").offSite).toBe(true);
  });

  test("distinct IPv6 literals are different sites", () => {
    expect(adopted("http://[::1]:8750/", "http://[::1]:8751/").offSite).toBe(true);
    expect(adopted("http://[::1]:8750/", "http://[::2]:8750/").offSite).toBe(true);
    expect(adopted("http://[::1]:8750/", "http://[0:0:0:0:0:0:0:1]:8750/x").offSite).toBe(false);
  });
});

describe("isOffSiteFinalUrl", () => {
  test("same-site hops are storable", () => {
    expect(isOffSiteFinalUrl("https://example.com", "https://example.com/a")).toBe(false);
    expect(isOffSiteFinalUrl("https://example.com", "https://www.example.com/a")).toBe(false);
    expect(isOffSiteFinalUrl("http://example.com", "https://example.com/a")).toBe(false);
  });

  test("cross-site hops are not", () => {
    expect(isOffSiteFinalUrl("https://example.com", "https://evil.test/a")).toBe(true);
    expect(isOffSiteFinalUrl("http://127.0.0.1:8750", "http://127.0.0.1:8751/a")).toBe(true);
  });

  test("an absent final URL is no evidence of a redirect", () => {
    expect(isOffSiteFinalUrl("https://example.com", "")).toBe(false);
  });

  test("a landing we cannot attribute fails closed", () => {
    expect(isOffSiteFinalUrl("https://example.com", "not a url")).toBe(true);
    expect(isOffSiteFinalUrl("https://example.com", "blob:https://example.com/x")).toBe(true);
  });
});
