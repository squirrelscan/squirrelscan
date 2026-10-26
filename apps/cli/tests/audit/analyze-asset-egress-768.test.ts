// pub#768: `squirrel analyze` fetches the assets its rules read through the
// engine's asset phase, as `squirrel audit` does. Its own copy fetched scripts
// with native redirects, so a script on the audited site that redirected to a
// cloud metadata address was requested. Now every hop is held to the audit's
// egress policy: a hop to a link-local or metadata address is refused before
// it is sent, and the local site's own scripts still load.
//
// pub#799: the copy never ran the internal link check either, so every target
// the stored crawl did not fetch read as "internal link checks were off".
//
// The crawl analyze reads can be any project's, while its config is the
// squirrel.toml found from the current directory: both phases run with the
// crawl's own scope, and with none of that directory's custom headers.

import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Effect } from "effect";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import { buildSiteContext } from "@/audit/adapter";
import { getDefaultConfig } from "@/config";
import { analyzeStoredCrawl, configForCrawl } from "@/controllers/analyze";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const SCRIPT = "window.squirrel = 1;";

/** Where each script redirects. */
const REDIRECTS: Record<string, string> = {
  "/metadata-ip.js": "http://169.254.169.254/latest/meta-data/",
  "/metadata-name.js": "http://metadata.google.internal/computeMetadata/v1/",
  "/link-local-v6.js": "http://[fe80::1]/x.js",
};

const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><head><title>Page not found</title></head><body><h1>Page not found</h1><p>Sorry, the page you are looking for does not exist.</p></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base: string;

const real = globalThis.fetch;
/** Every URL a request was sent to, after any pinning. */
const sent: string[] = [];
/** Paths the site was asked for, with the Authorization header each carried. */
const received: Array<{ path: string; authorization: string | null }> = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      received.push({ path, authorization: req.headers.get("authorization") });
      const location = REDIRECTS[path];
      if (location) {
        return new Response(null, { status: 302, headers: { location } });
      }
      if (path === "/missing") return new Response("gone", { status: 404 });
      if (path === "/oops") {
        return new Response(NOT_FOUND_PAGE, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(SCRIPT, {
        headers: { "content-type": "application/javascript" },
      });
    },
  });
  base = `http://localhost:${server.port}`;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(input instanceof Request ? input.url : String(input));
      return real(input, init);
    },
    { preconnect: real.preconnect }
  );
});

afterAll(() => {
  globalThis.fetch = real;
  server.stop(true);
});

afterEach(() => {
  sent.length = 0;
  received.length = 0;
});

function pageRecord(url: string, html: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${url}`,
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

function home(scripts: string[]): string {
  const tags = scripts.map((src) => `<script src="${src}"></script>`).join("");
  return `<!doctype html><html lang="en"><head><title>Home</title>${tags}</head><body><p>Home</p><a href="/missing">Old page</a></body></html>`;
}

/**
 * Analyze a stored crawl of the home page (and `extra` pages), as `squirrel
 * analyze` does: the asset phase, then the rules, with `config` as loaded.
 */
function analyze(
  scripts: string[],
  config = getDefaultConfig(),
  extra: PageRecord[] = []
) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: base,
        seedUrl: `${base}/`,
        originalUrl: `${base}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {} as never,
      } as never);
      yield* storage.upsertPage(crawlId, pageRecord(`${base}/`, home(scripts)));
      for (const page of extra) yield* storage.upsertPage(crawlId, page);
      const crawl = (yield* storage.getCrawl(crawlId))!;
      const siteContext = yield* buildSiteContext(
        yield* storage.getPages(crawlId)
      );
      const { assets, ruleResults } = yield* analyzeStoredCrawl(
        storage,
        crawl,
        siteContext,
        {
          ...config,
          rules: { ...config.rules, enable: ["links/broken-links"] },
        }
      );
      const brokenLinks = (ruleResults.ruleResultsMap.get("links/broken-links")
        ?.checks ?? []) as Array<{
        status: string;
        details?: Record<string, unknown>;
      }>;
      return { assets, brokenLinks };
    }).pipe(Effect.orDie)
  );
}

