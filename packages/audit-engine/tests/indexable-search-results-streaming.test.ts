// crawl/indexable-search-results (#1696) through both engines on a tiny crawl.
// The rule is a site rule that reads scalars only (url, headers, meta, h1,
// schemas.website). The streaming engine gives site rules no DOM, so the same
// verdict from v1 and v2 proves nothing in the rule needs one.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const RULE_ID = "crawl/indexable-search-results";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const LINKS = [
  "/search?q=shoes",
  "/search?q=hidden",
  "/search?q=headerblocked",
  "/?s=foo",
  "/shop?q=red",
  "/search",
];

function serve(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const ld = `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        potentialAction: {
          "@type": "SearchAction",
          target: `http://${url.host}/?s={search_term_string}`,
        },
      })}</script>`;
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      let head = "";
      if (url.search === "?q=hidden") head = '<meta name="robots" content="noindex">';
      if (url.search === "?q=headerblocked") headers["x-robots-tag"] = "noindex";
      const home = url.pathname === "/" && url.search === "";
      const links = LINKS.map((p) => `<a href="${p}">${p}</a>`).join(" ");
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${url.pathname}</title>${head}${home ? ld : ""}</head><body><h1>Page</h1>${home ? links : ""}</body></html>`,
        { headers },
      );
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const CONFIG = {
  rule_options: {},
  rules: { enable: [RULE_ID] },
  crawler: { max_pages: 20, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(engine: "v1" | "v2") {
  const origin = serve();
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
  const stored = await Effect.runPromise(storage.getPages(crawlId));
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, pre.assets);
      }
      return yield* runStreamingRules(storage, crawlId, CONFIG, pre.assets);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  const checks = ran.ruleResultsMap.get(RULE_ID)?.checks ?? [];
  // Strip the origin: the port differs per run.
  return JSON.parse(JSON.stringify(checks).split(origin).join("ORIGIN")) as CheckResult[];
}

describe("crawl/indexable-search-results through the engines (#1696)", () => {
  test("v2 (no DOM for site rules) matches v1 on a small crawl", async () => {
    const v1 = await audit("v1");
    const v2 = await audit("v2");
    expect(v2).toEqual(v1);
  }, 60_000);

  test("verdict: noindex and header-blocked URLs are not listed, unconfirmed ones are counted", async () => {
    const checks = await audit("v2");
    expect(checks).toHaveLength(1);
    const c = checks[0]!;
    expect(c.name).toBe("indexable-search-results");
    expect(c.status).toBe("warn");
    // /search?q=shoes and /?s=foo (SearchAction template) are listed; /search?q=hidden and
    // /search?q=headerblocked are found but excluded; /shop?q=red is unconfirmed.
    expect(c.message).toBe("4 internal search result URL(s) found, 2 indexable");
    expect(c.value).toContain("/?s=foo");
    expect(c.value).toContain("/search?q=shoes");
    expect(c.value).not.toContain("hidden");
    expect(c.value).not.toContain("headerblocked");
    expect(c.value).toContain("1 unconfirmed");
  }, 60_000);
});
