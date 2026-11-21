// #1778 end to end: a targeted run runs the site rules that can be judged from the listed pages alone, with
// the internal link check on. A real server with a 20 page site records every request, so "each link target
// is checked once, and only links on the listed pages" is what the site saw. Rules that need the whole site
// still skip with `targeted-run`. Both engines.

import type { Config } from "@squirrelscan/config";

import {
  TARGETED_RUN_SKIP_REASON,
  type CheckResult,
} from "@squirrelscan/core-contracts";
import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";
import { SITE_RULES_ON_TARGETED_RUN } from "@squirrelscan/rules";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
} from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const PAGE_COUNT = 20;
const TARGETS = ["/p/1", "/p/3", "/p/4"];

function serve(): { origin: string; hits: string[] } {
  const hits: string[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(`${req.method} ${pathname}`);
      if (pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (!pathname.startsWith("/p/"))
        return new Response("not found", { status: 404 });
      const n = Number(pathname.split("/").pop());
      // Every page links to every page. /p/1 alone also links to /missing (a 404) and to an id /p/4 lacks;
      // /p/12 alone links to /gone, a 404 that no listed page links to.
      const links = Array.from(
        { length: PAGE_COUNT },
        (_, i) => `<a href="/p/${i}">p${i}</a>`
      ).join(" ");
      const extra =
        n === 1
          ? `<a href="/missing">missing</a> <a href="/p/4#nowhere">anchor</a>`
          : n === 12
            ? `<a href="/gone">gone</a>`
            : "";
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${n}</title></head><body><h1 id="top">Page</h1>${links} ${extra}</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            // /p/3 frames nothing; the other pages send no clickjacking protection.
            ...(n === 3 ? { "x-frame-options": "DENY" } : {}),
          },
        }
      );
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits };
}

const CONFIG = {
  rule_options: {},
  rules: {
    enable: [
      "links/broken-links",
      "links/broken-anchors",
      "links/broken-external-links",
      "links/orphan-pages",
      "content/duplicate-title",
      "crawl/sitemap-coverage",
      "security/leaked-secrets",
      "security/csp",
      "security/x-frame-options",
      "crawl/robots-txt",
    ],
  },
  crawler: { max_pages: 50, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

async function audit(engine: "v1" | "v2") {
  const { origin, hits } = serve();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 50,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: true,
        incremental: false,
        useCacheControl: false,
        targetUrls: TARGETS.map((p) => `${origin}${p}`),
      },
    })
  );
  const crawlId = await Effect.runPromise(
    crawler.start(`${origin}/`, `${origin}/`)
  );
  const storage = crawler.storage as SQLiteStorage;
  const stored = await Effect.runPromise(storage.getPages(crawlId));
  const crawlHits = [...hits];
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(
          storage,
          crawlId,
          siteContext,
          CONFIG,
          pre.assets
        );
      }
      return yield* runStreamingRules(storage, crawlId, CONFIG, pre.assets);
    }) as Effect.Effect<
      { ruleResultsMap: Map<string, { checks: CheckResult[] }> },
      never,
      never
    >
  );
  const checks = (id: string) =>
    (ran.ruleResultsMap.get(id)?.checks ?? []) as CheckResult[];
  return { hits, crawlHits, checks };
}

const path = (url: string) => new URL(url).pathname;

for (const engine of ["v1", "v2"] as const) {
  describe(`site rules on a targeted run (${engine})`, () => {
    test("the link, secret and header rules run; the rules that need the whole site skip", async () => {
      const r = await audit(engine);

      for (const id of [
        "links/broken-links",
        "links/broken-anchors",
        "links/broken-external-links",
        "security/leaked-secrets",
        "security/csp",
        "security/x-frame-options",
      ]) {
        expect(SITE_RULES_ON_TARGETED_RUN.has(id), id).toBe(true);
        const c = r.checks(id);
        expect(c.length, id).toBeGreaterThan(0);
        expect(
          c.some((x) => x.skipReason === TARGETED_RUN_SKIP_REASON),
          id
        ).toBe(false);
      }
      for (const id of [
        "links/orphan-pages",
        "content/duplicate-title",
        "crawl/sitemap-coverage",
      ]) {
        const c = r.checks(id);
        expect(c.length, id).toBeGreaterThan(0);
        expect(
          c.every(
            (x) =>
              x.status === "skipped" &&
              x.skipReason === TARGETED_RUN_SKIP_REASON
          ),
          id
        ).toBe(true);
      }
    });

    test("broken links and anchors are reported for links on the listed pages only", async () => {
      const r = await audit(engine);
      const broken = r
        .checks("links/broken-links")
        .filter((c) => c.status === "fail");
      const items = broken.flatMap((c) => c.items ?? []);
      // /missing is linked from /p/1, a listed page. /gone is linked only from /p/12, which was not listed.
      expect(items.map((i) => path(i.id))).toEqual(["/missing"]);
      expect(items[0]!.sourcePages!.map(path)).toEqual(["/p/1"]);
      // Every link target was fetched or checked, so nothing is left as "not checked".
      expect(
        r.checks("links/broken-links").some((c) => c.status === "skipped")
      ).toBe(false);

      const anchors = r
        .checks("links/broken-anchors")
        .filter((c) => c.status === "warn");
      expect(anchors.flatMap((c) => c.items ?? []).map((i) => i.id)).toEqual([
        expect.stringMatching(/\/p\/4#nowhere$/),
      ]);
    });

    test("each link target on the listed pages is status-checked once; no other page is requested", async () => {
      const r = await audit(engine);
      // The crawl fetched robots.txt and the three listed pages, as #1777 does.
      expect([...new Set(r.crawlHits)].sort()).toEqual([
        "GET /p/1",
        "GET /p/3",
        "GET /p/4",
        "GET /robots.txt",
      ]);
      const after = r.hits
        .slice(r.crawlHits.length)
        .map((h) => h.split(" ")[1]!);
      // The HEAD control is a listed page that answered 2xx, asked once: never the start URL, which a
      // targeted run did not fetch.
      const control = after.filter((p) => TARGETS.includes(p));
      expect(control).toHaveLength(1);
      expect(after).not.toContain("/");
      // The link check asked for the other link targets of the listed pages, each once.
      const probed = after.filter((p) => !TARGETS.includes(p));
      const expected = [
        ...Array.from({ length: PAGE_COUNT }, (_, i) => `/p/${i}`).filter(
          (p) => !TARGETS.includes(p)
        ),
        "/missing",
      ].sort();
      expect([...probed].sort()).toEqual(expected);
      // /gone sits only on a page that was not listed: never requested.
      expect(r.hits.some((h) => h.endsWith(" /gone"))).toBe(false);
    });

    test("the header rules read each listed page's own headers", async () => {
      const r = await audit(engine);
      const xfo = r.checks("security/x-frame-options");
      const pagesOf = (name: string) =>
        xfo
          .filter((c) => c.name === name)
          .flatMap((c) => c.pages ?? [])
          .map(path)
          .sort();
      expect(pagesOf("x-frame-options")).toEqual(["/p/3"]);
      expect(pagesOf("x-frame-options-missing")).toEqual(["/p/1", "/p/4"]);
      const csp = r
        .checks("security/csp")
        .filter((c) => c.name === "csp-missing");
      expect(
        csp
          .flatMap((c) => c.pages ?? [])
          .map(path)
          .sort()
      ).toEqual(TARGETS);
    });
  });
}
