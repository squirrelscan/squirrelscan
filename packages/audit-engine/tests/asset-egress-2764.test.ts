// squirrelscan/repo#2764: two gaps in the asset phase's own-site pools.
//  1. The sitemap-orphan status pool sent the audit's custom headers (Web Bot
//     Auth signatures, Authorization, cookies) to any host a sitemap lists.
//  2. A same-site stylesheet, script, image, font, PDF or sitemap URL that
//     redirects to a link-local or cloud metadata address was followed there,
//     from the auditor's machine.
// A localhost audit's own assets still load: only link-local and metadata
// addresses are refused for the site's own pools.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";
import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";

import { runStreamingPreRules } from "../src/streaming-pre-rules";

const SECRET_HEADER = "x-squirrel-test-secret";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Each request: path (with query), Host, and whether it carried the secret header. */
let requests: Array<{ path: string; host: string; secret: boolean }> = [];

/**
 * The audited site is `localhost`. Its sitemap lists one more page of its own
 * and one on another host (the same server under 127.0.0.1). Its home page
 * uses a stylesheet, an image and a script that redirect to metadata and
 * link-local addresses, and a stylesheet that is fine.
 */
function serve(): { origin: string; foreign: string } {
  requests = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({
        path: `${url.pathname}${url.search}`,
        host: req.headers.get("host") ?? "",
        secret: req.headers.has(SECRET_HEADER),
      });
      const origin = `http://localhost:${url.port}`;
      const foreign = `http://127.0.0.1:${url.port}`;
      const html = (head: string, body = "Home") =>
        new Response(
          `<!doctype html><html><head><title>Fixture</title>${head}</head><body>${body}</body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      switch (url.pathname) {
        case "/":
          return html(
            [
              `<link rel="stylesheet" href="/style.css">`,
              `<link rel="stylesheet" href="/go?u=meta-ip">`,
              `<script src="/go?u=meta-host"></script>`,
            ].join(""),
            `<img src="/go?u=link-local" alt="x" width="1" height="1">`,
          );
        case "/style.css":
          return new Response("body{color:red}", { headers: { "content-type": "text/css" } });
        case "/go": {
          const to = url.searchParams.get("u");
          const location =
            to === "meta-ip"
              ? "http://169.254.169.254/latest/meta-data/"
              : to === "meta-host"
                ? "http://metadata.google.internal/computeMetadata/v1/"
                : "http://[fe80::1]/x.png";
          return new Response(null, { status: 302, headers: { location } });
        }
        case "/sitemap.xml":
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
              `<url><loc>${origin}/</loc></url><url><loc>${origin}/orphan</loc></url>` +
              `<url><loc>${origin}/go?u=meta-ip</loc></url>` +
              `<url><loc>${foreign}/elsewhere</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        case "/robots.txt":
          return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
            headers: { "content-type": "text/plain" },
          });
        default:
          return html("");
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, foreign: `http://127.0.0.1:${server.port}` };
}

async function assetsOf(origin: string) {
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 1,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        disableLinkDiscovery: true,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  requests = [];
  const config = {
    rule_options: {},
    rules: { enable: ["*"] },
    // The crawl fetches one page; the sitemap-status check takes up to
    // max_pages orphans, so every listed URL is checked.
    crawler: { max_pages: 10, exclude: [], headers: { [SECRET_HEADER]: "s3cret" } },
    external_links: { enabled: false },
    internal_links: { enabled: false },
  } as unknown as Config;
  const pre = await Effect.runPromise(runStreamingPreRules(crawler.storage, crawlId, config, {}));
  return pre.assets;
}

describe("the asset phase's egress (repo#2764)", () => {
  test("a sitemap URL on another host gets none of the audit's custom headers; the site's own still do", async () => {
    const { origin, foreign } = serve();
    const assets = await assetsOf(origin);

    const foreignHost = new URL(foreign).host;
    const toForeign = requests.filter((r) => r.host === foreignHost);
    expect(toForeign.map((r) => r.path)).toContain("/elsewhere");
    expect(toForeign.some((r) => r.secret)).toBe(false);

    const ownOrphan = requests.filter((r) => r.path === "/orphan");
    expect(ownOrphan.length).toBeGreaterThan(0);
    expect(ownOrphan.every((r) => r.secret)).toBe(true);
    expect(requests.filter((r) => r.path === "/style.css").every((r) => r.secret)).toBe(true);

    // Both still checked, in the sitemap's order.
    expect(assets.sitemapUrlStatuses.map((s) => s.url)).toEqual([
      `${origin}/orphan`,
      `${origin}/go?u=meta-ip`,
      `${foreign}/elsewhere`,
    ]);
    expect(assets.sitemapUrlStatuses.find((s) => s.url.endsWith("/elsewhere"))?.status).toBe(200);
  });

  test("a same-site asset that redirects to a metadata or link-local address is refused at that hop", async () => {
    const { origin } = serve();
    const assets = await assetsOf(origin);

    // The localhost site's own stylesheet loads.
    const css = new Map(assets.resourceSizes.css.map((c) => [c.url, c]));
    expect(css.get(`${origin}/style.css`)?.status).toBe(200);
    // The redirect itself was requested; the metadata hop never was: it is
    // refused by the egress policy, not a failed connection.
    expect(css.get(`${origin}/go?u=meta-ip`)?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    const script = assets.scripts.find((s) => s.url === `${origin}/go?u=meta-host`);
    expect(script?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    const image = assets.resourceSizes.images.find((i) => i.url === `${origin}/go?u=link-local`);
    expect(image?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    const sitemapHop = assets.sitemapUrlStatuses.find((s) => s.url === `${origin}/go?u=meta-ip`);
    expect(sitemapHop?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    expect(requests.some((r) => r.path === "/go?u=meta-ip")).toBe(true);
  });
});
