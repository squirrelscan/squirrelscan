// #1269: `squirrel analyze` re-runs rules over STORED data and makes no live
// request. security/http-to-https probes http:// variants, so under analyze it
// reports not-checked (a coverage gap, listed under notChecked) instead of
// probing; `squirrel audit` installs the request tool and still probes.

import type { RuleContext } from "@squirrelscan/rules";

import { clearRequestAsync, hasRequestTool } from "@squirrelscan/rules";
import { httpToHttpsRule } from "@squirrelscan/rules/security/http-to-https";
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
import { analyzeStoredCrawl } from "@/controllers/analyze";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { installRuleRequestTool } from "@/tools/request";

const BASE = "https://analyze-offline.example.com";
const REASON = "analyze runs offline; run `squirrel audit` to probe";

const real = globalThis.fetch;
/** Every http:// URL a request was sent to. */
const plainHttp: string[] = [];

beforeAll(() => {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://")) plainHttp.push(url);
      return Promise.resolve(
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
    },
    { preconnect: real.preconnect }
  );
});

afterEach(() => {
  plainHttp.length = 0;
  clearRequestAsync();
});

afterAll(() => {
  globalThis.fetch = real;
  clearRequestAsync();
});

function page(url: string): PageRecord {
  const html = `<!doctype html><html lang="en"><head><title>Home</title></head><body><p>Home</p></body></html>`;
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

function analyze() {
  const storage = new SQLiteStorage(":memory:");
  const config = getDefaultConfig();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {} as never,
      } as never);
      yield* storage.upsertPage(crawlId, page(`${BASE}/`));
      const crawl = (yield* storage.getCrawl(crawlId))! as CrawlMetadata;
      const siteContext = yield* buildSiteContext(
        yield* storage.getPages(crawlId)
      );
      return yield* analyzeStoredCrawl(storage, crawl, siteContext, {
        ...config,
        rules: { ...config.rules, enable: ["security/http-to-https"] },
      });
    })
  );
}

describe("security/http-to-https under analyze and audit (#1269)", () => {
  test("analyze makes zero http:// requests and reports not-checked with the reason", async () => {
    // A leftover tool from an earlier audit in the process must not survive.
    installRuleRequestTool();
    expect(hasRequestTool()).toBe(true);

    const { ruleResults } = await analyze();

    expect(hasRequestTool()).toBe(false);
    expect(plainHttp).toEqual([]);
    const result = ruleResults.ruleResultsMap.get("security/http-to-https");
    const check = result?.checks[0] as unknown as Record<string, unknown>;
    expect(check).toMatchObject({
      status: "skipped",
      skipReason: "analyze-offline",
      value: "not-checked",
    });
    expect(String(check.message)).toContain(REASON);
  });

  test("audit (request tool installed) still probes the http:// variants", async () => {
    installRuleRequestTool();
    const ctx = {
      site: { baseUrl: BASE, pages: [{ url: `${BASE}/p`, statusCode: 200 }] },
      options: {},
    } as unknown as RuleContext;

    const { checks } = await httpToHttpsRule.run(ctx);

    expect(plainHttp.length).toBeGreaterThan(0);
    expect(checks[0]!.status).not.toBe("skipped");
  });
});
