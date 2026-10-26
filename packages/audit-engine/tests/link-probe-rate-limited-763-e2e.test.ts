// pub#763: the internal link check takes its targets from the pages the rules
// read. A rate-limited page (#1829) is not one of them, so the action link and
// the two ordinary links its 429 body carries are neither probed nor counted:
// counted, they would read as one skipped target and one over the limit, and
// links/broken-links would blame internal_links.max_targets for targets it
// never reports.

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
  // One target at most: if a throttled page's links counted, the two ordinary
  // ones below would put the check over it.
  internal_links: { enabled: true, max_targets: 1 },
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

// Every target the 200 pages link is a stored page, so nothing is left to probe.
const PAGES = [
  pageRecord("/", 200, ["/about", "/pricing"]),
  pageRecord("/about", 200, ["/"]),
  pageRecord("/pricing", 429, ["/logout", "/only-on-429-a", "/only-on-429-b"]),
];

async function audit(engine: "v1" | "streaming") {
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
      const checks = (result.ruleResultsMap.get("links/broken-links")?.checks ?? []) as CheckResult[];
      return { probe: preRules.assets.internalLinkProbe, checks };
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

for (const engine of ["v1", "streaming"] as const) {
  describe(`pub#763 a rate-limited page's links stay out of the internal link check (${engine})`, () => {
    test("the probe counts only targets from pages the rule reads, and notFetched matches", async () => {
      const { probe, checks } = await audit(engine);
      expect(probe).toMatchObject({ unfetched: 0, probed: 0, cap: 1 });
      expect(probe?.outOfScope ?? 0).toBe(0);
      const rows = checks.filter((c) => c.name === "broken-links");
      expect(rows.map((c) => c.status)).toEqual(["pass"]);
      // /, /about and /pricing: nothing the 429 body links.
      expect(rows[0]!.details).toMatchObject({ linkTargets: 3, unfetchedTargets: 0, notFetched: {} });
    });
  });
}