describe("squirrel analyze's asset fetches (pub#768)", () => {
  test("a script that redirects to a metadata address is refused; the site's own scripts load", async () => {
    const { assets } = await analyze([...Object.keys(REDIRECTS), "/app.js"]);

    const byUrl = new Map(assets.scripts.map((s) => [s.url, s]));
    for (const path of Object.keys(REDIRECTS)) {
      expect(byUrl.get(`${base}${path}`)?.error).toBe(
        ASSET_FETCH_REFUSED_ERROR
      );
      expect(byUrl.get(`${base}${path}`)?.content).toBeNull();
    }
    expect(byUrl.get(`${base}/app.js`)?.content).toBe(SCRIPT);

    // Nothing was sent to any of the addresses the redirects named.
    for (const url of sent) {
      expect(url).not.toContain("169.254.169.254");
      expect(url).not.toContain("metadata.google.internal");
      expect(url).not.toContain("fe80");
    }
    expect(sent.some((url) => url.includes("/metadata-ip.js"))).toBe(true);
  });

  test("this directory's custom headers go to no request, assets or rules", async () => {
    const config = getDefaultConfig();
    config.crawler.headers = { Authorization: "Bearer project-a" };
    // A page the crawl stored that reads as a soft 404: the rules phase
    // fetches it again to confirm, with the crawl's headers.
    await analyze(["/app.js"], config, [
      pageRecord(`${base}/oops`, NOT_FOUND_PAGE),
    ]);
    const paths = received.map((r) => r.path);
    expect(paths).toContain("/app.js");
    expect(paths).toContain("/oops");
    expect(received.filter((r) => r.authorization !== null)).toEqual([]);
  });
});

describe("squirrel analyze's internal link check (pub#799)", () => {
  test("it status-checks a linked target the stored crawl did not fetch", async () => {
    const { assets, brokenLinks } = await analyze([]);
    expect(assets.linkTargetStatuses?.map((t) => [t.url, t.status])).toEqual([
      [`${base}/missing`, 404],
    ]);
    expect(assets.internalLinkProbe).toMatchObject({ unfetched: 1, probed: 1 });
    // The rule reports the 404, and no target as unchecked.
    expect(brokenLinks.map((c) => [c.status, c.details?.notFetched])).toEqual([
      ["fail", {}],
    ]);
  });

  test("with internal link checks off, it checks none, and says so", async () => {
    const config = getDefaultConfig();
    config.internal_links = { ...config.internal_links, enabled: false };
    const { assets, brokenLinks } = await analyze([], config);
    expect(assets.linkTargetStatuses).toBeUndefined();
    expect(assets.internalLinkProbe).toBeUndefined();
    expect(brokenLinks.map((c) => [c.status, c.details?.notFetched])).toEqual([
      ["pass", { off: 1 }],
    ]);
  });
});

describe("the config squirrel analyze runs with", () => {
  const crawlWith = (config: Partial<CrawlMetadata["config"]>) =>
    ({ config }) as unknown as CrawlMetadata;

  test("the crawl's own scope and page limit, this directory's politeness, and none of its custom headers", () => {
    const config = getDefaultConfig();
    config.crawler.headers = { Authorization: "Bearer project-a" };
    config.crawler.per_host_concurrency = 1;
    config.crawler.per_host_delay_ms = 500;
    config.project.domains = ["project-a.example"];
    const out = configForCrawl(
      config,
      crawlWith({
        maxPages: 50,
        // What a rendered crawl's pool resolved to, not the configured limits.
        perHostConcurrency: 6,
        perHostDelayMs: 0,
        include: ["/docs/*"],
        exclude: ["/admin/*"],
        respectRobots: true,
        allowedDomains: ["cdn.example.com"],
      })
    );
    expect(out.crawler.headers).toEqual({});
    expect(out.crawler.max_pages).toBe(50);
    // Politeness stays as configured: never looser than this directory asks.
    expect(out.crawler.per_host_concurrency).toBe(1);
    expect(out.crawler.per_host_delay_ms).toBe(500);
    expect(out.crawler.include).toEqual(["/docs/*"]);
    expect(out.crawler.exclude).toEqual(["/admin/*"]);
    expect(out.crawler.respect_robots).toBe(true);
    expect(out.project.domains).toEqual(["cdn.example.com"]);
    // The loaded config itself is untouched.
    expect(config.crawler.headers).toEqual({
      Authorization: "Bearer project-a",
    });
  });

  test("a crawl recorded without those fields: the loaded scope, but no extra domains", () => {
    const config = getDefaultConfig();
    config.crawler.exclude = ["/private/*"];
    config.project.domains = ["project-a.example"];
    const out = configForCrawl(config, crawlWith({}));
    expect(out.crawler.exclude).toEqual(["/private/*"]);
    expect(out.project.domains).toEqual([]);
    expect(out.crawler.headers).toEqual({});
  });
});
