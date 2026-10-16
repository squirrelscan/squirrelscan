// pub#674 end-to-end: the charset of the Content-Type header reaches
// core/charset through the real fetcher, store and rule path. The crawler kept
// only the media type, so a page declared UTF-8 by its header alone failed
// "No charset declaration found", and a header that contradicted the meta was
// never seen.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Path -> [Content-Type header, extra head markup]. */
const PAGES: Record<string, [string, string]> = {
  "/header-only": ["text/html; charset=utf-8", ""],
  "/quoted": ['text/html; charset="UTF-8"', ""],
  "/conflict": ["text/html; charset=iso-8859-1", '<meta charset="utf-8">'],
  "/none": ["text/html", ""],
};

function serve(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const [contentType, head] = PAGES[pathname] ?? ["text/html; charset=utf-8", ""];
      const links = Object.keys(PAGES)
        .map((p) => `<a href="${p}">${p}</a>`)
        .join(" ");
      return new Response(
        `<!doctype html><html lang="en"><head>${head}<title>Fixture page</title></head><body><h1>Fixture</h1>${links}</body></html>`,
        { headers: { "content-type": contentType } },
      );
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["core/charset"] },
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
  const checks = (ran.ruleResultsMap.get("core/charset")?.checks ?? []) as CheckResult[];
  /** `status: message` of the charset check on the page at `path`. */
  const on = (path: string) => {
    const c = checks.find((x) => x.pageUrl === `${origin}${path}`);
    return c ? `${c.status}: ${c.message}` : undefined;
  };
  /** The stored headers of the page at `path`. */
  const storedHeaders = (path: string) =>
    stored.find((p) => p.normalizedUrl === `${origin}${path}`)?.headers;
  return { on, storedHeaders };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`core/charset reads the Content-Type charset (pub#674, ${engine})`, () => {
    test("header-only UTF-8 passes, a conflicting header is reported, no charset still fails", async () => {
      const { on } = await audit(engine);
      expect(on("/header-only")).toBe("pass: UTF-8 charset declared via header");
      expect(on("/quoted")).toBe("pass: UTF-8 charset declared via header");
      expect(on("/conflict")).toBe(
        "warn: Conflicting charset declarations: header iso-8859-1, page utf-8",
      );
      expect(on("/none")).toBe("fail: No charset declaration found");
    });
  });
}

test("the store keeps the media type and the charset apart", async () => {
  const { storedHeaders } = await audit("v1");
  expect(storedHeaders("/quoted")).toMatchObject({ contentType: "text/html", contentTypeCharset: "UTF-8" });
  expect(storedHeaders("/none")).toMatchObject({ contentType: "text/html", contentTypeCharset: null });
});

// An incremental crawl that fetches a page whose body has not changed reuses
// the stored record. The charset still comes from the response just fetched:
// a record stored before pub#674 has none, and the header can change alone.
test("an unchanged page refetched by an incremental crawl takes the new charset", async () => {
  let contentType = "text/html";
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<!doctype html><html><head><title>t</title></head><body>same</body></html>", {
        headers: { "content-type": contentType },
      }),
  });
  servers.push(server);
  const origin = `http://localhost:${server.port}`;
  const storage = new SQLiteStorage(":memory:");
  await Effect.runPromise(storage.init());
  const crawl = async () => {
    const crawler = await Effect.runPromise(
      createCrawler({
        storage,
        config: {
          maxPages: 1,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 5_000,
          userAgent: "squirrel-test",
          respectRobots: false,
          incremental: true,
          useCacheControl: false,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
    return (await Effect.runPromise(storage.getPages(crawlId)))[0]?.headers;
  };
  expect(await crawl()).toMatchObject({ contentType: "text/html", contentTypeCharset: null });
  contentType = "text/html; charset=utf-8";
  expect(await crawl()).toMatchObject({ contentType: "text/html", contentTypeCharset: "utf-8" });
});
