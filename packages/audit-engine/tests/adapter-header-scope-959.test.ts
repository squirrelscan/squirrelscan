// The end-of-crawl re-fetches the adapter runs (the cloaking probe and the soft-404
// confirmation) send the audit's custom headers only to the audited origin (#959).
// Driven through the real engine entry points against a loopback server: the
// audited origin is 127.0.0.1:<port>, and `localhost:<port>` is the same server
// under another host, so it is another origin. Every negative also proves the URL
// was requested, by the server's own log.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const SHELL = `<!doctype html><html id="__next_error__" lang="en"><head><meta name="robots" content="noindex"><title>Page Not Found</title></head><body><main><h1>Page Not Found</h1></main></body></html>`;
const PLAIN =
  '<!doctype html><html lang="en"><head><title>Plain</title></head><body><p>hello</p></body></html>';

type Seen = { host: string; path: string; token: string | null };
const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let ORIGIN = "";
let OTHER_ORIGIN = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        host: req.headers.get("host") ?? "",
        path: url.pathname,
        token: req.headers.get("x-audit-token"),
      });
      return new Response(url.pathname === "/gone" ? SHELL : PLAIN, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  ORIGIN = `http://127.0.0.1:${server.port}`;
  OTHER_ORIGIN = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

const CONFIG = {
  rule_options: {},
  rules: { enable: [] },
  crawler: { headers: { "X-Audit-Token": "secret" }, header_hosts: [] },
  integrity: {
    cloaking_probe: {
      enabled: true,
      max_pages: 10,
      recent_days: 14,
      query_variation: false,
      googlebot_user_agent: "Googlebot",
    },
    soft404_confirm: { enabled: true },
  },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

function pageRecord(path: string, body: string): PageRecord {
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: body.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${path}`,
    html: body,
    parsedData: null,
    headers: {},
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

type Engine = "v1" | "streaming";

async function audit(engine: Engine, config: Config = CONFIG, originalUrl?: string) {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: ORIGIN,
        seedUrl: `${ORIGIN}/`,
        ...(originalUrl ? { originalUrl } : {}),
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
      yield* storage.upsertPage(crawlId, pageRecord("/", PLAIN));
      yield* storage.upsertPage(crawlId, pageRecord("/hidden-kit", PLAIN));
      yield* storage.upsertPage(crawlId, pageRecord("/gone", SHELL));
      yield* storage.upsertPage(crawlId, pageRecord(`${OTHER_ORIGIN}/ghost`, PLAIN));
      if (engine === "streaming") {
        return yield* runStreamingRules(storage, crawlId, config, EMPTY_ASSETS, undefined, {
          batchSize: 1,
        });
      }
      const stored = yield* storage.getPages(crawlId);
      const siteContext = yield* buildSiteContext(stored);
      return yield* runRulesOnStorage(storage, crawlId, siteContext, config, EMPTY_ASSETS);
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

describe("adapter re-fetches send custom headers only to the audited origin (#959)", () => {
  for (const engine of ["v1", "streaming"] as const) {
    test(`${engine}: the audited origin carries them, the other origin does not`, async () => {
      seen.length = 0;
      await audit(engine);
      const own = seen.filter((s) => s.host === `127.0.0.1:${server.port}`);
      const other = seen.filter((s) => s.host === `localhost:${server.port}`);
      // The probes ran (so the negatives below are not vacuous) on both origins.
      expect(own.some((s) => s.path === "/hidden-kit")).toBe(true);
      expect(other.some((s) => s.path === "/ghost")).toBe(true);
      expect(own.some((s) => s.path === "/gone")).toBe(true);
      expect(own.filter((s) => s.path !== "/").every((s) => s.token === "secret")).toBe(true);
      expect(other.every((s) => s.token === null)).toBe(true);
    }, 60_000);
  }

  for (const engine of ["v1", "streaming"] as const) {
    test(`${engine}: an https start URL redirected to http: re-fetches carry no headers`, async () => {
      seen.length = 0;
      await audit(engine, CONFIG, `https://127.0.0.1:${server.port}/`);
      const own = seen.filter((s) => s.host === `127.0.0.1:${server.port}`);
      // The re-fetches ran, over http, and none carried the headers.
      expect(own.some((s) => s.path === "/hidden-kit")).toBe(true);
      expect(own.some((s) => s.path === "/gone")).toBe(true);
      expect(seen.every((s) => s.token === null)).toBe(true);
    }, 60_000);
  }
});
