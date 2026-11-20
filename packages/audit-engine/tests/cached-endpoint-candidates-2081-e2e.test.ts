// squirrelscan#2081 end to end: an incremental re-audit in which every page is a cache hit
// must hand the probe rules the same endpoint candidates as a `--refresh` run of the same
// unchanged site. The call sites live in an inline <script> on /about, so a replayed page
// that fed no candidates would leave security/unauthenticated-api and
// security/json-sensitive-fields skipped with `no-endpoints`.
//
// Three audits of one unchanged site against one store, the way the CLI runs them:
//  1. cold: an incremental crawl and the rule cache on, nothing cached yet;
//  2. warm: every page is a crawl cache hit (hash_match) and every page replays from the
//     rule cache, so no page is parsed and no page-time collector runs;
//  3. refresh: a full crawl and no rule cache, which is what `--refresh` does.
// The endpoint surface each audit hands the site rules is read off the runner itself, so
// the comparison is of the real candidates, not of a hand-built list.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage, type ContentStoreAdapter } from "@squirrelscan/crawler";
import { createProbeBudget, RuleRunner, type EndpointSurface } from "@squirrelscan/rules";

import { runStreamingRules } from "../src/adapter";
import type { RuleCacheStats, RuleCacheStore } from "../src/rule-cache";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

// The endpoint surface of every site pass, in call order. A pass-through spy: the real
// runSiteRules runs; only its arguments are recorded.
let siteRulesSpy: ReturnType<typeof spyOn<RuleRunner, "runSiteRules">>;
beforeAll(() => {
  siteRulesSpy = spyOn(RuleRunner.prototype, "runSiteRules");
});
afterAll(() => {
  siteRulesSpy.mockRestore();
});

const PROBE_RULES = ["security/unauthenticated-api", "security/json-sensitive-fields"] as const;

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(" ");
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><title>${title} | Nut demo</title></head><body>` +
  `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/faq">FAQ</a></nav>` +
  `<main><h1>${title}</h1><p>${words(120)}</p>${body}</main></body></html>`;
const INLINE_CALL_SITES =
  '<script>window.__shopApi = { load: () => Promise.all([fetch("/api/users"), fetch("/api/account")]) };</script>';
const HTML_PATHS = ["/", "/about", "/faq"];

const USERS = [
  { id: 1001, email: "ada.hazel@example.com", phone: "+61 400 000 100" },
  { id: 1002, email: "ben.walnut@example.com", phone: "+61 400 000 101" },
];
const ACCOUNT = { id: 1001, username: "ada.hazel", password: "not-a-real-password-2081" };

