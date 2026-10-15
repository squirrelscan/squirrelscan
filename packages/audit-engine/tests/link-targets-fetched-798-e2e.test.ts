// pub#798 end-to-end: a link to a page the crawl fetched but that `site.pages`
// leaves out still has the crawl's answer, through the real pre-rules phase and
// both rule paths. Such pages are a PDF (not HTML), a page that answered with
// rate limiting, and a bot-wall challenge. links/broken-links used to count each
// as unfetched with no answer, so a site linking its own PDF never read as fully
// checked; the internal link check skips them too, as the crawl fetched them.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const BASE = "https://site.example.com";

const CONFIG = {
  rule_options: {},
  rules: { enable: ["links/broken-links"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = {};</script></body></html>`;

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function pageRecord(
  path: string,
  status: number,
  body: string,
  contentType = "text/html",
  server: string | null = null,
): PageRecord {
  const url = `${BASE}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: path === "/" ? 0 : 1,
    status,
    contentType,
    sizeBytes: body.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${path}`,
    html: body,
    parsedData: null,
    headers: { contentType, server },
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

const home = `<!doctype html><html lang="en"><head><title>Home</title></head><body><p>Home</p>${[
  "/report.pdf",
  "/gone.pdf",
  "/busy",
  "/walled",
]
  .map((href) => `<a href="${href}">${href}</a>`)
  .join("")}</body></html>`;

const PAGES = [
  pageRecord("/", 200, home),
  pageRecord("/report.pdf", 200, "", "application/pdf"),
  pageRecord("/gone.pdf", 404, "", "application/pdf"),
  pageRecord(
    "/busy",
    429,
    "<!doctype html><html><head><title>Slow down</title></head><body>Too many requests</body></html>",
  ),
  pageRecord("/walled", 403, CHALLENGE, "text/html", "cloudflare"),
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
  describe(`pub#798 links to pages the crawl fetched outside site.pages (${engine})`, () => {
    test("a PDF, a throttled page and a walled page each keep the crawl's answer", async () => {
      const checks = await brokenLinks(engine);
      const rows = checks.filter((c) => c.name === "broken-links");
      // The PDF that answered 404 is still broken; the one that answered 200 is not.
      expect(rows.map((c) => c.status)).toEqual(["fail"]);
      expect(rows[0]!.items?.map((i) => i.id)).toEqual([`${BASE}/gone.pdf`]);
      expect(rows[0]!.details).toEqual({
        linkTargets: 4,
        unfetchedTargets: 0,
        probedTargets: 0,
        notFetched: {},
      });
      const rateLimited = checks.find((c) => c.name === "rate-limited-links");
      expect(rateLimited?.items?.map((i) => i.id)).toEqual([`${BASE}/busy`]);
      const refused = checks.find((c) => c.name === "refused-links");
      expect(refused?.message).toBe(
        "1 internal link(s) answered the crawl with a bot-wall challenge - status unverifiable",
      );
      expect(refused?.items?.map((i) => i.id)).toEqual([`${BASE}/walled`]);
    });
  });
}
