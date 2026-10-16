// pub#827 end-to-end: a page the crawl reached through a redirect is graded
// against the URL it ended on. `/en/old-slug` 301s to `/en/new-slug`, whose
// hreflang="en" points at itself. The crawl stores the target's response under
// the source URL, so i18n/hreflang compared the self reference with the
// pre-redirect URL and reported "No self-referencing hreflang found".

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

/** The issue's repro server: home links /en/old-slug and /no-self. */
function serve(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const B = `http://localhost:${server.port}`;
      const url = new URL(req.url);
      const page = (hreflang: string) =>
        new Response(
          `<!doctype html><html lang="en"><head><title>Fixture page</title>${hreflang}</head><body><h1>Fixture</h1><a href="/en/old-slug">Old slug</a> <a href="/no-self">No self</a></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      if (url.pathname === "/en/old-slug") {
        return new Response(null, { status: 301, headers: { location: "/en/new-slug" } });
      }
      if (url.pathname === "/en/new-slug") {
        return page(
          `<link rel="alternate" hreflang="en" href="${B}/en/new-slug"><link rel="alternate" hreflang="de" href="${B}/de/neuer-slug">`,
        );
      }
      if (url.pathname === "/no-self") {
        return page(`<link rel="alternate" hreflang="de" href="${B}/de/anders">`);
      }
      return page("");
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["i18n/hreflang"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(engine: "v1" | "v2") {
  const origin = serve();
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
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
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
  const checks = (ran.ruleResultsMap.get("i18n/hreflang")?.checks ?? []) as CheckResult[];
  /** Check names on the page at `path`. */
  const on = (path: string) =>
    checks.filter((c) => c.pageUrl === `${origin}${path}`).map((c) => `${c.name}:${c.status}`).sort();
  return { on };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`i18n/hreflang on a redirected page (pub#827, ${engine})`, () => {
    test("the self reference is compared with the URL the page ended on", async () => {
      const { on } = await audit(engine);
      // The target references itself; it has no x-default, which is a real
      // finding about that markup.
      expect(on("/en/old-slug")).toEqual(["hreflang-xdefault:warn", "hreflang:pass"]);
      // A 200 page with no self reference still warns.
      expect(on("/no-self")).toContain("hreflang-self:warn");
    });
  });
}
