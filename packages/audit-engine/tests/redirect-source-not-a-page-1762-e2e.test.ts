// #1762: a URL that redirects is recorded as a redirect, not audited as a page with the
// destination's content. Real crawler against a local site, both rule engines. The site:
//   /r1 -> /linked                      (single redirect, destination also linked)
//   /r3 -> /h2 -> /h3 -> /three         (three-hop chain, /three linked from nowhere)
//   /gone -> /uncrawled                 (destination linked from nowhere, only the redirect is)
//   /out -> other host                  (external, never audited)
//   /carried -> /carried-dest           (supplied as a carried seed, not linked)

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${words(40)}</p>${body}</main></body></html>`;

function serve(): { origin: string } {
  const other = Bun.serve({
    port: 0,
    fetch: () => new Response(html("Elsewhere", ""), { headers: { "content-type": "text/html" } }),
  });
  servers.push(other);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const ok = (title: string, body = "") =>
        new Response(html(title, body), { headers: { "content-type": "text/html" } });
      const redirect = (to: string, status = 301) =>
        new Response(null, { status, headers: { location: to } });
      switch (url.pathname) {
        case "/":
          return ok(
            "Home",
            `<a href="/linked">L</a><a href="/r1">R1</a><a href="/r3">R3</a><a href="/gone">G</a><a href="/out">O</a>`,
          );
        case "/linked":
          return ok("Linked");
        case "/r1":
          return redirect("/linked");
        case "/r3":
          return redirect("/h2");
        case "/h2":
          return redirect("/h3", 302);
        case "/h3":
          return redirect("/three");
        case "/three":
          return ok("Three");
        case "/gone":
          return redirect("/uncrawled");
        case "/uncrawled":
          return ok("Uncrawled");
        case "/out":
          return redirect(`http://127.0.0.1:${other.port}/`);
        case "/carried":
          return redirect("/carried-dest");
        case "/carried-dest":
          return ok("Carried dest");
        default:
          return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}` };
}

const RULES = ["content/word-count", "crawl/canonical-chain", "links/redirect-chains", "crawl/redirect-chain"];
const CONFIG = {
  rule_options: { "crawl/redirect-chain": { maxHops: 1 } },
  rules: { enable: RULES },
  crawler: { max_pages: 30, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

interface Outcome {
  stored: Map<string, { status: number; html: string | null; finalUrl: string }>;
  pagesCrawled: number | undefined;
  byRule: Map<string, CheckResult[]>;
}

async function run(
  engine: "v1" | "v2",
  legacy = false,
): Promise<{ origin: string; out: Outcome }> {
  const { origin } = serve();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 30,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        carriedSeedUrls: [`${origin}/carried`],
      },
    }),
  );
  const storage = crawler.storage as SQLiteStorage;
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      if (legacy) {
        // A page stored by an older crawl: the destination's markup filed under the redirecting URL.
        const [linked] = (yield* storage.getPages(crawlId)).filter((p) => p.normalizedUrl === `${origin}/linked`);
        const url = `${origin}/legacy`;
        yield* storage.upsertPage(crawlId, {
          ...linked!,
          url,
          normalizedUrl: url,
          finalUrl: `${origin}/linked`,
          redirectChain: {
            sourceUrl: url,
            finalUrl: `${origin}/linked`,
            hops: [
              { url, statusCode: 301, type: "http" },
              { url: `${origin}/linked`, statusCode: 200, type: "http" },
            ],
            endsInError: false,
          } as typeof linked.redirectChain,
        });
      }
      const preRules = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      const pages = yield* storage.getPages(crawlId);
      const stored = new Map(
        pages.map((p) => [p.normalizedUrl, { status: p.status, html: p.html, finalUrl: p.finalUrl }]),
      );
      if (engine === "v1") {
        const ctx = yield* buildSiteContext(pages);
        const ran = yield* runRulesOnStorage(storage, crawlId, ctx, CONFIG, preRules.assets);
        return { stored, pagesCrawled: undefined, byRule: ran.ruleResultsMap } as unknown as Outcome;
      }
      const ran = yield* runStreamingRules(storage, crawlId, CONFIG, preRules.assets);
      return { stored, pagesCrawled: undefined, byRule: ran.ruleResultsMap } as unknown as Outcome;
    }) as Effect.Effect<Outcome, never, never>,
  );
  return { origin, out };
}

function pageUrlsOf(out: Outcome, ruleId: string): string[] {
  const result = (out.byRule as unknown as Map<string, { checks: CheckResult[] }>).get(ruleId);
  const urls = new Set<string>();
  for (const check of result?.checks ?? []) {
    if (check.pageUrl) urls.add(check.pageUrl);
    for (const item of check.items ?? []) urls.add(item.id);
  }
  return [...urls];
}

describe.each(["v1", "v2"] as const)("redirecting URLs are not pages (#1762, %s)", (engine) => {
  test("crawler records redirects without a body and queues the destinations", async () => {
    const { origin, out } = await run(engine);
    for (const path of ["/r1", "/r3", "/gone", "/carried"]) {
      const row = out.stored.get(`${origin}${path}`);
      expect(row, path).toBeDefined();
      expect(row!.html, path).toBeNull();
      expect(row!.finalUrl, path).not.toBe(`${origin}${path}`);
    }
    // Destinations are audited once, as themselves, even when nothing else links to them.
    for (const path of ["/linked", "/three", "/uncrawled", "/carried-dest"]) {
      expect(out.stored.get(`${origin}${path}`)?.html, path).toBeTruthy();
    }
    // External redirect: refused, never stored with the other site's content.
    expect(out.stored.get(`${origin}/out`)?.html ?? null).toBeNull();
  }, 30_000);

  test("page rules run once, on the final URL only", async () => {
    const { origin, out } = await run(engine);
    const audited = pageUrlsOf(out, "content/word-count");
    for (const path of ["/r1", "/r3", "/gone", "/carried", "/out"]) {
      expect(audited, path).not.toContain(`${origin}${path}`);
    }
    for (const path of ["/linked", "/three", "/uncrawled", "/carried-dest"]) {
      expect(audited.filter((u) => u === `${origin}${path}`), path).toHaveLength(1);
    }
  }, 30_000);

  test("redirect rules still report the redirecting URL and its hops", async () => {
    const { origin, out } = await run(engine);
    const chains = pageUrlsOf(out, "links/redirect-chains");
    for (const path of ["/r1", "/r3", "/gone", "/carried"]) expect(chains).toContain(`${origin}${path}`);
    expect(pageUrlsOf(out, "crawl/redirect-chain")).toContain(`${origin}/r3`);
    const canonical = pageUrlsOf(out, "crawl/canonical-chain");
    expect(canonical).toContain(`${origin}/r3`);
    const checks = (out.byRule as unknown as Map<string, { checks: CheckResult[] }>).get("links/redirect-chains")!.checks;
    const multi = checks.find((c) => c.name === "redirect-chain-multi-hop");
    expect(multi?.items?.find((i) => i.id === `${origin}/r3`)?.label).toContain("/h2");
  }, 30_000);
});

describe.each(["v1", "v2"] as const)("a stored redirecting URL that still holds the destination's markup (#1762, %s)", (engine) => {
  test("is not audited as a page, and its hops are still reported", async () => {
    const { origin, out } = await run(engine, true);
    expect(pageUrlsOf(out, "content/word-count")).not.toContain(`${origin}/legacy`);
    expect(pageUrlsOf(out, "content/word-count").filter((u) => u === `${origin}/linked`)).toHaveLength(1);
    expect(pageUrlsOf(out, "links/redirect-chains")).toContain(`${origin}/legacy`);
    expect(pageUrlsOf(out, "crawl/canonical-chain")).toContain(`${origin}/legacy`);
  }, 30_000);
});
