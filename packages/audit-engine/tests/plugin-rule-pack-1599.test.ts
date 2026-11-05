// #1599: runStreamingRules takes an in-process plugin snapshot (rules + listeners)
// and runs the rules in the same pass as the built-in ones. No file is loaded:
// the snapshot is built by the caller, as an embedding host would.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";
import type { PluginRegistrySnapshot, Rule, RuleContext } from "@squirrelscan/rules";

import { runStreamingRules, type PreFetchedAssets } from "../src/adapter";

const BASE = "https://site.example.com";
const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

function pageRecord(path: string): PageRecord {
  const url = `${BASE}${path}`;
  const html = `<!doctype html><html lang="en"><head><title>Page ${path}</title></head><body><p>Body copy.</p></body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: path === "/" ? 0 : 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${path}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

function meta(id: string, scope: "page" | "site"): Rule["meta"] {
  return {
    id,
    name: id,
    description: "plugin rule",
    category: "content",
    scope,
    severity: "warning",
    weight: 1,
    ...(scope === "page" ? { verdictScope: "page" } : {}),
  } as Rule["meta"];
}

type Streamed =
  ReturnType<typeof runStreamingRules> extends Effect.Effect<infer A, never, never> ? A : never;

interface Seen {
  pageCloud: unknown[];
  siteCloud: unknown[];
  siteHtml: string[];
  siteDocument: boolean[];
}

function pack(seen: Seen): Rule[] {
  return [
    {
      meta: meta("acme/page-note", "page"),
      run: (ctx: RuleContext) => {
        seen.pageCloud.push(ctx.cloudResults);
        return {
          checks: [
            {
              name: "page-note",
              status: "warn",
              message: `note ${ctx.page.url}`,
              items: [{ id: "alpha" }, { id: "beta" }],
            },
          ],
        };
      },
    },
    {
      meta: meta("acme/site-note", "site"),
      run: (ctx: RuleContext) => {
        seen.siteCloud.push(ctx.cloudResults);
        seen.siteHtml.push(ctx.page.html);
        seen.siteDocument.push(Boolean((ctx.site?.pages[0]?.parsed as { document?: unknown } | undefined)?.document));
        return { checks: [{ name: "site-note", status: "warn", message: "site note" }] };
      },
    },
  ];
}

const newSeen = (): Seen => ({ pageCloud: [], siteCloud: [], siteHtml: [], siteDocument: [] });
const snapshot = (rules: Rule[], listeners = new Map()): PluginRegistrySnapshot => ({ rules, listeners });

async function audit(
  config: Config,
  opts: Parameters<typeof runStreamingRules>[5],
  scope?: Parameters<typeof runStreamingRules>[4],
) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {
          pagesTotal: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      } as never);
      for (const path of ["/", "/a"]) yield* storage.upsertPage(crawlId, pageRecord(path));
      return yield* runStreamingRules(storage, crawlId, config, EMPTY_ASSETS, scope, { batchSize: 1, ...opts });
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))) as Effect.Effect<Streamed, never, never>,
  );
}

const config = (extra: Record<string, unknown> = {}) =>
  ({ rule_options: {}, rules: { enable: ["core/h1", "acme/*"] }, ...extra }) as unknown as Config;

const pageChecks = (r: { pageResults: Map<string, CheckResult[]> }, name: string) =>
  [...r.pageResults.values()].flat().filter((c) => c.name === name);

describe("runStreamingRules with a plugin snapshot (#1599)", () => {
  test("page and site plugin rules run in the same pass and reach the results and tallies", async () => {
    const seen = newSeen();
    const r = await audit(config(), { plugins: snapshot(pack(seen)) });
    expect(pageChecks(r, "page-note").length).toBe(2);
    const siteChecks = (r.ruleResultsMap.get("acme/site-note")?.checks ?? []) as CheckResult[];
    expect(siteChecks.map((c) => c.name)).toEqual(["site-note"]);
    expect(r.tallies.has("acme/page-note")).toBe(true);
    expect(r.tallies.has("acme/site-note")).toBe(true);
    // A built-in rule ran in the same pass.
    expect(r.tallies.has("core/h1")).toBe(true);
  }, 60_000);

  test("plugin rules get the same cloudResults as built-in rules; site rules get no DOM", async () => {
    const seen = newSeen();
    const cloudResults = new Map([["probe-service", new Map()]]) as never;
    await audit(config(), { plugins: snapshot(pack(seen)) }, { cloudResults });
    expect(seen.pageCloud.length).toBe(2);
    for (const c of [...seen.pageCloud, ...seen.siteCloud]) expect(c).toBe(cloudResults);
    expect(seen.siteHtml).toEqual([""]);
    expect(seen.siteDocument).toEqual([false]);
  }, 60_000);

  test("[rules] disable of the plugin namespace and an [[ignore]] entry suppress plugin findings", async () => {
    const off = await audit(config({ rules: { enable: ["core/h1", "acme/*"], disable: ["acme/*"] } }), {
      plugins: snapshot(pack(newSeen())),
    });
    expect(pageChecks(off, "page-note").length).toBe(0);
    expect(off.tallies.has("acme/page-note")).toBe(false);

    // [[ignore]] waives items inside a check, the same way it does for a built-in rule.
    const ignored = await audit(
      config({ ignore: [{ rule: "acme/page-note", items: ["alpha", "beta"], reason: "accepted" }] }),
      { plugins: snapshot(pack(newSeen())) },
    );
    const notes = pageChecks(ignored, "page-note");
    expect(notes.length).toBe(2);
    expect(notes.every((c) => c.status === "pass")).toBe(true);
    const partial = await audit(config({ ignore: [{ rule: "acme/page-note", items: ["alpha"] }] }), {
      plugins: snapshot(pack(newSeen())),
    });
    expect(pageChecks(partial, "page-note").every((c) => c.status === "warn" && c.items?.length === 1)).toBe(true);
  }, 60_000);

  test("no plugins, an undefined snapshot and an empty one give byte-identical output", async () => {
    const cfg = config({ rules: { enable: ["core/*", "content/*"] } });
    const key = async (opts: Parameters<typeof runStreamingRules>[5]) => {
      const r = await audit(cfg, opts);
      return JSON.stringify([r.pageResults, r.ruleResultsMap, r.tallies, r.siteResults], (_k, v) =>
        v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v,
      );
    };
    const base = await key(undefined);
    expect(await key({ plugins: undefined })).toBe(base);
    expect(await key({ plugins: snapshot([]) })).toBe(base);
  }, 120_000);

  test("a rule clashing with a built-in id throws and runs nothing", async () => {
    const clash: Rule = { meta: meta("core/h1", "page"), run: () => ({ checks: [] }) };
    await expect(audit(config(), { plugins: snapshot([clash]) })).rejects.toThrow(/"core\/h1"/);
  }, 60_000);

  test("listeners hear the rules phase; a throwing listener does not fail the audit", async () => {
    const heard: string[] = [];
    const listeners = new Map([
      [
        "audit:rules-phase",
        [
          (_e: string, p: Record<string, unknown>) => {
            heard.push(`${String(p.phase)}:${String(p.boundary)}`);
          },
          () => {
            throw new Error("boom");
          },
        ],
      ],
    ]);
    const r = await audit(config(), { plugins: snapshot(pack(newSeen()), listeners) });
    expect(heard).toContain("page-rules:start");
    expect(heard).toContain("site-rules:end");
    expect(pageChecks(r, "page-note").length).toBe(2);
  }, 60_000);

  test("a run with plugin rules does not use the rule cache", async () => {
    const store = { get: () => null, put: () => {} } as never;
    const r = await audit(config(), {
      plugins: snapshot(pack(newSeen())),
      ruleCache: { store, engineVersion: "t", rulesVersion: "t" },
    });
    expect(r.ruleCache.disabledReason).toBe("plugin-rules");
  }, 60_000);
});
