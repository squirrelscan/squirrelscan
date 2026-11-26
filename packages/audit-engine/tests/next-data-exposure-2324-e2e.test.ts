// squirrelscan#2324 end to end, through the real crawler, store and rule runner: a
// server-rendered Next.js page whose /_next/data file hands out a password hash is
// requested once and reported by security/next-data-exposure. The streaming engine
// detaches every DOM before the site pass, so this guards the page-time read of
// `__NEXT_DATA__` into the collected signals: without it the rule sees no Next.js
// page and sends nothing.

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";

import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";
import { createProbeBudget } from "@squirrelscan/rules";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
} from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const RULE_ID = "security/next-data-exposure";
const BUILD_ID = "e2eBuild_2324";
const DATA_PATH = `/_next/data/${BUILD_ID}/account.json`;
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = (n: number): string =>
  Array.from({ length: n }, (_, i) => `word${i % 40}`).join(" ");
const page = (title: string, path: string, gssp: boolean): string => {
  const nextData = JSON.stringify({
    props: { pageProps: { title } },
    page: path,
    buildId: BUILD_ID,
    ...(gssp ? { gssp: true } : { nextExport: true }),
  });
  return (
    `<!doctype html><html lang="en"><head><title>${title} | Nut demo</title></head><body>` +
    `<div id="__next"><nav><a href="/">Home</a> <a href="/account">Account</a></nav>` +
    `<main><h1>${title}</h1><p>${words(120)}</p></main></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`
  );
};

interface Fixture {
  origin: string;
  hits: string[];
}

function serve(): Fixture {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(`${req.method} ${pathname}`);
      const html = (body: string) =>
        new Response(body, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      switch (pathname) {
        case "/":
          // Auto-exported: no data file exists, so none may be requested.
          return html(page("Home", "/", false));
        case "/account":
          return html(page("Account", "/account", true));
        case DATA_PATH:
          return new Response(
            JSON.stringify({
              pageProps: {
                title: "Account",
                user: { name: "Ann", passwordHash: BCRYPT },
              },
              __N_SSP: true,
            }),
            { headers: { "content-type": "application/json" } }
          );
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits };
}

const config = {
  rule_options: {},
  rules: { enable: [RULE_ID] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(
  engine: "v1" | "v2",
  fixture: Fixture
): Promise<CheckResult[]> {
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
      } as never,
    })
  );
  const crawlId = await Effect.runPromise(
    crawler.start(`${fixture.origin}/`, `${fixture.origin}/`)
  );
  const storage = crawler.storage as SQLiteStorage;
  const pages = await Effect.runPromise(storage.getPages(crawlId));
  const scope = {
    probe: createProbeBudget({ level: "active", budgetMs: 20_000 }),
  };
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, config, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(pages);
        return yield* runRulesOnStorage(
          storage,
          crawlId,
          siteContext,
          config,
          pre.assets,
          scope
        );
      }
      return yield* runStreamingRules(
        storage,
        crawlId,
        config,
        pre.assets,
        scope
      );
    }) as Effect.Effect<
      { ruleResultsMap: Map<string, { checks: CheckResult[] }> },
      never,
      never
    >
  );
  return ran.ruleResultsMap.get(RULE_ID)?.checks ?? [];
}

describe("security/next-data-exposure in a real audit (squirrelscan#2324)", () => {
  for (const engine of ["v1", "v2"] as const) {
    test(`requests the server-rendered page's data file and reports the hash (${engine})`, async () => {
      const fixture = serve();
      const checks = await audit(engine, fixture);

      expect(fixture.hits.filter((h) => h === `GET ${DATA_PATH}`)).toHaveLength(
        1
      );
      // The auto-exported home page has no data file and is never requested.
      expect(
        fixture.hits.filter((h) => h.startsWith("GET /_next/data/"))
      ).toHaveLength(1);

      const fail = checks.find((c) => c.status === "fail");
      expect(fail?.name).toBe("next-data-sensitive-fields");
      expect(fail?.details).toMatchObject({
        endpoint: `${fixture.origin}${DATA_PATH}`,
        page: `${fixture.origin}/account`,
      });
      expect(
        fail?.items?.some((i) => i.meta?.path === "pageProps.user.passwordHash")
      ).toBe(true);
      expect(JSON.stringify(checks)).not.toContain(BCRYPT);
    }, 30_000);
  }
});
