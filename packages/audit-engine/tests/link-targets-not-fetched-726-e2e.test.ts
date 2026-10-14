// pub#726 end-to-end: the issue's fixture through the real crawler, the real
// pre-rules phase (which carries the internal link check) and both rule paths.
// The home page links /about (in the sitemap), /missing (404), /moved (301 to a
// 410), /private (403), /logout and a token link. A Quick-style crawl does not
// follow links, so the check answers /missing, /moved and /private and skips
// the last two as actions. The "Not checked" line used to blame the target
// limit for those two ("status-checked only the 3 most-linked targets ...
// raise internal_links.max_targets") with the limit at 200.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";
import { notCheckedLines } from "@squirrelscan/report";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const TOKEN_LINK = "/account?token=0123456789abcdef01234567";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Every path (with query) the fixture server was asked for, across the last audit. */
let requested: string[] = [];

const html = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

function serveSite(): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(`${url.pathname}${url.search}`);
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      switch (url.pathname) {
        case "/":
          return ok(
            html(
              ["/about", "/missing", "/moved", "/private", "/logout", TOKEN_LINK]
                .map((href) => `<a href="${href.replaceAll("&", "&amp;")}">${href}</a>`)
                .join(" "),
            ),
          );
        case "/about":
          return ok(html(`<a href="/">Home</a>`));
        case "/moved":
          return new Response(null, { status: 301, headers: { location: "/gone" } });
        case "/gone":
          return new Response(html("Gone"), {
            status: 410,
            headers: { "content-type": "text/html" },
          });
        case "/private":
          return new Response(html("Forbidden"), {
            status: 403,
            headers: { "content-type": "text/html" },
          });
        case "/sitemap.xml":
          return ok(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.origin}/</loc></url><url><loc>${url.origin}/about</loc></url></urlset>`,
            "application/xml",
          );
        case "/robots.txt":
          return ok(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, "text/plain");
      }
      return new Response(html("Not found"), {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function audit(engine: "v1" | "v2", maxTargets?: number) {
  const origin = serveSite();
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
        disableLinkDiscovery: true,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
  const config = {
    rule_options: {},
    rules: { enable: ["links/broken-links"] },
    crawler: { max_pages: 10, exclude: [] },
    external_links: { enabled: false },
    internal_links: {
      enabled: true,
      ...(maxTargets !== undefined ? { max_targets: maxTargets } : {}),
    },
  } as unknown as Config;
  const preRules = await Effect.runPromise(runStreamingPreRules(storage, crawlId, config, {}));
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, preRules.assets);
      }
      return yield* runStreamingRules(storage, crawlId, config, preRules.assets);
    }) as Effect.Effect<{ siteRuleResults: Map<string, CheckResult[]> }, never, never>,
  );
  const checks = ran.siteRuleResults.get("links/broken-links") ?? [];
  const lines = notCheckedLines({
    ruleResults: {
      "links/broken-links": {
        meta: {
          id: "links/broken-links",
          name: "Broken Links",
          description: "",
          category: "links",
          scope: "site",
          severity: "error",
          weight: 7,
        },
        checks,
      },
    },
  });
  return { checks, lines };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`the internal link Not checked line names the real cause (${engine})`, () => {
    test("targets skipped as actions, limit not reached: names the skip, not the limit", async () => {
      const { checks, lines } = await audit(engine);
      // The check never asked for the action or the token link.
      expect(requested).not.toContain("/logout");
      expect(requested).not.toContain(TOKEN_LINK);
      expect(requested).toEqual(
        expect.arrayContaining(["/missing", "/moved", "/gone", "/private"]),
      );

      const skipped = checks.find((c) => c.status === "skipped")!;
      expect(skipped.details?.notFetched).toEqual({ skipped: 2 });
      expect(lines).toEqual([
        "Not checked: Broken Links. 2 of 7 internal link target(s) were not fetched because this audit did not follow links and its internal link checks never request targets outside the crawl scope, disallowed by robots.txt, or that look like actions (log out, unsubscribe) or carry a token, so they were not checked for broken links. A Surface or Full audit, which follows links, can reach the ones inside the crawl scope and allowed by robots.txt.",
      ]);
      // The answered 404 and 410 are still reported.
      expect(
        checks
          .find((c) => c.status === "fail")
          ?.items?.map((i) => i.meta?.statusCode)
          .sort(),
      ).toEqual([404, 410]);
    });

    test("over the limit: names the limit and says to raise internal_links.max_targets", async () => {
      const { checks, lines } = await audit(engine, 1);
      const skipped = checks.find((c) => c.status === "skipped")!;
      expect(skipped.details?.notFetched).toEqual({ overLimit: 2, skipped: 2 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        "(2 past the limit of 1 target; 2 skipped as outside the crawl scope, disallowed by robots.txt, or action or token links)",
      );
      expect(lines[0]).toContain(
        "Raise internal_links.max_targets, or run a Surface or Full audit",
      );
    });
  });
}
