// #1332: the `--max-duration` page cap in the streaming pass judges the decoded page. A recorded `sizeBytes` is the
// Content-Length (the encoded size); a small gzip body that inflates past the cap must still be counted too large and left
// unparsed, not parsed because its wire size looked small.

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

const CAP = 64 * 1024;
const big = `<!doctype html><html><head><title>t</title></head><body>${"<p>x</p>".repeat(20_000)}</body></html>`;

const INJECTED = "http://synthetic.example.com/inflated";

/** Pages counted too large, and listed, that the injected page adds to what the synthetic site already has. */
async function tooLarge(inject: { sizeBytes: number; html: string } | null): Promise<{ added: number; listed: boolean }> {
  const { storage, crawlId } = await writeCrawlToStorage(generateSiteModel({ seed: 5, pageCount: 4 }), ":memory:");
  const baseline = await run(runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 8, maxPageBytes: CAP }));
  if (!inject) {
    await run(storage.close());
    return { added: 0, listed: false };
  }
  await run(storage.upsertPage(crawlId, injectedPage({ url: INJECTED, status: 200, contentType: "text/html", html: inject.html, sizeBytes: inject.sizeBytes })));
  const result = await run(runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 8, maxPageBytes: CAP }));
  await run(storage.close());
  return { added: result.pagesTooLarge - baseline.pagesTooLarge, listed: new Set(result.tooLargePages).has(INJECTED) };
}

describe("the streaming parse cap judges the decoded page (#1332)", () => {
  test("a page recorded at its small encoded size but over the cap decoded is counted too large and listed", async () => {
    const out = await tooLarge({ sizeBytes: 900, html: big });
    expect(big.length).toBeGreaterThan(CAP);
    expect(out).toEqual({ added: 1, listed: true });
  });

  test("a page whose recorded size and body are both under the cap is not counted", async () => {
    const small = "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>";
    expect(await tooLarge({ sizeBytes: 900, html: small })).toEqual({ added: 0, listed: false });
  });

  test("a recorded size over the cap still counts when the body is shorter", async () => {
    expect((await tooLarge({ sizeBytes: CAP + 1, html: "<!doctype html><title>t</title>" })).added).toBe(1);
  });

  test("the boundary and a multi-byte body: exactly the cap is not too large, one byte more is, and bytes are counted not characters", async () => {
    const shell = "<!doctype html><html><head><title>t</title></head><body><p></p></body></html>";
    const exact = (bytes: number): string => shell.replace("<p></p>", `<p>${"x".repeat(bytes - Buffer.byteLength(shell))}</p>`);
    expect(await tooLarge({ sizeBytes: 900, html: exact(CAP) })).toEqual({ added: 0, listed: false });
    expect(await tooLarge({ sizeBytes: 900, html: exact(CAP + 1) })).toEqual({ added: 1, listed: true });
    const wide = shell.replace("<p></p>", `<p>${"\u4e2d".repeat(30_000)}</p>`);
    expect(wide.length).toBeLessThan(CAP);
    expect(await tooLarge({ sizeBytes: 900, html: wide })).toEqual({ added: 1, listed: true });
  });
});