function serve(): { origin: string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(`${req.method} ${pathname}`);
      const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
      switch (pathname) {
        case "/":
          return html(page("Home", ""));
        case "/about":
          return html(page("About", INLINE_CALL_SITES));
        case "/faq":
          return html(page("FAQ", ""));
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
  rules: { enable: [...PROBE_RULES] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

/**
 * A content store, as the CLI has: without one no page carries an exact HTML hash and
 * nothing is ever rule-cached, so the warm audit would vacuously run every page fresh.
 */
function memoryContentStore(): ContentStoreAdapter {
  const blobs = new Map<string, string>();
  return {
    put(content) {
      const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      blobs.set(hash, content);
      return hash;
    },
    getString(hash) {
      return blobs.get(hash) ?? null;
    },
  };
}

/** An in-memory rule cache store that persists across audits, like the CLI's project.db. */
function memoryRuleCacheStore(): RuleCacheStore {
  const rows = new Map<string, string>();
  return {
    async load(keys) {
      const out = new Map<string, string>();
      for (const key of keys) {
        const value = rows.get(key);
        if (value !== undefined) out.set(key, value);
      }
      return out;
    },
    putFresh(key, _url, payload) {
      rows.set(key, payload);
    },
    carryForward() {},
  };
}

interface Audit {
  surface: EndpointSurface;
  results: Map<string, CheckResult[]>;
  ruleCache: RuleCacheStats;
  pageCacheHits: number;
  pages: number;
}

async function audit(
  storage: SQLiteStorage,
  origin: string,
  opts: { incremental: boolean; ruleCache?: RuleCacheStore },
): Promise<Audit> {
  const crawler = await Effect.runPromise(
    createCrawler({
      storage,
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: opts.incremental,
        useCacheControl: false,
      } as never,
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const scope = { probe: createProbeBudget({ level: "aggressive", budgetMs: 20_000 }) };
  const callsBefore = siteRulesSpy.mock.calls.length;
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, config, {});
      return yield* runStreamingRules(
        storage,
        crawlId,
        config,
        pre.assets,
        scope,
        opts.ruleCache
          ? { ruleCache: { store: opts.ruleCache, engineVersion: "test-2081", rulesVersion: "rules-2081" } }
          : undefined,
      );
    }) as Effect.Effect<
      { ruleResultsMap: Map<string, { checks: CheckResult[] }>; ruleCache: RuleCacheStats },
      never,
      never
    >,
  );
  const calls = siteRulesSpy.mock.calls.slice(callsBefore);
  expect(calls).toHaveLength(1);
  const surface = calls[0]![3];
  if (!surface) throw new Error("the site pass ran without an endpoint surface");
  const stats = await Effect.runPromise(storage.getStats(crawlId));
  const pages = await Effect.runPromise(storage.getPages(crawlId));
  return {
    surface,
    results: new Map([...ran.ruleResultsMap].map(([id, r]) => [id, r.checks])),
    ruleCache: ran.ruleCache,
    pageCacheHits: stats?.cacheHitsByReason?.hash_match ?? 0,
    pages: pages.length,
  };
}

/** A probe rule's checks with everything that identifies the run stripped. */
function verdicts(a: Audit, ruleId: string) {
  return (a.results.get(ruleId) ?? []).map((c) => ({
    name: c.name,
    status: c.status,
    skipReason: c.skipReason,
    message: c.message,
    items: (c.items ?? []).map((i) => i.id).sort(),
  }));
}

describe("an all-cached re-audit feeds the probe rules the same endpoints as a refresh (#2081)", () => {
  test("cold, warm (every page a cache hit) and refresh audits give the same candidates and findings", async () => {
    const { origin, hits } = serve();
    const storage = new SQLiteStorage(":memory:", memoryContentStore());
    await Effect.runPromise(storage.init());
    const ruleCache = memoryRuleCacheStore();

    const cold = await audit(storage, origin, { incremental: true, ruleCache });
    expect(cold.pages).toBe(HTML_PATHS.length);
    expect(cold.ruleCache.freshPages).toBe(HTML_PATHS.length);
    expect(cold.ruleCache.storedEntries).toBe(HTML_PATHS.length);

    const hitsBeforeWarm = hits.length;
    const warm = await audit(storage, origin, { incremental: true, ruleCache });
    // The precondition the issue describes: every page is a crawl cache hit and every page
    // replays from the rule cache, so no page-time collector ran on any of them.
    expect(warm.pageCacheHits).toBe(warm.pages);
    expect(warm.pages).toBe(HTML_PATHS.length);
    expect(warm.ruleCache.freshPages).toBe(0);
    expect(warm.ruleCache.replayedPages).toBe(HTML_PATHS.length);
    // ...and the probe rules still sent their requests on that run.
    const warmHits = hits.slice(hitsBeforeWarm);
    expect(warmHits).toContain("GET /api/users");
    expect(warmHits).toContain("GET /api/account");

    const refresh = await audit(storage, origin, { incremental: false });
    expect(refresh.pageCacheHits).toBe(0);
    expect(refresh.ruleCache.replayedPages).toBe(0);

    // The inline call sites are on the surface of the refresh run...
    for (const path of ["/api/users", "/api/account"]) {
      expect(refresh.surface.candidates).toContainEqual(
        expect.objectContaining({
          url: `${origin}${path}`,
          discoveredVia: "fetch",
          sameOrigin: true,
          probeEligible: true,
        }),
      );
    }
    // ...and the all-cached run, and the cold one, hand the site rules exactly that surface.
    expect(warm.surface).toEqual(refresh.surface);
    expect(cold.surface).toEqual(refresh.surface);

    for (const ruleId of PROBE_RULES) {
      const warmVerdicts = verdicts(warm, ruleId);
      expect(warmVerdicts.length).toBeGreaterThan(0);
      expect(warmVerdicts.filter((v) => v.skipReason === "no-endpoints")).toEqual([]);
      expect(warmVerdicts).toEqual(verdicts(refresh, ruleId));
      expect(warmVerdicts).toEqual(verdicts(cold, ruleId));
    }
    // Both endpoints are flagged on the all-cached run, not merely "not skipped".
    const sensitive = (warm.results.get("security/unauthenticated-api") ?? []).find(
      (c) => c.name === "unauthenticated-api-sensitive",
    );
    expect(sensitive?.status).toBe("fail");
    expect((sensitive?.items ?? []).map((i) => i.id).sort()).toEqual([
      `${origin}/api/account`,
      `${origin}/api/users`,
    ]);
    const credential = (warm.results.get("security/json-sensitive-fields") ?? []).find(
      (c) => c.name === "json-sensitive-fields",
    );
    expect(credential?.status).toBe("fail");
  }, 30_000);
});
