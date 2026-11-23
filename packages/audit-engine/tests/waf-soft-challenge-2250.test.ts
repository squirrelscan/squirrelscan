// #2250: a one-page crawl whose only page is a 2xx interstitial or empty shell is
// blocked, not scored. Drives a real crawl, then the shared status derivation.

import { wafBlockReason } from "@squirrelscan/core-contracts/waf-block";
import { createCrawler } from "@squirrelscan/crawler";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { deriveAuditStatusFromPages } from "../src/scoring";

const real = (title: string, links: string[]) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} page title for testing</title></head><body><main><h1>${title}</h1><p>${"Some real content about the topic. ".repeat(30)}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</main></body></html>`;

const HTML = { "content-type": "text/html" };

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

type Route = () => Response;

function serve(routes: Record<string, Route>): string {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      routes[new URL(req.url).pathname]?.() ??
      new Response("not found", { status: 404 }),
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function crawl(origin: string, respectRobots = false) {
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots,
        incremental: false,
        useCacheControl: false,
      },
    })
  );
  const crawlId = await Effect.runPromise(
    crawler.start(`${origin}/`, `${origin}/`)
  );
  const stats = await Effect.runPromise(crawler.storage.getStats(crawlId));
  const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
  return { stats, pages };
}

const CLOUDFLARE_STYLE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><h1>example.com</h1><p>Verifying you are human. This may take a few seconds.</p><noscript>Enable JavaScript and cookies to continue</noscript></body></html>`;
const CHECKING_BROWSER = `<!doctype html><html><head><title>One moment</title></head><body><p>Checking your browser before accessing the site.</p></body></html>`;
const EMPTY_SHELL = `<div id="root"></div><script src="/app.js"></script>`;
const MINIMAL_REAL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tiny site</title></head><body><h1>Hello</h1><p>A small but real page.</p></body></html>`;

describe("a one-page crawl of a 2xx interstitial (#2250)", () => {
  for (const [name, html] of [
    ["a Cloudflare-style JS challenge", CLOUDFLARE_STYLE],
    ["a generic checking-your-browser page", CHECKING_BROWSER],
    ["an empty shell with no doctype or html element", EMPTY_SHELL],
  ] as const) {
    test(`${name} is the seed block, and the audit is blocked with no score`, async () => {
      const origin = serve({
        "/": () => new Response(html, { headers: HTML }),
      });
      const { stats } = await crawl(origin);
      const seed = stats?.wafBlocked?.seed;
      expect(seed).toMatchObject({ status: 200, code: "blocked_by_waf" });
      const derived = deriveAuditStatusFromPages(
        [{ status: 200 }],
        0,
        {},
        undefined,
        0,
        seed
      );
      expect(derived.status).toBe("blocked");
      expect(derived.reason).toBe(wafBlockReason(seed!));
    });
  }

  test("the reason says the only page fetched is not the site", async () => {
    const origin = serve({
      "/": () => new Response(EMPTY_SHELL, { headers: HTML }),
    });
    const { stats } = await crawl(origin);
    expect(stats?.wafBlocked?.seed?.signal).toContain("only page fetched");
  });

  test("a valid minimal page (doctype and html) is not blocked", async () => {
    const origin = serve({
      "/": () => new Response(MINIMAL_REAL, { headers: HTML }),
    });
    const { stats, pages } = await crawl(origin);
    expect(pages).toHaveLength(1);
    expect(stats?.wafBlocked?.seed).toBeUndefined();
  });

  test("a JS-only SPA shell with a noscript notice is not blocked", async () => {
    const origin = serve({
      "/": () =>
        new Response(
          `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><noscript>Please enable JavaScript to continue.</noscript></body></html>`,
          { headers: HTML }
        ),
    });
    const { stats, pages } = await crawl(origin);
    expect(pages).toHaveLength(1);
    expect(stats?.wafBlocked?.seed).toBeUndefined();
  });

  test("a challenge-worded page is not blocked when the crawl reached other pages", async () => {
    const origin = serve({
      "/": () =>
        new Response(
          `<!doctype html><html><body><p>Just a moment</p><a href="/a">a</a></body></html>`,
          { headers: HTML }
        ),
      "/a": () => new Response(real("A", []), { headers: HTML }),
    });
    const { stats, pages } = await crawl(origin);
    expect(pages.length).toBeGreaterThan(1);
    expect(stats?.wafBlocked?.seed).toBeUndefined();
  });
});
