// squirrelscan/repo#3346: the asset checks built their headers by spreading
// records, so a custom `user-agent` sat beside the built-in `User-Agent` and the
// request sent both values combined. It now replaces it.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";

import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

describe("asset checks with a custom header that differs only in case (repo#3346)", () => {
  test("stylesheet, script and image requests send the custom agent alone", async () => {
    const seen: Array<{ path: string; userAgent: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, userAgent: req.headers.get("user-agent") });
        switch (url.pathname) {
          case "/":
            return new Response(
              `<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script></head><body><img src="/logo.png" alt="x" width="1" height="1"></body></html>`,
              { headers: { "content-type": "text/html" } },
            );
          case "/style.css":
            return new Response("body{}", { headers: { "content-type": "text/css" } });
          case "/app.js":
            return new Response("void 0;", { headers: { "content-type": "text/javascript" } });
          case "/logo.png":
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              headers: { "content-type": "image/png" },
            });
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;
    const headers = { "user-agent": "custom-agent" };

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
          headers,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
    const config = {
      rule_options: {},
      rules: { enable: ["*"] },
      crawler: { max_pages: 1, exclude: [], headers },
      external_links: { enabled: false },
      internal_links: { enabled: false },
    } as unknown as Config;
    await Effect.runPromise(runStreamingPreRules(crawler.storage, crawlId, config, {}));

    const assets = seen.filter((s) => ["/style.css", "/app.js", "/logo.png"].includes(s.path));
    expect(new Set(assets.map((s) => s.path))).toEqual(
      new Set(["/style.css", "/app.js", "/logo.png"]),
    );
    for (const s of assets) expect(s.userAgent).toBe("custom-agent");
  });
});
