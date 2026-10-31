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
}

/** `/` links to nothing but `/linked`; the configured pages are reachable only by a direct request. */
function serve(opts: { homeLinks?: string } = {}): Fixture {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
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
        case "/private-about":
          return html(page("Private", `<p>${words(260)}</p>`));
        default:
          return html(page("Not found", "<p>nothing here</p>"), 404);
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits };
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
  crawl: { configuredPagePaths?: string[]; discoveryProbes?: string[]; respectRobots?: boolean },
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
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: crawl.respectRobots ?? false,
        incremental: false,
        useCacheControl: false,
        ...(crawl.configuredPagePaths ? { configuredPagePaths: crawl.configuredPagePaths } : {}),
        ...(crawl.discoveryProbes ? { discoveryProbes: crawl.discoveryProbes } : {}),
      } as never,
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${fixture.origin}/`, `${fixture.origin}/`));
  const storage = crawler.storage;
  const stored = await Effect.runPromise(storage.getPages(crawlId));
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
  });
}
