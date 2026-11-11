// #1762: a URL that redirects is recorded as a redirect, not audited as a page with the
// destination's content. Real crawler against a local site, every rule enabled, both rule
// engines and both report assemblers. The site:
//   /r1 -> /linked                      single redirect, destination also linked
//   /r3 -> /h2 -> /h3 -> /three         three-hop chain, /three linked from nowhere
//   /gone -> /uncrawled                 destination linked from nowhere
//   /out -> other host                  external, never audited
//   /carried -> /carried-dest           supplied as a carried seed, not linked
//   /slash -> /slash/  and  /rslash/ -> /rslash   slash redirects, each way (#1510)
//   /trk -> /trk?utm_source=x           the same page once tracking is stripped
//   /aq -> /aq?foo=1                    the same page under allowQueryParams: ["id"]
//   sitemap lists /sm -> /sm-dest       (sitemap only, /sm-dest linked from nowhere)

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

function serve(links: string): { origin: string } {
  const other = Bun.serve({
    port: 0,
    fetch: () => new Response(html("Elsewhere", ""), { headers: { "content-type": "text/html" } }),
  });
  servers.push(other);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = `http://localhost:${server.port}`;
      const ok = (title: string, body = "") =>
        new Response(html(title, body), { headers: { "content-type": "text/html" } });
      const redirect = (to: string, status = 301) =>
        new Response(null, { status, headers: { location: to } });
      switch (url.pathname) {
        case "/":
          return ok("Home", links);
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
        case "/slash":
          return redirect("/slash/");
        case "/slash/":
          return ok("Slash");
        case "/rslash/":
          return redirect("/rslash");
        case "/rslash":
          return ok("Reverse slash");
        case "/trk":
          return url.search ? ok("Tracked") : redirect("/trk?utm_source=x");
        case "/aq":
          return url.search ? ok("Allow query") : redirect("/aq?foo=1");
        case "/dead":
          return redirect("/nowhere");
        case "/loop-a":
          return redirect("/loop-b");
        case "/loop-b":
          return redirect("/loop-a");
        case "/sm":
          return redirect("/sm-dest");
        case "/sm-dest":
          return ok("Sitemap dest");
        case "/sitemap.xml":
          if (links !== FULL_LINKS) return new Response("nf", { status: 404 });
          return new Response(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/sm</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        default:
          return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}` };
}

const FULL_LINKS =
  `<a href="/linked">L</a><a href="/r1">R1</a><a href="/r3">R3</a><a href="/gone">G</a><a href="/out">O</a>` +
  `<a href="/slash">S</a><a href="/rslash/">RS</a><a href="/trk">T</a><a href="/aq">A</a>`;

const configFor = (maxPages: number) =>
  ({
    rule_options: {},
    rules: { enable: ["*"] },
    crawler: { max_pages: maxPages, exclude: [] },
    external_links: { enabled: false },
    internal_links: { enabled: true },
  }) as unknown as Config;

type RuleChecks = Map<string, { checks: CheckResult[] }>;
interface Outcome {
  origin: string;
  stored: Map<string, { status: number; html: string | null; finalUrl: string }>;
  rules: RuleChecks;
  v1Report: { totalPages: number; pages: Array<{ url: string }> };
  v2Report: { totalPages: number };
}

async function run(
  engine: "v1" | "v2",
  opts: { maxPages?: number; links?: string; carried?: boolean; legacy?: boolean } = {},
): Promise<Outcome> {
  const maxPages = opts.maxPages ?? 40;
  const { origin } = serve(opts.links ?? FULL_LINKS);
  const config = configFor(maxPages);
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        allowQueryParams: ["id"],
        ...(opts.carried === false ? {} : { carriedSeedUrls: [`${origin}/carried`] }),
      },
    }),
  );
  const storage = crawler.storage as SQLiteStorage;
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  return Effect.runPromise(
    Effect.gen(function* () {
      if (opts.legacy) {
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
      const preRules = yield* runStreamingPreRules(storage, crawlId, config, {});
      const pages = yield* storage.getPages(crawlId);
      const stored = new Map(
        pages.map((p) => [p.normalizedUrl, { status: p.status, html: p.html, finalUrl: p.finalUrl }]),
      );
      const ran =
        engine === "v1"
          ? yield* runRulesOnStorage(storage, crawlId, yield* buildSiteContext(pages), config, preRules.assets)
          : yield* runStreamingRules(storage, crawlId, config, preRules.assets);
      const v1Report = yield* generateReportFromStorage(storage, crawlId, ran as never);
      const v2Report = yield* buildV2Report(storage, crawlId, { ...(ran as object), tallies: (ran as { tallies?: Map<never, never> }).tallies ?? new Map() } as never);
      return { origin, stored, rules: ran.ruleResultsMap as unknown as RuleChecks, v1Report, v2Report } as Outcome;
    }) as Effect.Effect<Outcome, never, never>,
  );
}

/** Rules that report a redirect itself, so they may name the redirecting URL. */
const REDIRECT_RULES = new Set([
  "crawl/canonical-chain",
  "crawl/redirect-chain",
  "links/redirect-chains",
  "i18n/hreflang-targets",
  "crawl/sitemap-coverage",
]);

function pageUrlsOf(out: Outcome, ruleId: string): string[] {
  const urls = new Set<string>();
  for (const check of out.rules.get(ruleId)?.checks ?? []) {
    if (check.pageUrl) urls.add(check.pageUrl);
    for (const item of check.items ?? []) urls.add(item.id);
  }
  return [...urls];
}

const REDIRECTS = ["/r1", "/r3", "/gone", "/carried", "/slash", "/rslash/", "/sm"];
const AUDITED = ["/linked", "/three", "/uncrawled", "/carried-dest", "/slash/", "/rslash", "/sm-dest"];

describe.each(["v1", "v2"] as const)("redirecting URLs are not pages (#1762, %s)", (engine) => {
  test("the crawler records redirects without a body (slash each way included) and queues destinations", async () => {
    const { origin, stored } = await run(engine);
    for (const path of REDIRECTS) {
      const row = stored.get(`${origin}${path}`);
      expect(row, path).toBeDefined();
      expect(row!.html, path).toBeNull();
      expect(row!.status, path).toBeGreaterThanOrEqual(300);
      expect(row!.status, path).toBeLessThan(400);
    }
    for (const path of AUDITED) expect(stored.get(`${origin}${path}`)?.html, path).toBeTruthy();
    // External redirect: refused, never stored with the other site's content.
    expect(stored.get(`${origin}/out`)?.html ?? null).toBeNull();
  }, 60_000);

  test("a redirect that is the same page after the frontier's normalization keeps its content (utm, allowQueryParams)", async () => {
    const { origin, stored, rules } = await run(engine);
    for (const path of ["/trk", "/aq"]) {
      expect(stored.get(`${origin}${path}`)?.status, path).toBe(200);
      expect(stored.get(`${origin}${path}`)?.html, path).toBeTruthy();
      expect(pageUrlsOf({ rules } as Outcome, "content/word-count"), path).toContain(`${origin}${path}`);
    }
  }, 60_000);

  test("no page-level rule lists a redirecting URL, destinations are audited once", async () => {
    const out = await run(engine);
    for (const [ruleId, result] of out.rules) {
      if (REDIRECT_RULES.has(ruleId)) continue;
      for (const check of result.checks) {
        for (const path of REDIRECTS) {
          expect(check.pageUrl, `${ruleId} ${check.name}`).not.toBe(`${out.origin}${path}`);
        }
      }
    }
    const audited = pageUrlsOf(out, "content/word-count");
    for (const path of [...REDIRECTS, "/out"]) expect(audited, path).not.toContain(`${out.origin}${path}`);
    for (const path of AUDITED) {
      expect(audited.filter((u) => u === `${out.origin}${path}`), path).toHaveLength(1);
    }
  }, 60_000);

  test("redirect rules still report the redirecting URL and its hops", async () => {
    const out = await run(engine);
    const chains = pageUrlsOf(out, "links/redirect-chains");
    for (const path of REDIRECTS.filter((p) => p !== "/sm")) {
      expect(chains, path).toContain(`${out.origin}${path}`);
    }
    expect(pageUrlsOf(out, "crawl/canonical-chain")).toEqual(
      expect.arrayContaining([`${out.origin}/r3`, `${out.origin}/slash`, `${out.origin}/rslash/`]),
    );
    const checks = out.rules.get("links/redirect-chains")!.checks;
    const multi = checks.find((c) => c.name === "redirect-chain-multi-hop");
    expect(multi?.items?.find((i) => i.id === `${out.origin}/r3`)?.label).toContain("/h2");
    expect(pageUrlsOf(out, "crawl/redirect-chain")).toContain(`${out.origin}/r3`);
  }, 60_000);

  test("the report's page totals and page list leave redirecting URLs out, in both assemblers", async () => {
    const out = await run(engine);
    const contentRows = [...out.stored.entries()].filter(([, row]) => row.status < 300 || row.status >= 400);
    expect(out.v1Report.totalPages).toBe(contentRows.length);
    expect(out.v2Report.totalPages).toBe(contentRows.length);
    expect(out.v1Report.pages).toHaveLength(contentRows.length);
    const listed = out.v1Report.pages.map((p) => p.url);
    for (const path of REDIRECTS) expect(listed, path).not.toContain(`${out.origin}${path}`);
    for (const path of AUDITED) expect(listed, path).toContain(`${out.origin}${path}`);
  }, 60_000);

  test("both assemblers carry the crawl's redirect rows as transport evidence for the signal (#1759)", async () => {
    const out = await run(engine);
    const redirected = [...out.stored.entries()].filter(([, row]) => row.status >= 300 && row.status < 400);
    expect(redirected.length).toBeGreaterThan(0);
    for (const report of [out.v1Report, out.v2Report]) {
      const rows = new Map((report.redirectedPages ?? []).map((r) => [r.url, r]));
      expect(rows.size).toBe(redirected.length);
      for (const [url, stored] of redirected) {
        expect(rows.get(url)?.finalUrl, url).toBe(stored.finalUrl);
        expect(rows.get(url)!.status).toBeGreaterThanOrEqual(300);
      }
      expect(report.redirectedPagesTotal).toBeUndefined();
    }
  }, 60_000);

  test("redirect rows take no maxPages slot: with maxPages 2 the destination is still audited", async () => {
    const out = await run(engine, {
      maxPages: 2,
      carried: false,
      links: `<a href="/r1">R1</a>`,
    });
    expect(out.stored.get(`${out.origin}/linked`)?.html).toBeTruthy();
    expect(out.v1Report.pages.map((p) => p.url).sort()).toEqual([`${out.origin}/`, `${out.origin}/linked`].sort());
    expect(out.v1Report.totalPages).toBe(2);
  }, 60_000);

  test("a stored redirecting URL that still holds the destination's markup is not audited, and its hops are reported", async () => {
    const out = await run(engine, { legacy: true });
    expect(pageUrlsOf(out, "content/word-count")).not.toContain(`${out.origin}/legacy`);
    expect(pageUrlsOf(out, "content/word-count").filter((u) => u === `${out.origin}/linked`)).toHaveLength(1);
    expect(pageUrlsOf(out, "links/redirect-chains")).toContain(`${out.origin}/legacy`);
    expect(pageUrlsOf(out, "crawl/canonical-chain")).toContain(`${out.origin}/legacy`);
    expect(out.v1Report.pages.map((p) => p.url)).not.toContain(`${out.origin}/legacy`);
  }, 60_000);
});

describe.each(["v1", "v2"] as const)("a redirect that ends in an error or loops stays an ordinary row (#1762, %s)", (engine) => {
  const links = `<a href="/linked">L</a><a href="/dead">D</a><a href="/loop-a">LA</a>`;

  test("/dead -> 301 -> /nowhere (404) is stored as the error it answered, and the link to it is still broken", async () => {
    const out = await run(engine, { links, carried: false });
    const dead = out.stored.get(`${out.origin}/dead`);
    expect(dead).toBeDefined();
    // Not a redirect marker (a 3xx that resolved): the row an error redirect always was.
    expect(dead!.status).toBeGreaterThanOrEqual(400);
    expect(pageUrlsOf(out, "links/broken-links")).toContain(`${out.origin}/dead`);
    // It counts as a page row like any 404 page (not excluded as a redirect).
    expect(out.v1Report.pages.some((p) => p.url === `${out.origin}/dead`)).toBe(true);
  }, 60_000);

  test("/loop-a <-> /loop-b is not a redirect row either", async () => {
    const out = await run(engine, { links, carried: false });
    const loop = out.stored.get(`${out.origin}/loop-a`);
    expect(loop).toBeDefined();
    // A loop never resolved: it is not the 3xx marker with a resolved chain the engine reads as a redirect.
    expect(loop!.html ?? "").toBe("");
    expect(out.v1Report.pages.some((p) => p.url === `${out.origin}/loop-a`)).toBe(true);
  }, 60_000);
});

