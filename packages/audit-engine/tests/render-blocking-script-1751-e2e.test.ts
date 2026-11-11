// #1751 end-to-end: a synchronous <script src> in the head of one page is listed by
// perf/render-blocking for that page, with its measured response time when slow.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const page = (head: string, title: string) =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>Body copy for ${title}.</p></main></body></html>`;

const PAGES = ["/", "/a", "/b", "/c"];

function serve(slowMs: number, warmFirst: boolean): string {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      if (url.pathname === "/slow.js") {
        await Bun.sleep(slowMs);
        return ok("window.slow = 1;", "application/javascript");
      }
      if (url.pathname === "/warm.js") return ok("window.warm = 1;", "application/javascript");
      if (url.pathname === "/site.css") return ok("body{margin:0}", "text/css");
      if (url.pathname === "/sitemap.xml") {
        const locs = PAGES.map((p) => `<url><loc>${url.origin}${p}</loc></url>`).join("");
        return ok(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
          "application/xml",
        );
      }
      if (url.pathname === "/robots.txt") return ok("User-agent: *\nAllow: /\n", "text/plain");
      if (PAGES.includes(url.pathname)) {
        const css = `<link rel="stylesheet" href="/site.css">`;
        const warm = warmFirst ? `<script src="/warm.js"></script>` : "";
        const head = url.pathname === "/" ? `${css}${warm}<script src="/slow.js"></script>` : css;
        return ok(page(head, `Page ${url.pathname}`));
      }
      return new Response("nope", { status: 404 });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function audit(slowMs: number, warmFirst = false) {
  const origin = serve(slowMs, warmFirst);
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
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const config = {
    rule_options: {},
    rules: { enable: ["perf/render-blocking"] },
    crawler: { max_pages: 10, exclude: [] },
    external_links: { enabled: false, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
    internal_links: { enabled: false },
  } as unknown as Config;
  const preRules = await Effect.runPromise(
    runStreamingPreRules(crawler.storage, crawlId, config, {}),
  );
  const ran = await Effect.runPromise(
    runStreamingRules(crawler.storage, crawlId, config, preRules.assets) as Effect.Effect<
      { pageRuleResults: Map<string, Map<string, CheckResult[]>> },
      never,
      never
    >,
  );
  const byPath = new Map<string, CheckResult[]>();
  for (const [url, rules] of ran.pageRuleResults) {
    byPath.set(new URL(url).pathname, rules.get("perf/render-blocking") ?? []);
  }
  return byPath;
}

describe("perf/render-blocking lists a synchronous head script (#1751)", () => {
  test("the page with the script lists it, the template siblings do not", async () => {
    const byPath = await audit(10);
    expect(byPath.size).toBe(4);
    const home = byPath.get("/")!;
    const blocking = home.find((c) => c.name === "render-blocking")!;
    expect(blocking.items?.map((i) => i.id).sort()).toEqual(["/site.css", "/slow.js"]);
    const sibling = byPath.get("/a")!.find((c) => c.name === "render-blocking")!;
    expect(sibling.items?.map((i) => i.id)).toEqual(["/site.css"]);
    // Fast script: listed, but not reported as slow.
    expect(home.find((c) => c.name === "slow-blocking-script")).toBeUndefined();
  }, 20_000);

  test("the first script of its host is not reported at 1 to 2 s: its time includes the connection setup", async () => {
    const byPath = await audit(1200);
    expect(byPath.get("/")!.some((c) => c.name === "slow-blocking-script")).toBe(false);
  }, 20_000);

  test("a blocking script slower than 1 s from a warm host is a warning with its measured time, on its page only", async () => {
    const byPath = await audit(1200, true);
    const slow = byPath.get("/")!.find((c) => c.name === "slow-blocking-script")!;
    expect(slow.status).toBe("warn");
    expect(slow.items).toHaveLength(1);
    expect(slow.items![0]!.id).toEndWith("/slow.js");
    const ms = slow.items![0]!.meta?.responseMs as number;
    expect(ms).toBeGreaterThanOrEqual(1200);
    expect(slow.message).toContain(`${ms} ms`);
    for (const path of ["/a", "/b", "/c"]) {
      expect(byPath.get(path)!.some((c) => c.name === "slow-blocking-script")).toBe(false);
    }
  }, 20_000);

  test("a blocking script over 2 s is reported even as the first of its host", async () => {
    const byPath = await audit(2200);
    const slow = byPath.get("/")!.find((c) => c.name === "slow-blocking-script")!;
    expect(slow.status).toBe("warn");
    expect(slow.items![0]!.meta?.responseMs as number).toBeGreaterThanOrEqual(2200);
  }, 20_000);
});
