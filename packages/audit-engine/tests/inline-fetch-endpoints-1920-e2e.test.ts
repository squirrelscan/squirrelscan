// #1920 end to end: an open JSON API that a page calls only from an inline <script> is found
// on a plain (non-rendered) crawl and reported by the probe rules, through the real crawler,
// store, endpoint discovery pass and rule runner, never a hand-built candidate list.
//
// The fixture mirrors the demo store's probe faults: /about carries
// `window.__shopApi = { load: () => Promise.all([fetch("/api/users"), fetch("/api/account")]) }`,
// /api/users answers a `{ users: [...] }` list with emails and phones, and /api/account answers
// one record with a `password` field. No response value may appear in any finding, detail or log.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";
import { createProbeBudget, type EndpointSurface } from "@squirrelscan/rules";

import {
  buildHeadersMap,
  buildSiteContext,
  isRenderedFetch,
  parseHtmlForRules,
  runRulesOnStorage,
  runStreamingRules,
  setAdapterLogger,
  type AdapterLogger,
} from "../src/adapter";
import { logger as initialAdapterLogger } from "../src/adapter-logger";
import { createEndpointCollector } from "../src/endpoint-discovery";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

// Every value the two endpoints return that must never be echoed. Field names may be.
const PASSWORD = ["hazel", "nut-", "Wq7Ry2", "Zt5Kb9"].join("");
const PEOPLE = [
  "Ada Hazel",
  "Ben Walnut",
  "Cara Pecan",
  "Dev Almond",
  "Eli Cashew",
  "Fay Pistachio",
];
const USERS = PEOPLE.map((name, i) => ({
  id: 1001 + i,
  name,
  email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
  phone: `+61 400 000 ${100 + i}`,
  role: i === 0 ? "admin" : "customer",
}));
const ACCOUNT = {
  id: 1001,
  username: "ada.hazel",
  email: "ada.hazel@example.com",
  password: PASSWORD,
  plan: "demo",
};
const SECRET_VALUES = [PASSWORD, ...USERS.flatMap((u) => [u.name, u.email, u.phone])];

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

// Everything the engine and the rules log during the run, to check no value leaks there.
const logged: string[] = [];
const record = (...args: unknown[]): void => {
  logged.push(
    args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" "),
  );
};
const capturingLogger: AdapterLogger = {
  trace: record,
  error: record,
  warn: record,
  traceStart: (name) => name,
  traceEnd: (span, meta) => record(span, meta),
  withTrace: (name, fn, meta) => {
    record(name, meta?.());
    return fn();
  },
};
const consoleSpies: Array<{ mockRestore: () => void }> = [];
beforeAll(() => {
  setAdapterLogger(capturingLogger);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(spyOn(console, level).mockImplementation(record));
  }
});
afterAll(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  setAdapterLogger(initialAdapterLogger);
});

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(" ");
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><title>${title} | Nut demo</title></head><body>` +
  `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/faq">FAQ</a></nav>` +
  `<main><h1>${title}</h1><p>${words(120)}</p>${body}</main></body></html>`;
const INLINE_CALL_SITES =
  '<script>window.__shopApi = { load: () => Promise.all([fetch("/api/users"), fetch("/api/account")]) };</script>';

interface Fixture {
  origin: string;
  /** `METHOD path` of every request the site received. */
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
        new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      switch (pathname) {
        case "/":
          return html(page("Home", ""));
        case "/faq":
          return html(page("FAQ", ""));
        case "/about":
          return html(page("About", INLINE_CALL_SITES));
        case "/api/users":
          return json({ users: USERS });
        case "/api/account":
          return json(ACCOUNT);
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
  rules: { enable: ["security/unauthenticated-api", "security/json-sensitive-fields"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

/** A plain HTTP crawl of the fixture: no renderer is configured. */
async function crawl(fixture: Fixture) {
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
    }),
  );
  const crawlId = await Effect.runPromise(
    crawler.start(`${fixture.origin}/`, `${fixture.origin}/`),
  );
  const storage = crawler.storage as SQLiteStorage;
  const pages = await Effect.runPromise(storage.getPages(crawlId));
  return { crawlId, storage, pages };
}

async function audit(engine: "v1" | "v2", fixture: Fixture): Promise<Map<string, CheckResult[]>> {
  const { crawlId, storage, pages } = await crawl(fixture);
  const scope = { probe: createProbeBudget({ level: "aggressive", budgetMs: 20_000 }) };
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, config, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(pages);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, pre.assets, scope);
      }
      return yield* runStreamingRules(storage, crawlId, config, pre.assets, scope);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  return new Map([...ran.ruleResultsMap].map(([id, r]) => [id, r.checks]));
}

