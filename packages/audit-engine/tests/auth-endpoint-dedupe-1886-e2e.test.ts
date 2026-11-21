// squirrelscan#1886 end to end, through the real crawler, store, endpoint discovery pass and
// rule runner (never a hand-built candidate list): a current-user endpoint that a page calls
// from an inline <script> and that leaks the user row is requested ONCE per audit and reported
// ONCE, by security/auth-endpoint-disclosure. security/unauthenticated-api, which also
// probes it, reports it too, and the runner's post-site-pass dedupe keeps only the auth
// rule's finding (squirrelscan#2082). Also the release-gate e2e for auth-endpoint-disclosure (pub#1920):
// it finds the endpoint from real page code and flags it without echoing a value.

// oxlint-disable sonarjs/no-hardcoded-passwords -- the fixture is a fake leaked credential, which is what the rule detects

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

const BCRYPT = [
  "$2b$12$",
  "R9h/cIPz0gi.URNNX3kh2O",
  "PST9/PgBkqquzi.Ss7KIUgO2t0jWMUW",
].join("");
const USER = {
  id: 1001,
  email: "ada.hazel@example.com",
  name: "Ada Hazel",
  encrypted_password: BCRYPT,
  sign_in_count: 17,
  current_sign_in_ip: "203.0.113.9",
};
const VALUES = [BCRYPT, USER.email, USER.name, USER.current_sign_in_ip];

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = (n: number): string =>
  Array.from({ length: n }, (_, i) => `word${i % 40}`).join(" ");
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><title>${title} | Nut demo</title></head><body>` +
  `<nav><a href="/">Home</a> <a href="/account">Account</a></nav>` +
  `<main><h1>${title}</h1><p>${words(120)}</p>${body}</main></body></html>`;
const INLINE_CALL_SITE =
  '<script>window.__me = () => fetch("/api/me");</script>';

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
          return html(page("Home", ""));
        case "/account":
          return html(page("Account", INLINE_CALL_SITE));
        case "/api/me":
          return new Response(JSON.stringify(USER), {
            headers: { "content-type": "application/json" },
          });
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
  rules: {
    enable: [
      "security/unauthenticated-api",
      "security/auth-endpoint-disclosure",
    ],
  },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(
  engine: "v1" | "v2",
  fixture: Fixture
): Promise<Map<string, CheckResult[]>> {
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
  return new Map([...ran.ruleResultsMap].map(([id, r]) => [id, r.checks]));
}

const problems = (checks: CheckResult[] | undefined) =>
  (checks ?? []).filter((c) => c.status === "fail" || c.status === "warn");

describe("one request and one finding for a leaking /api/me (squirrelscan#1886)", () => {
  for (const engine of ["v1", "v2"] as const) {
    test(`both probe rules read one GET; auth-endpoint-disclosure reports it (${engine})`, async () => {
      const fixture = serve();
      const results = await audit(engine, fixture);

      expect(fixture.hits.filter((h) => h === "GET /api/me")).toHaveLength(1);

      const auth = problems(results.get("security/auth-endpoint-disclosure"));
      expect(auth).toHaveLength(1);
      expect(auth[0]?.details).toMatchObject({
        endpoint: `${fixture.origin}/api/me`,
      });
      // Found from the page's inline fetch() call site, not only from the conventional paths.
      expect(auth[0]?.items?.[0]?.meta).toMatchObject({
        source: "discovered",
        discoveredVia: "fetch",
      });

      const api = results.get("security/unauthenticated-api") ?? [];
      expect(problems(api)).toHaveLength(0);
      expect(api.find((c) => c.status === "pass")?.details).toMatchObject({
        reportedBy: "security/auth-endpoint-disclosure",
        reportedElsewhere: 1,
      });

      const serialized = JSON.stringify([...results]);
      for (const value of VALUES) expect(serialized).not.toContain(value);
    }, 30_000);
  }
});
