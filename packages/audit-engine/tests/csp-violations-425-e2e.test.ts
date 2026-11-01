// #425 end to end: a stored page fetched by a browser render, with the browser events the renderer reported,
// reaches security/csp-violations through the real store and streaming rule path (both engines); the same
// page fetched without a browser is skipped with its reason.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "@squirrelscan/config";
import type { BrowserEvents, CheckResult } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";
import type { CrawlMetadata, PageRecord } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);

const CONFIG = {
  rule_options: {},
  rules: { enable: ["security/csp-violations"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

const STATS = { pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0 };

const EVENTS: BrowserEvents = {
  cspViolations: [
    { violatedDirective: "script-src-elem", blockedUri: "https://www.googletagmanager.com/gtm.js", disposition: "enforce" },
    { violatedDirective: "img-src", blockedUri: "https://pixel.test/p.gif", disposition: "report" },
  ],
  failedRequests: [],
  listenedAfterLoad: true,
};

const ORIGIN = "https://clinic.test";
const HTML = `<!doctype html><html lang="en"><head><title>Book a visit</title></head><body><h1>Book</h1></body></html>`;

function page(path: string, extra: Partial<PageRecord>): PageRecord {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: HTML.length,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h-${path}`,
    html: HTML,
    parsedData: null,
    headers: {} as PageRecord["headers"],
    securityHeaders: {} as PageRecord["securityHeaders"],
    ...extra,
  } as PageRecord;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-csp-e2e-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function audit(engine: "v1" | "v2"): Promise<Map<string, CheckResult>> {
  const storage = new SQLiteStorage(join(dir, "project.db"));
  await run(storage.init());
  const crawlId = await run(
    storage.createCrawl({ baseUrl: ORIGIN, startedAt: 1, status: "analyzed", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">),
  );
  await run(storage.upsertPage(crawlId, page("/rendered", { fetcherId: "cloud-render", browserEvents: EVENTS })));
  await run(storage.upsertPage(crawlId, page("/rendered-quiet", { fetcherId: "cloud-render" })));
  await run(storage.upsertPage(crawlId, page("/plain", {})));
  const stored = await run(storage.getPages(crawlId));
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, pre.assets);
      }
      return yield* runStreamingRules(storage, crawlId, CONFIG, pre.assets);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  storage.close?.();
  const byPath = new Map<string, CheckResult>();
  for (const check of ran.ruleResultsMap.get("security/csp-violations")?.checks ?? []) {
    byPath.set(new URL(check.pageUrl ?? ORIGIN).pathname, check);
  }
  return byPath;
}

for (const engine of ["v1", "v2"] as const) {
  describe(`security/csp-violations through the stored page (#425, ${engine})`, () => {
    test("a rendered page with events fails on the blocked vendor, report-only is only counted", async () => {
      const checks = await audit(engine);
      const rendered = checks.get("/rendered");
      expect(rendered?.status).toBe("fail");
      expect(JSON.stringify(rendered)).toContain("googletagmanager.com");
      expect(JSON.stringify(rendered)).not.toContain("pixel.test");
      expect((rendered?.details as { reportOnly?: number } | undefined)?.reportOnly).toBe(1);
    });

    test("a rendered page the renderer reported nothing for, and a page fetched without a browser, are skipped with their reasons", async () => {
      const checks = await audit(engine);
      expect(checks.get("/rendered-quiet")?.status).toBe("skipped");
      expect(String(checks.get("/rendered-quiet")?.message)).not.toContain("without a browser");
      expect(checks.get("/plain")?.status).toBe("skipped");
      expect(String(checks.get("/plain")?.message)).toContain("without a browser");
    });
  });
}
