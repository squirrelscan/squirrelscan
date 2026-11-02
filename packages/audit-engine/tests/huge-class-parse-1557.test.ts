// #1557: one page whose class attribute overflows linkedom's parse no longer fails the audit. Through the streaming engine (the path
// `squirrel audit` and the hosted worker run): the audit completes, every other page is audited, the page is listed with a parse notice
// on `crawl/html-size`, and the elements after the big one reach the rules (an image without alt after it is found).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import type { Config } from "@squirrelscan/config";
import type { PageRecord, ResponseHeaders, SecurityHeaders } from "@squirrelscan/core-contracts";

import { runStreamingRules, type PreFetchedAssets } from "../src/adapter";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);
const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const ASSETS: PreFetchedAssets = { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] } as unknown as PreFetchedAssets;

const EMPTY_HEADERS: ResponseHeaders = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
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
};
const EMPTY_SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function injectedPage(over: Partial<PageRecord> & { url: string; status: number }): PageRecord {
  return {
    url: over.url,
    normalizedUrl: over.url,
    finalUrl: over.url,
    depth: 1,
    status: over.status,
    contentType: over.contentType ?? null,
    sizeBytes: over.html ? Buffer.byteLength(over.html, "utf8") : 0,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "inj",
    html: over.html ?? null,
    parsedData: null,
    headers: EMPTY_HEADERS,
    securityHeaders: EMPTY_SECURITY_HEADERS,
    ...over,
  };
}


const BIG = `<!doctype html><html><head><title>A page with a huge class</title></head><body><div class="${Array.from({ length: 1_000_000 }, () => "a").join(" ")}"><span>inside</span></div><h1>Heading</h1><img src="https://synthetic.example.com/marker.png"></body></html>`;
const NORMAL = "<!doctype html><html><head><title>A normal page</title></head><body><h1>Normal</h1><img src=\"https://synthetic.example.com/ok.png\"></body></html>";
const BIG_URL = "http://synthetic.example.com/huge-class";
const NORMAL_URL = "http://synthetic.example.com/normal";

describe("one page that overflows the parse does not fail the audit (#1557)", () => {
  test("the audit completes, the page is listed with a notice, the others are audited, and a marker after the big element reaches the rules", async () => {
    const { storage, crawlId } = await writeCrawlToStorage(generateSiteModel({ seed: 5, pageCount: 3 }), ":memory:");
    await run(storage.upsertPage(crawlId, injectedPage({ url: NORMAL_URL, status: 200, contentType: "text/html", html: NORMAL })));
    await run(storage.upsertPage(crawlId, injectedPage({ url: BIG_URL, status: 200, contentType: "text/html", html: BIG })));
    const result = await run(runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 8 }));
    await run(storage.close());

    const checksOf = (url: string, rule: string) => result.pageRuleResults.get(url)?.get(rule) ?? [];
    // the page carries the notice, with the cause
    const notice = checksOf(BIG_URL, "crawl/html-size").find((c) => c.name === "html-parse");
    expect(notice?.status).toBe("warn");
    expect(notice?.message).toContain("a class attribute of 1,000,000 tokens was cut");
    // the normal pages have none
    expect(checksOf(NORMAL_URL, "crawl/html-size").some((c) => c.name === "html-parse")).toBe(false);
    for (const [url, rules] of result.pageRuleResults) {
      if (url !== BIG_URL) expect([url, (rules.get("crawl/html-size") ?? []).some((c) => c.name === "html-parse")]).toEqual([url, false]);
    }
    // every page, the big one included, was audited
    expect(result.pageRuleResults.has(NORMAL_URL)).toBe(true);
    expect(result.pageRuleResults.get(BIG_URL)!.size).toBeGreaterThan(10);
    // the marker after the big element reached the rules: the image without alt is found on the big page, as on the normal one
    const missingAlt = (url: string) => checksOf(url, "images/alt-text").some((c) => c.status === "fail" || c.status === "warn");
    expect(missingAlt(NORMAL_URL)).toBe(true);
    expect(missingAlt(BIG_URL)).toBe(true);
  }, 180_000);
});
