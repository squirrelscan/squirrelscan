// pub#768: `squirrel analyze` fetches the assets its rules read through the
// engine's asset phase, as `squirrel audit` does. Its own copy fetched scripts
// with native redirects, so a script on the audited site that redirected to a
// cloud metadata address was requested. Now every hop is held to the audit's
// egress policy: a hop to a link-local or metadata address is refused before
// it is sent, and the local site's own scripts still load.
//
// pub#799: the copy never ran the internal link check either, so every target
// the stored crawl did not fetch read as "internal link checks were off".

import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageRecord } from "@/crawler/storage/types";

import { buildSiteContext, fetchResourceAssets } from "@/audit/adapter";
import { getDefaultConfig } from "@/config";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const SCRIPT = "window.squirrel = 1;";

/** Where each script redirects. */
const REDIRECTS: Record<string, string> = {
  "/metadata-ip.js": "http://169.254.169.254/latest/meta-data/",
  "/metadata-name.js": "http://metadata.google.internal/computeMetadata/v1/",
  "/link-local-v6.js": "http://[fe80::1]/x.js",
};

let server: ReturnType<typeof Bun.serve>;
let base: string;

const real = globalThis.fetch;
/** Every URL a request was sent to, after any pinning. */
const sent: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const location = REDIRECTS[path];
      if (location) {
        return new Response(null, { status: 302, headers: { location } });
      }
      if (path === "/missing") return new Response("gone", { status: 404 });
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

function page(url: string, scripts: string[]): PageRecord {
  const html = `<!doctype html><html><head><title>Home</title>${scripts
    .map((src) => `<script src="${src}"></script>`)
    .join(
      ""
    )}</head><body><p>Home</p><a href="/missing">Old page</a></body></html>`;
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
    contentHash: "hash-home",
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

/** The asset phase `squirrel analyze` runs, over a stored crawl of one page. */
function analyzeAssets(scripts: string[], config = getDefaultConfig()) {
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
      yield* storage.upsertPage(crawlId, page(`${base}/`, scripts));
      const stored = yield* storage.getPages(crawlId);
      const siteContext = yield* buildSiteContext(stored);
      return yield* fetchResourceAssets(storage, crawlId, siteContext, config);
    }).pipe(Effect.orDie)
  );
}

describe("squirrel analyze's asset fetches (pub#768)", () => {
  test("a script that redirects to a metadata address is refused; the site's own scripts load", async () => {
    const assets = await analyzeAssets([...Object.keys(REDIRECTS), "/app.js"]);

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
});

describe("squirrel analyze's internal link check (pub#799)", () => {
  test("it status-checks a linked target the stored crawl did not fetch", async () => {
    const assets = await analyzeAssets([]);
    expect(assets.linkTargetStatuses?.map((t) => [t.url, t.status])).toEqual([
      [`${base}/missing`, 404],
    ]);
    expect(assets.internalLinkProbe).toMatchObject({ unfetched: 1, probed: 1 });
  });

  test("with internal link checks off, it checks none", async () => {
    const config = getDefaultConfig();
    config.internal_links = { ...config.internal_links, enabled: false };
    const assets = await analyzeAssets([], config);
    expect(assets.linkTargetStatuses).toBeUndefined();
    expect(assets.internalLinkProbe).toBeUndefined();
  });
});
