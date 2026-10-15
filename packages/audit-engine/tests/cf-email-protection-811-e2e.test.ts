// pub#811 end-to-end: a site behind Cloudflare with email obfuscation on links
// `/cdn-cgi/l/email-protection#<hex>` wherever it had a `mailto:` link, and the
// path answers an error status. Through the real crawler, the real pre-rules
// phase (which carries the internal link check) and both rule paths, with the
// crawl following links (Surface, Full) and not (Quick): the path is never
// requested, links/broken-links reports nothing for it and counts what it left
// out. A page parsed before the parser knew these links (an incremental crawl
// reusing a stored parse) still has them in `links`; that is covered too.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";
import { parsePage } from "@squirrelscan/parser";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Every path the fixture server was asked for, across the last audit. */
let requested: string[] = [];

const html = (body: string) =>
  `<!doctype html><html lang="en"><head><title>Fixture</title></head><body>${body}</body></html>`;

/** Cloudflare's encoding: a key byte, then each UTF-8 byte XOR the key, all hex. */
const encode = (text: string, key = 0x5a): string =>
  [key, ...new TextEncoder().encode(text).map((b) => b ^ key)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const MAILTO_PAYLOAD = encode("hello@example.com");

const FOOTER =
  `<footer><a href="/cdn-cgi/l/email-protection#${MAILTO_PAYLOAD}">[email&#160;protected]</a> ` +
  `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${encode("hi@example.com", 0x31)}">[email&#160;protected]</a></footer>`;

function serveSite(): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(url.pathname);
      const ok = (body: string) =>
        new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/") return ok(html(`<a href="/about">About</a>${FOOTER}`));
      if (url.pathname === "/about") return ok(html(`<a href="/">Home</a>${FOOTER}`));
      // Cloudflare's answer to a direct request for the obfuscation path.
      return new Response(html("Not found"), {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["links/broken-links"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

function rules(
  storage: SQLiteStorage,
  crawlId: string,
  engine: "v1" | "v2",
): Promise<CheckResult[]> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const preRules = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        const ran = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, preRules.assets);
        return ran.siteRuleResults.get("links/broken-links") ?? [];
      }
      const ran = yield* runStreamingRules(storage, crawlId, CONFIG, preRules.assets);
      return ran.siteRuleResults.get("links/broken-links") ?? [];
    }) as Effect.Effect<CheckResult[], never, never>,
  );
}

async function crawlAndAudit(engine: "v1" | "v2", followLinks: boolean) {
  const origin = serveSite();
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
        disableLinkDiscovery: !followLinks,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  return rules(crawler.storage as SQLiteStorage, crawlId, engine);
}

function pageRecord(origin: string, path: string, parsedData: string | null): PageRecord {
  const url = `${origin}${path}`;
  const body = html(`<a href="/about">About</a>${FOOTER}`);
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: path === "/" ? 0 : 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: body.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${path}`,
    html: body,
    parsedData,
    headers: { contentType: "text/html", server: null },
    securityHeaders: {},
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

/** A crawl whose home page carries a parse stored before pub#811: the obfuscated links are in `links`. */
async function storedParseAudit(engine: "v1" | "v2") {
  const origin = serveSite();
  const storage = new SQLiteStorage(":memory:");
  await Effect.runPromise(storage.init());
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: origin,
      seedUrl: `${origin}/`,
      originalUrl: `${origin}/`,
      startedAt: Date.now(),
      status: "completed",
      config: {} as never,
      stats: {
        pagesTotal: 0,
        pagesFetched: 0,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      },
    } as never),
  );
  // The crawler's own serialization of today's parse, with `links` and
  // `contactLinks` as a parse before pub#811 stored them.
  const { document: _doc, ...parsed } = parsePage(pageRecord(origin, "/", null).html!, `${origin}/`);
  const oldParse = JSON.stringify({
    ...parsed,
    links: [
      { url: `${origin}/about`, text: "About", isInternal: true },
      {
        url: `${origin}/cdn-cgi/l/email-protection#${MAILTO_PAYLOAD}`,
        text: "[email protected]",
        isInternal: true,
      },
      { url: `${origin}/cdn-cgi/l/email-protection`, text: "[email protected]", isInternal: true },
    ],
    contactLinks: [],
  });
  await Effect.runPromise(storage.upsertPage(crawlId, pageRecord(origin, "/", oldParse)));
  await Effect.runPromise(storage.upsertPage(crawlId, pageRecord(origin, "/about", null)));
  try {
    return await rules(storage, crawlId, engine);
  } finally {
    await Effect.runPromise(storage.close().pipe(Effect.orDie));
  }
}

function brokenLinksRow(checks: CheckResult[]): CheckResult {
  const rows = checks.filter((c) => c.name === "broken-links");
  expect(rows.map((c) => c.status)).toEqual(["pass"]);
  return rows[0]!;
}

for (const engine of ["v1", "v2"] as const) {
  describe(`pub#811 Cloudflare email-protection links are not broken links (${engine})`, () => {
    for (const followLinks of [true, false]) {
      test(`crawl ${followLinks ? "follows links (Surface, Full)" : "does not follow links (Quick)"}: never requested, never broken, counted`, async () => {
        const checks = await crawlAndAudit(engine, followLinks);
        expect(requested.filter((p) => p.startsWith("/cdn-cgi/"))).toEqual([]);
        const row = brokenLinksRow(checks);
        // Two obfuscated addresses on each of the two pages.
        expect(row.details).toMatchObject({ emailProtectionLinks: 4, linkTargets: 2 });
      });
    }

    test("a parse stored before the fix: the internal link check never requests them either", async () => {
      const checks = await storedParseAudit(engine);
      expect(requested.filter((p) => p.startsWith("/cdn-cgi/"))).toEqual([]);
      const row = brokenLinksRow(checks);
      // Two from the stored parse's links, two from /about's fresh parse.
      expect(row.details).toMatchObject({ emailProtectionLinks: 4 });
    });
  });
}
