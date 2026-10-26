// pub#794 end-to-end: the coverage links/broken-links records on its fail row,
// through the real pre-rules phase (which counts the targets the internal link
// check skips by design) and both rule paths.
//
// The rule splits its unfetched targets by cause from the check's counts, so
// `skipped` is only exact while every target the check counted as skipped is
// one the rule saw too. A rate-limited page is kept out of the rule's pages
// (#1829), so the links its 429 body carries must not count either: here the
// token link only the 429 page carries used to be counted as skipped, and with
// /pricing (linked, rate limited, status unknown) as the one unfetched target,
// the row read as if everything it could check was checked.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const BASE = "https://site.example.com";
const TOKEN_LINK = "/account?token=0123456789abcdef01234567";

const CONFIG = {
  rule_options: {},
  rules: { enable: ["links/broken-links"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function pageRecord(path: string, status: number, links: string[]): PageRecord {
  const url = `${BASE}${path}`;
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  const html = `<!doctype html><html lang="en"><head><title>${path}</title></head><body><p>Body copy.</p>${anchors}</body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: path === "/" ? 0 : 1,
    status,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${path}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
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

// Every target is a stored page except the token link, so the internal link
// check requests nothing.
const PAGES = [
  pageRecord("/", 200, ["/about", "/pricing", "/missing"]),
  pageRecord("/about", 200, ["/"]),
  pageRecord("/pricing", 429, [TOKEN_LINK]),
  pageRecord("/missing", 404, []),
];

async function brokenLinks(engine: "v1" | "streaming"): Promise<CheckResult[]> {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
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
      } as never);
      for (const page of PAGES) yield* storage.upsertPage(crawlId, page);

      const preRules = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      let result;
      if (engine === "streaming") {
        result = yield* runStreamingRules(storage, crawlId, CONFIG, preRules.assets);
      } else {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        result = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, preRules.assets);
      }
      return (result.ruleResultsMap.get("links/broken-links")?.checks ?? []) as CheckResult[];
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

for (const engine of ["v1", "streaming"] as const) {
  describe(`pub#794 broken-links coverage through the real adapter (${engine})`, () => {
    test("a link only a rate-limited page carries is not counted as skipped", async () => {
      const checks = await brokenLinks(engine);
      const rows = checks.filter((c) => c.name === "broken-links");
      expect(rows.map((c) => c.status)).toEqual(["fail"]);
      expect(rows[0]!.items?.map((i) => i.id)).toEqual([`${BASE}/missing`]);
      // /, /about, /pricing and /missing. Nothing /pricing's 429 body links is
      // one of the rule's targets. /pricing itself is rate limited: listed as
      // such, not unfetched (pub#798).
      expect(rows[0]!.details).toEqual({
        linkTargets: 4,
        unfetchedTargets: 0,
        probedTargets: 0,
        notFetched: {},
      });
      const rateLimited = checks.find((c) => c.name === "rate-limited-links");
      expect(rateLimited?.items?.map((i) => i.id)).toEqual([`${BASE}/pricing`]);
    });
  });
}
