// pub#457 end-to-end: noindex pages skip the index-presentation rules only on a
// site known to be indexed, through the REAL adapter on both engine paths.
//
// `SiteData.siteIndexable` is decided by the adapter from the crawl (homepage,
// else the entry page), so only a run through `runRulesOnStorage` and
// `runStreamingRules` proves the runner gate and the site rules see it:
//
//   - homepage noindex (a preview deployment): nothing is skipped
//   - homepage indexable, one noindex page: that page alone is skipped
//   - deep-seeded audit, homepage not crawled, entry page noindex: nothing skipped
//   - deep-seeded, entry page indexable: the noindex page is skipped
//   - homepage answered 500: the entry page decides
//   - neither the homepage nor the entry page fetched: nothing is skipped
//
// crawl/all-noindex-pages must keep reporting the noindex pages in every case.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const BASE = "https://site.example.com";

const CONFIG = {
  rule_options: {},
  rules: { enable: ["core/h1", "content/duplicate-title", "crawl/all-noindex-pages"] },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

interface SeedPage {
  path: string;
  status?: number;
  /** robots meta content */
  meta?: string;
  /** X-Robots-Tag header value */
  header?: string;
}

// No <h1>, and one shared title, so core/h1 fails and content/duplicate-title
// groups every page unless a page is skipped or left out.
function body(meta: string | undefined): string {
  const robots = meta ? `<meta name="robots" content="${meta}">` : "";
  return `<!doctype html><html lang="en"><head><title>Same title everywhere</title>${robots}</head><body><p>Body copy.</p></body></html>`;
}

function pageRecord(page: SeedPage): PageRecord {
  const url = `${BASE}${page.path}`;
  const html = body(page.meta);
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: page.path === "/" ? 0 : 1,
    status: page.status ?? 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${page.path}`,
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      expires: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
      setCookie: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: page.header ?? null,
    },
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

type EnginePath = "v1" | "streaming";

interface AuditResult {
  /** URLs whose core/h1 result is the noindex skip. */
  skipped: string[];
  /** URLs core/h1 actually graded. */
  graded: string[];
  duplicateTitle: CheckResult | undefined;
  allNoindex: CheckResult[];
}

async function audit(
  pages: SeedPage[],
  seedPath: string,
  engine: EnginePath,
): Promise<AuditResult> {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}${seedPath}`,
        originalUrl: `${BASE}${seedPath}`,
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
      for (const page of pages) yield* storage.upsertPage(crawlId, pageRecord(page));

      let result;
      if (engine === "streaming") {
        result = yield* runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, {
          batchSize: 1,
        });
      } else {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        result = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);
      }

      const skipped: string[] = [];
      const graded: string[] = [];
      for (const [url, checks] of result.pageResults) {
        const h1 = checks.filter((c) => c.name === "h1" || c.name === "core/h1");
        if (h1.some((c) => c.skipReason === "noindex")) skipped.push(url);
        else if (h1.some((c) => c.status === "fail")) graded.push(url);
      }
      const siteChecks = (id: string) =>
        (result.ruleResultsMap.get(id)?.checks ?? []) as CheckResult[];
      return {
        skipped: skipped.sort(),
        graded: graded.sort(),
        duplicateTitle: siteChecks("content/duplicate-title").find(
          (c) => c.name === "duplicate-title",
        ),
        allNoindex: siteChecks("crawl/all-noindex-pages"),
      };
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

const u = (path: string) => `${BASE}${path}`;

for (const engine of ["v1", "streaming"] as const) {
  describe(`pub#457 noindex skip through the real adapter (${engine})`, () => {
    test("homepage noindex (a preview deployment): nothing is skipped, all-noindex still reports", async () => {
      const r = await audit(
        [
          { path: "/", header: "noindex" },
          { path: "/a", header: "noindex" },
          { path: "/b", header: "noindex" },
        ],
        "/",
        engine,
      );
      expect(r.skipped).toEqual([]);
      expect(r.graded).toEqual([u("/"), u("/a"), u("/b")]);
      expect(r.duplicateTitle?.message).toBe("1 duplicate title(s) found across 3 pages");
      const listed = r.allNoindex.find((c) => c.name === "all-noindex");
      expect(listed?.message).toBe("3 page(s) blocked from indexing");
    });

    test("homepage indexable, one noindex page: that page alone is skipped", async () => {
      const r = await audit(
        [{ path: "/" }, { path: "/a" }, { path: "/thanks", meta: "noindex" }],
        "/",
        engine,
      );
      expect(r.skipped).toEqual([u("/thanks")]);
      expect(r.graded).toEqual([u("/"), u("/a")]);
      expect(r.duplicateTitle?.message).toBe("1 duplicate title(s) found across 2 pages");
      expect(r.allNoindex.find((c) => c.name === "all-noindex")?.message).toBe(
        "1 page(s) blocked from indexing",
      );
    });

    test("deep-seeded audit, homepage not crawled, entry page noindex: nothing is skipped", async () => {
      const r = await audit(
        [
          { path: "/docs/start", meta: "noindex" },
          { path: "/docs/a" },
          { path: "/docs/b", header: "noindex" },
        ],
        "/docs/start",
        engine,
      );
      expect(r.skipped).toEqual([]);
      expect(r.graded).toEqual([u("/docs/a"), u("/docs/b"), u("/docs/start")]);
    });

    test("deep-seeded audit with an indexable entry page skips the noindex page", async () => {
      const r = await audit(
        [{ path: "/docs/start" }, { path: "/docs/a" }, { path: "/docs/b", header: "noindex" }],
        "/docs/start",
        engine,
      );
      expect(r.skipped).toEqual([u("/docs/b")]);
    });

    test("a homepage that answered 500 hands the decision to the entry page", async () => {
      const indexableEntry = await audit(
        [{ path: "/", status: 500 }, { path: "/docs/start" }, { path: "/docs/b", meta: "noindex" }],
        "/docs/start",
        engine,
      );
      expect(indexableEntry.skipped).toEqual([u("/docs/b")]);

      const noindexEntry = await audit(
        [
          { path: "/", status: 500 },
          { path: "/docs/start", meta: "noindex" },
          { path: "/docs/b", meta: "noindex" },
        ],
        "/docs/start",
        engine,
      );
      expect(noindexEntry.skipped).toEqual([]);
    });

    test("neither the homepage nor the entry page fetched: nothing is skipped", async () => {
      const r = await audit(
        [{ path: "/docs/a" }, { path: "/docs/b", meta: "noindex" }],
        "/docs/missing",
        engine,
      );
      expect(r.skipped).toEqual([]);
      expect(r.graded).toEqual([u("/docs/a"), u("/docs/b")]);
    });
  });
}
