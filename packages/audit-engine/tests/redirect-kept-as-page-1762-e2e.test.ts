// #1762: a redirect whose destination the crawl will not visit (here an excluded path) is kept as a PAGE:
// the source row holds the destination's content under a 2xx status and a different final URL, the shape
// of a row an older crawler stored for a redirect. The crawler marks it (`redirectChain.keptAsPage`) so the
// engine does not drop it as a legacy redirect: the content is audited once, under the source URL, and the
// crawl's page count agrees with the report's. Real crawler, both rule engines and both report assemblers.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, generateReportFromStorage, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { buildV2Report } from "../src/report-stream";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${words(40)}</p>${body}</main></body></html>`;

function serve(): { origin: string } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const ok = (title: string, body = "") =>
        new Response(html(title, body), { headers: { "content-type": "text/html" } });
      if (pathname === "/") return ok("Home", `<a href="/docs/">Docs</a><a href="/r1">R1</a><a href="/linked">L</a>`);
      if (pathname === "/docs/") return new Response(null, { status: 301, headers: { location: "/documentation/" } });
      if (pathname === "/documentation/") return ok("Documentation");
      if (pathname === "/r1") return new Response(null, { status: 301, headers: { location: "/linked" } });
      if (pathname === "/linked") return ok("Linked");
      return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}` };
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["*"] },
  crawler: { max_pages: 40, exclude: ["/documentation"] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

async function run(engine: "v1" | "v2") {
  const { origin } = serve();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 40,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        exclude: ["/documentation"],
      },
    }),
  );
  const storage = crawler.storage as SQLiteStorage;
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  return Effect.runPromise(
    Effect.gen(function* () {
      const preRules = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      const pages = yield* storage.getPages(crawlId);
      const ran =
        engine === "v1"
          ? yield* runRulesOnStorage(storage, crawlId, yield* buildSiteContext(pages), CONFIG, preRules.assets)
          : yield* runStreamingRules(storage, crawlId, CONFIG, preRules.assets);
      const v1Report = yield* generateReportFromStorage(storage, crawlId, ran as never);
      const v2Report = yield* buildV2Report(storage, crawlId, { ...(ran as object), tallies: (ran as { tallies?: Map<never, never> }).tallies ?? new Map() } as never);
      const pageCount = yield* storage.getPageCount(crawlId);
      return {
        origin,
        pages,
        pageCount,
        rules: ran.ruleResultsMap as unknown as Map<string, { checks: CheckResult[] }>,
        v1Report: v1Report as unknown as { totalPages: number; pages: Array<{ url: string }> },
        v2Report: v2Report as unknown as { totalPages: number },
      };
    }) as Effect.Effect<never, never, never>,
  ) as Promise<{
    origin: string;
    pages: Array<{ normalizedUrl: string; status: number; html: string | null; redirectChain?: { keptAsPage?: boolean } }>;
    pageCount: number;
    rules: Map<string, { checks: CheckResult[] }>;
    v1Report: { totalPages: number; pages: Array<{ url: string }> };
    v2Report: { totalPages: number };
  }>;
}

describe.each(["v1", "v2"] as const)("a redirect to a destination the crawl will not visit stays a page (#1762, %s)", (engine) => {
  test("/docs/ keeps the destination's content, marked, and is audited and counted as a page", async () => {
    const out = await run(engine);
    const docs = out.pages.find((p) => p.normalizedUrl === `${out.origin}/docs/`);
    expect(docs?.status).toBe(200);
    expect(docs?.html).toBeTruthy();
    expect(docs?.redirectChain?.keptAsPage).toBe(true);
    // Not a redirect row: it is in the report's page list (v1) and totals (v1 and v2), and the crawl's page count.
    expect(out.v1Report.pages.map((p) => p.url)).toContain(`${out.origin}/docs/`);
    const contentRows = out.pages.filter((p) => p.status < 300 || p.status >= 400);
    expect(out.v1Report.totalPages).toBe(contentRows.length);
    expect(out.v2Report.totalPages).toBe(contentRows.length);
    expect(out.pageCount).toBe(contentRows.length);
    // Its content is audited, once, under the source URL.
    const audited = (out.rules.get("content/word-count")?.checks ?? []).map((c) => c.pageUrl);
    expect(audited.filter((u) => u === `${out.origin}/docs/`)).toHaveLength(1);
    // A real redirect on the same site is still a redirect.
    const r1 = out.pages.find((p) => p.normalizedUrl === `${out.origin}/r1`);
    expect(r1?.status).toBeGreaterThanOrEqual(300);
    expect(out.v1Report.pages.map((p) => p.url)).not.toContain(`${out.origin}/r1`);
  }, 60_000);
});
