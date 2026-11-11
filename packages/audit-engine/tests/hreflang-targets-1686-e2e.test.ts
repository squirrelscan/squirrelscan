// #1686 end-to-end: i18n/hreflang-targets is a site rule, so the streaming engine
// (v2) gives it no DOM and it reads ctx.collectedSignals. v1 and v2 must agree.
// The fixture server is crawled for real; the rule sends no request of its own.

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

/** Home links every page; /en names a redirect, a 404, a noindex page and a page with no return link. */
function serve(): { origin: string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const B = `http://localhost:${server.port}`;
      const url = new URL(req.url);
      hits.push(url.pathname);
      const page = (head: string, body = "") =>
        new Response(
          `<!doctype html><html lang="en"><head><title>Fixture page</title>${head}</head><body><h1>Fixture</h1>${body}</body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      const alt = (l: string, p: string) =>
        `<link rel="alternate" hreflang="${l}" href="${B}${p}">`;
      if (url.pathname === "/old-de")
        return new Response(null, { status: 301, headers: { location: "/de" } });
      if (url.pathname === "/old-fi")
        return new Response(null, { status: 301, headers: { location: "/fi" } });
      if (url.pathname === "/gone")
        return new Response("gone", { status: 404, headers: { "content-type": "text/html" } });
      if (url.pathname === "/en") {
        return page(
          alt("en", "/en") +
            alt("de", "/old-de") +
            alt("fr", "/gone") +
            alt("es", "/es") +
            alt("it", "/it") +
            alt("pt", "/pt") +
            alt("fi", "/fi") +
            alt("sv", "/sv"),
        );
      }
      if (url.pathname === "/de") return page(alt("de", "/de") + alt("en", "/en"));
      if (url.pathname === "/es")
        return page('<meta name="robots" content="noindex">' + alt("es", "/es") + alt("en", "/en"));
      // /it names other versions but not /en.
      if (url.pathname === "/it") return page(alt("it", "/it") + alt("de", "/de"));
      if (url.pathname === "/pt") return page(alt("pt", "/pt") + alt("en", "/en"), "");
      const links = ["/en", "/de", "/old-de", "/gone", "/es", "/it", "/pt", "/old-fi"]
        .map((p) => `<a href="${p}">${p}</a>`)
        .join(" ");
      return page("", links);
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits };
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["i18n/hreflang-targets"] },
  crawler: { max_pages: 20, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(engine: "v1" | "v2") {
  const { origin, hits } = serve();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 20,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
  const hitsAfterCrawl = hits.length;
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, pre.assets);
      }
      return yield* runStreamingRules(storage, crawlId, CONFIG, pre.assets);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  const checks = (ran.ruleResultsMap.get("i18n/hreflang-targets")?.checks ?? []) as CheckResult[];
  const ids = (name: string) =>
    (checks.find((c) => c.name === name)?.items ?? [])
      .map((i) => i.id.replaceAll(origin, ""))
      .sort();
  return { checks, ids, requestsDuringRule: hits.length - hitsAfterCrawl };
}

const results: Record<string, Awaited<ReturnType<typeof audit>>> = {};

for (const engine of ["v1", "v2"] as const) {
  describe(`i18n/hreflang-targets over a crawled site (#1686, ${engine})`, () => {
    test("reports the redirect, the 404, the noindex page and the missing return link", async () => {
      const r = (results[engine] = await audit(engine));
      // /fi is the final URL of /old-fi: it is not a redirect, and the redirect's destination is
      // crawled as a page of its own (#1762), so it is checked. /sv is linked from nowhere and
      // never crawled.
      expect(r.ids("hreflang-to-redirect")).toEqual(["/en -> /old-de"]);
      expect(r.ids("hreflang-not-checked")).toEqual(["/sv"]);
      expect(r.ids("hreflang-to-broken")).toEqual(["/en -> /gone"]);
      expect(r.ids("hreflang-to-non-indexable")).toEqual(["/en -> /es"]);
      // /en names /old-de, not /de, so /de has no return link to /en either.
      expect(r.ids("hreflang-no-return-link")).toEqual(["/de -> /en", "/en -> /it", "/it -> /de"]);
    }, 30_000);

    test("sends no request of its own", () => {
      expect(results[engine]!.requestsDuringRule).toBe(0);
    });
  });
}

describe("i18n/hreflang-targets v1 and v2 agree (#1686)", () => {
  test("the same checks come out of both engines", () => {
    const strip = (r: (typeof results)[string]) =>
      JSON.stringify(r.checks).replaceAll(/http:\/\/localhost:\d+/g, "");
    expect(strip(results.v2!)).toBe(strip(results.v1!));
  });
});