function expectNoValues(text: string): void {
  for (const value of SECRET_VALUES) expect(text).not.toContain(value);
}

describe("an open JSON API called only from an inline script is found and probed (#1920)", () => {
  test("a plain crawl turns the inline fetch() call sites into same-origin, probe-eligible candidates", async () => {
    const fixture = serve();
    const { pages } = await crawl(fixture);
    const about = pages.find((p) => new URL(p.url).pathname === "/about");
    expect(about).toBeDefined();
    // Plain HTTP: nothing rendered the page, so the call sites came from the served HTML.
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.filter((p) => isRenderedFetch(p.fetcherId))).toEqual([]);

    const collector = createEndpointCollector({
      headersOf: buildHeadersMap,
      entryUrl: `${fixture.origin}/`,
    });
    for (const p of pages) {
      if (!p.html) continue;
      collector.collect(p, parseHtmlForRules(p.html, p.finalUrl || p.url));
    }
    const surface: EndpointSurface = collector.finish({ baseUrl: fixture.origin, scripts: [] });
    for (const path of ["/api/users", "/api/account"]) {
      expect(surface.candidates).toContainEqual({
        url: `${fixture.origin}${path}`,
        method: "GET",
        source: "static-html",
        discoveredVia: "fetch",
        sameOrigin: true,
        probeEligible: true,
      });
    }
  }, 30_000);

  for (const engine of ["v1", "v2"] as const) {
    test(`crawl, endpoint surface and probe flag both endpoints without echoing a value (${engine})`, async () => {
      const fixture = serve();
      logged.length = 0;
      const results = await audit(engine, fixture);

      // Each endpoint got exactly the one anonymous GET per rule, nothing else.
      expect(fixture.hits.filter((h) => h === "GET /api/users")).toHaveLength(2);
      expect(fixture.hits.filter((h) => h === "GET /api/account")).toHaveLength(2);

      const api = results.get("security/unauthenticated-api") ?? [];
      const sensitive = api.find((c) => c.name === "unauthenticated-api-sensitive");
      expect(sensitive?.status).toBe("fail");
      const flagged = new Map(
        (sensitive?.items ?? []).map((i) => [i.id, i.meta as Record<string, unknown>]),
      );
      expect([...flagged.keys()].sort()).toEqual([
        `${fixture.origin}/api/account`,
        `${fixture.origin}/api/users`,
      ]);
      expect(flagged.get(`${fixture.origin}/api/users`)).toMatchObject({
        records: USERS.length,
        source: "static-html",
        discoveredVia: "fetch",
      });
      expect(flagged.get(`${fixture.origin}/api/users`)?.personal).toEqual(
        expect.arrayContaining(["email", "phone"]),
      );

      const json = results.get("security/json-sensitive-fields") ?? [];
      const credential = json.find((c) => c.name === "json-sensitive-fields");
      expect(credential?.status).toBe("fail");
      expect(credential?.details).toMatchObject({
        endpoint: `${fixture.origin}/api/account`,
        discoveredVia: "fetch",
        fields: 1,
      });
      expect(credential?.items?.map((i) => i.meta)).toEqual([
        expect.objectContaining({
          endpoint: `${fixture.origin}/api/account`,
          path: "$.password",
          records: 1,
        }),
      ]);
      // The user list is reported by counts of each kind of personal data, not by value.
      const bulk = json.find((c) => c.name === "json-bulk-pii");
      expect(bulk?.status).toBe("warn");
      expect(bulk?.message).toContain(`${USERS.length} distinct email address(es)`);
      expect(bulk?.message).toContain(`${USERS.length} distinct phone number(s)`);

      // The snippet names the field and the value's length, never the value.
      expect(credential?.items?.[0]?.snippet).toBe(
        `$.password = <redacted, ${PASSWORD.length} chars>`,
      );

      // No email, phone, name or password from either response anywhere in a finding,
      // its details or items, or in anything the engine or the rules logged.
      expectNoValues(JSON.stringify([...results]));
      expectNoValues(logged.join("\n"));
    }, 30_000);
  }
});
