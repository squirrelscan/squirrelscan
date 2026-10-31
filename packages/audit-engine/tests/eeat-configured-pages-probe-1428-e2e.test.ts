// #1428 end to end: a page the rule is configured with (`[rule_options."eeat/about-page"] paths`) that the
// crawl does not reach is requested once after the crawl, through the real crawler, store and rule path.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(" ");
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

interface Fixture {
  origin: string;
  hits: string[];
  /** When each path was first requested (ms), for the per-host spacing. */
  firstHit: Map<string, number>;
  /** The URLs the crawl stored as pages, set by `audit`. */
  stored: string[];
}

/** `/` links to nothing but `/linked`; the configured pages are reachable only by a direct request. */
function serve(opts: { homeLinks?: string } = {}): Fixture {
  const hits: string[] = [];
  const firstHit = new Map<string, number>();
  const other = Bun.serve({
    port: 0,
    fetch: () => new Response(page("Elsewhere", `<p>${words(300)}</p>`), { headers: { "content-type": "text/html" } }),
  });
  servers.push(other);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
      if (!firstHit.has(pathname)) firstHit.set(pathname, performance.now());
      const html = (body: string, status = 200) =>
        new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
      switch (pathname) {
        case "/robots.txt":
          return new Response("User-agent: *\nDisallow: /private-about\n", { headers: { "content-type": "text/plain" } });
        case "/":
          return html(page("Home", `<p>${words(60)}</p>${opts.homeLinks ?? ""}`));
        case "/agentur":
          return html(page("Agentur", `<p>${words(260)}</p>`));
        case "/thin-about":
          return html(page("Thin", `<p>${words(30)}</p>`));
        case "/policies/privacy-policy":
          return html(page("Privacy", `<p>${words(300)}</p>`));
        case "/redir-home":
          return new Response(null, { status: 302, headers: { location: "/" } });
        case "/redir-off":
          return new Response(null, { status: 302, headers: { location: `http://localhost:${other.port}/about` } });
        case "/redir-ok":
          return new Response(null, { status: 301, headers: { location: "/agentur" } });
        case "/json-about":
          return new Response(JSON.stringify({ about: words(300) }), { headers: { "content-type": "application/json" } });
        case "/spa-about":
          return html('<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        case "/private-about":
          return html(page("Private", `<p>${words(260)}</p>`));
        default:
          return html(page("Not found", "<p>nothing here</p>"), 404);
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits, firstHit, stored: [] };
}

function configFor(options: Record<string, unknown>): Config {
  return {
    rule_options: options,
    rules: { enable: ["eeat/about-page", "eeat/privacy-policy"] },
    crawler: { max_pages: 10, exclude: [] },
    external_links: { enabled: false },
    internal_links: { enabled: false },
  } as unknown as Config;
}

async function audit(
  engine: "v1" | "v2",
  fixture: Fixture,
  crawl: { configuredPagePaths?: string[]; discoveryProbes?: string[]; respectRobots?: boolean; exclude?: string[]; perHostDelayMs?: number },
  options: Record<string, unknown>,
): Promise<Map<string, CheckResult[]>> {
  const config = configFor(options);
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: crawl.perHostDelayMs ?? 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: crawl.respectRobots ?? false,
        incremental: false,
        useCacheControl: false,
        ...(crawl.exclude ? { exclude: crawl.exclude } : {}),
        ...(crawl.configuredPagePaths ? { configuredPagePaths: crawl.configuredPagePaths } : {}),
        ...(crawl.discoveryProbes ? { discoveryProbes: crawl.discoveryProbes } : {}),
      } as never,
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${fixture.origin}/`, `${fixture.origin}/`));
  const storage = crawler.storage;
  const stored = await Effect.runPromise(storage.getPages(crawlId));
  fixture.stored = stored.map((p) => p.url);
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, config, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, pre.assets);
      }
      return yield* runStreamingRules(storage, crawlId, config, pre.assets);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  return new Map([...ran.ruleResultsMap].map(([id, r]) => [id, r.checks]));
}

const first = (results: Map<string, CheckResult[]>, rule: string): CheckResult | undefined => results.get(rule)?.[0];

for (const engine of ["v1", "v2"] as const) {
  describe(`configured about and privacy paths are probed when the crawl did not reach them (#1428, ${engine})`, () => {
    test("an unlinked about page and privacy policy that answer 200 are found, each requested once", async () => {
      const fixture = serve();
      const results = await audit(
        engine,
        fixture,
        { configuredPagePaths: ["/agentur", "/policies/privacy-policy"] },
        {
          "eeat/about-page": { paths: ["/agentur"] },
          "eeat/privacy-policy": { paths: ["/policies/privacy-policy"] },
        },
      );
      expect(first(results, "eeat/about-page")?.status).toBe("pass");
      expect(first(results, "eeat/about-page")?.message).toContain("found by probing /agentur");
      expect(first(results, "eeat/privacy-policy")?.status).toBe("pass");
      expect(fixture.hits.filter((p) => p === "/agentur")).toHaveLength(1);
      expect(fixture.hits.filter((p) => p === "/policies/privacy-policy")).toHaveLength(1);
    });

    test("a thin probed about page is info, not missing", async () => {
      const fixture = serve();
      const results = await audit(engine, fixture, { configuredPagePaths: ["/thin-about"] }, { "eeat/about-page": { paths: ["/thin-about"] } });
      expect(first(results, "eeat/about-page")?.status).toBe("info");
      expect(first(results, "eeat/about-page")?.message).toContain("limited content");
    });

    test("a configured path that answers 404 still reports the page missing and says it was probed", async () => {
      const fixture = serve();
      const results = await audit(engine, fixture, { configuredPagePaths: ["/gone"] }, { "eeat/about-page": { paths: ["/gone"] } });
      const about = first(results, "eeat/about-page");
      expect(about?.status).toBe("warn");
      expect(about?.message).toBe("No About page found (probed /gone: 404)");
      expect(fixture.hits.filter((p) => p === "/gone")).toHaveLength(1);
    });

    test("a path robots.txt disallows is not requested, and the finding says so", async () => {
      const fixture = serve();
      const results = await audit(
        engine,
        fixture,
        { configuredPagePaths: ["/private-about"], respectRobots: true },
        { "eeat/about-page": { paths: ["/private-about"] } },
      );
      const about = first(results, "eeat/about-page");
      expect(about?.status).toBe("warn");
      expect(about?.message).toContain("disallowed by robots.txt");
      expect(fixture.hits).not.toContain("/private-about");
    });

    test("with the discovery probes off nothing is requested and the finding is the plain missing one", async () => {
      const fixture = serve();
      const results = await audit(
        engine,
        fixture,
        { configuredPagePaths: ["/agentur"], discoveryProbes: [] },
        { "eeat/about-page": { paths: ["/agentur"] } },
      );
      expect(first(results, "eeat/about-page")?.message).toBe("No About page found");
      expect(fixture.hits).not.toContain("/agentur");
    });

    test("a configured page the crawl reached is not requested a second time", async () => {
      const fixture = serve({ homeLinks: '<a href="/agentur">Agentur</a>' });
      const results = await audit(engine, fixture, { configuredPagePaths: ["/agentur"] }, { "eeat/about-page": { paths: ["/agentur"] } });
      expect(first(results, "eeat/about-page")?.status).toBe("pass");
      expect(first(results, "eeat/about-page")?.message).not.toContain("probing");
      expect(fixture.hits.filter((p) => p === "/agentur")).toHaveLength(1);
    });

    test("an answer that is not a page of the site is still reported missing, with the reason", async () => {
      const fixture = serve();
      const paths = ["/redir-home", "/redir-off", "/json-about", "/spa-about"];
      for (const path of paths) {
        const results = await audit(engine, fixture, { configuredPagePaths: [path] }, { "eeat/about-page": { paths: [path] } });
        const about = first(results, "eeat/about-page");
        expect(about?.status).toBe("warn");
        expect(about?.message).toContain(`probed ${path}`);
      }
      const reason = async (path: string) =>
        first(await audit(engine, serve(), { configuredPagePaths: [path] }, { "eeat/about-page": { paths: [path] } }), "eeat/about-page")?.message;
      expect(await reason("/redir-home")).toContain("redirected to /");
      expect(await reason("/redir-off")).toMatch(/redirected to another site|probed \/redir-off\)?/);
      expect(await reason("/json-about")).toContain("not an HTML page");
      expect(await reason("/spa-about")).toContain("no readable page content");
    });

    test("a redirect inside the site to a real page is the page", async () => {
      const fixture = serve();
      const results = await audit(engine, fixture, { configuredPagePaths: ["/redir-ok"] }, { "eeat/about-page": { paths: ["/redir-ok"] } });
      expect(first(results, "eeat/about-page")?.status).toBe("pass");
    });

    test("the privacy rule reports a 404 as missing and says what was probed", async () => {
      const fixture = serve();
      const results = await audit(engine, fixture, { configuredPagePaths: ["/policies/gone"] }, { "eeat/privacy-policy": { paths: ["/policies/gone"] } });
      expect(first(results, "eeat/privacy-policy")?.status).toBe("warn");
      expect(first(results, "eeat/privacy-policy")?.message).toBe("No Privacy Policy page found (probed /policies/gone: 404)");
    });

    test("a probed page is a probe result: it is not stored as a crawled page", async () => {
      const fixture = serve();
      await audit(engine, fixture, { configuredPagePaths: ["/agentur"] }, { "eeat/about-page": { paths: ["/agentur"] } });
      expect(fixture.hits).toContain("/agentur");
      expect(fixture.stored.some((u) => u.endsWith("/agentur"))).toBe(false);
    });

    test("a path the crawl's own scope excludes is not requested", async () => {
      const fixture = serve();
      const results = await audit(engine, fixture, { configuredPagePaths: ["/agentur"], exclude: ["/agentur"] }, { "eeat/about-page": { paths: ["/agentur"] } });
      expect(fixture.hits).not.toContain("/agentur");
      expect(first(results, "eeat/about-page")?.message).toBe("No About page found");
    });

    test("the probes go through the per-host delay, like the other requests", async () => {
      const fixture = serve();
      await audit(
        engine,
        fixture,
        { configuredPagePaths: ["/agentur", "/thin-about"], discoveryProbes: ["configured-pages"], perHostDelayMs: 300 },
        { "eeat/about-page": { paths: ["/agentur", "/thin-about"] } },
      );
      const a = fixture.firstHit.get("/agentur");
      const b = fixture.firstHit.get("/thin-about");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(Math.abs((a ?? 0) - (b ?? 0))).toBeGreaterThanOrEqual(150);
    });
  });
}

describe("the probed note is bounded", () => {
  test("many paths are shown as five and a count", async () => {
    const { probedNote } = await import("../../rules/src/shared/eeat-paths");
    const probes = Array.from({ length: 50 }, (_, i) => ({
      path: `/${"x".repeat(i < 2 ? 600 : 5)}${i}`,
      url: "https://e.test/",
      outcome: "missing" as const,
      status: 404,
      reason: "404",
      wordCount: null,
    }));
    const note = probedNote(probes);
    expect(note).toContain("and 45 more");
    expect(note.length).toBeLessThan(700);
  });
});
