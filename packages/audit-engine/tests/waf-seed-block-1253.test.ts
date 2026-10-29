// #1253: a WAF or bot manager that answers the audited page with a challenge or
// block page fails the audit, and one that answers any other page is left out of
// scoring and listed. Drives a real crawl against a local site, then the status
// derivation the CLI and the cloud both use.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "@squirrelscan/crawler";
import { wafBlockCode, wafBlockReason } from "@squirrelscan/core-contracts/waf-block";

import { deriveAuditStatusFromPages } from "../src/scoring";

const DATADOME =
  `<html lang="en"><head><title>example.com</title></head><body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>` +
  `<script data-cfasync="false">var dd={'rt':'c','cid':'TESTCID','hsh':'TESTHASH','t':'fe','host':'geo.captcha-delivery.com'}</script>` +
  `<script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;

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
      routes[new URL(req.url).pathname]?.() ?? new Response("not found", { status: 404 }),
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
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const stats = await Effect.runPromise(crawler.storage.getStats(crawlId));
  const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
  return { stats, pages };
}

describe("a blocked seed page", () => {
  test("a challenge served as 200 is recorded as the seed block and is never stored as a page", async () => {
    const origin = serve({ "/": () => new Response(DATADOME, { headers: HTML }) });
    const { stats, pages } = await crawl(origin);
    expect(pages).toHaveLength(0);
    expect(stats?.wafBlocked?.seed).toMatchObject({
      status: 200,
      provider: "DataDome",
      providerId: "datadome",
      code: "blocked_by_datadome",
    });
    expect(stats?.wafBlocked?.total).toBe(1);
    expect(stats?.pagesBlocked).toBe(1);
  });

  test("it is still the seed when the sitemap lists the homepage first", async () => {
    const origin = serve({
      "/robots.txt": () => new Response("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n"),
      "/sitemap.xml": () => {
        const urls = ["/", "/a"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("");
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      },
      "/": () => new Response(DATADOME, { headers: HTML }),
      "/a": () => new Response(real("A", []), { headers: HTML }),
    });
    const { stats, pages } = await crawl(origin, true);
    expect(pages.map((page) => new URL(page.normalizedUrl).pathname)).toEqual(["/a"]);
    expect(stats?.wafBlocked?.seed?.code).toBe("blocked_by_datadome");
  });

  test("an AWS WAF challenge (202, header, empty body) is the seed block", async () => {
    const origin = serve({
      "/": () =>
        new Response("", { status: 202, headers: { ...HTML, "x-amzn-waf-action": "challenge" } }),
    });
    const { stats } = await crawl(origin);
    expect(stats?.wafBlocked?.seed).toMatchObject({
      status: 202,
      providerId: "aws-waf",
      code: "blocked_by_aws_waf",
    });
  });

  test("a Kasada challenge (429) is a block, not rate limiting", async () => {
    const kasada =
      "<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};KPSDK.start=Date.now();</script>" +
      '<script src="/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/ips.js"></script></body></html>';
    const origin = serve({ "/": () => new Response(kasada, { status: 429, headers: HTML }) });
    const { stats } = await crawl(origin);
    expect(stats?.wafBlocked?.seed).toMatchObject({ status: 429, providerId: "kasada" });
    expect(stats?.pagesRateLimited ?? 0).toBe(0);
  });

  test("the audit is blocked with a reason that names the class, provider, signal and status", async () => {
    const origin = serve({ "/": () => new Response(DATADOME, { headers: HTML }) });
    const { stats, pages } = await crawl(origin);
    const run = deriveAuditStatusFromPages(
      pages.map((page) => ({ status: page.status })),
      stats?.pagesBlocked ?? 0,
      {},
      stats?.rootFailure,
      0,
      stats?.wafBlocked?.seed,
    );
    expect(run.status).toBe("blocked");
    expect(run.reasonCode).toBe("http_4xx");
    expect(run.reason).toContain("blocked_by_datadome");
    expect(run.reason).toContain("DataDome");
    expect(run.reason).toContain("HTTP 200");
    expect(run.reason).toContain("near-empty page");
  });

  test("it fails the audit even when other pages were fetched", () => {
    const seed = {
      url: "https://example.com/",
      status: 403,
      provider: "Cloudflare",
      providerId: "cloudflare",
      signal: "cf-mitigated: challenge header",
      code: wafBlockCode("cloudflare"),
    };
    const pages = [{ status: 200 }, { status: 200 }];
    expect(deriveAuditStatusFromPages(pages, 1).status).toBe("completed");
    const run = deriveAuditStatusFromPages(pages, 1, {}, undefined, 0, seed);
    expect(run).toMatchObject({
      status: "blocked",
      reasonCode: "http_4xx",
      reason: wafBlockReason(seed),
    });
  });
});

describe("a blocked page that is not the seed", () => {
  test("is listed, counted and never stored, and the audit still runs", async () => {
    const origin = serve({
      "/": () => new Response(real("Home", ["/a", "/b"]), { headers: HTML }),
      "/a": () => new Response(real("A", ["/"]), { headers: HTML }),
      "/b": () =>
        new Response(DATADOME, { status: 403, headers: { ...HTML, "x-datadome": "protected" } }),
    });
    const { stats, pages } = await crawl(origin);
    expect(pages.map((page) => new URL(page.normalizedUrl).pathname).sort()).toEqual(["/", "/a"]);
    expect(stats?.wafBlocked?.seed).toBeUndefined();
    expect(stats?.wafBlocked?.total).toBe(1);
    expect(stats?.wafBlocked?.providers).toEqual(["DataDome"]);
    expect(stats?.wafBlocked?.pages).toHaveLength(1);
    expect(stats?.wafBlocked?.pages[0]).toMatchObject({ status: 403, code: "blocked_by_datadome" });
    expect(
      deriveAuditStatusFromPages(
        pages.map((page) => ({ status: page.status })),
        stats?.pagesBlocked ?? 0,
      ).status,
    ).toBe("completed");
  });

  test("a near-miss (a content page that loads the DataDome tag) is audited", async () => {
    const tag = `${real("Home", [])}<script src="https://js.datadome.co/tags.js" async></script>`;
    const origin = serve({
      "/": () => new Response(tag, { headers: { ...HTML, "x-datadome": "protected" } }),
    });
    const { stats, pages } = await crawl(origin);
    expect(stats?.wafBlocked).toBeUndefined();
    expect(pages).toHaveLength(1);
  });
});
