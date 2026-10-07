// End-to-end: a site that refuses EVERY fetch must produce a report that
// says it was refused, not one asserting that robots.txt, sitemaps, llms.txt and
// Markdown are absent.
//
// Drives the real crawler against a real origin that answers 403 to everything
// (a Cloudflare-style bot wall), then the real rules and BOTH report assembly
// paths (v1 and the streaming v2), because the two are built by separate code.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  generateReportFromStorage,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";
import { buildV2Report } from "../src/report-stream";

// `filterRules` defaults every rule to disabled, so the enable list is mandatory.
const RULES = ["crawl/sitemap-exists", "crawl/robots-txt", "ax/llms-txt", "ax/markdown-response"];
const CONFIG = { rule_options: {}, rules: { enable: RULES } } as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serveAll(status: number, headers: Record<string, string>): string {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("<html><title>Just a moment...</title></html>", { status, headers }),
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

type Engine = "v1" | "v2";

/** The slice of the report these tests read; both assembly paths produce it. */
interface ReportShape {
  status?: string;
  totalPages: number;
  healthScore?: { overall: number | null; categories: unknown[]; groups?: unknown[] };
  ruleResults: Record<string, { checks: CheckResult[] }>;
  refusedFetches?: Array<{ resource: string; status: number; provider?: string }>;
}

async function auditWall(engine: Engine, status: number, headers: Record<string, string>) {
  const origin = serveAll(status, headers);
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 3,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;

  return Effect.runPromise(
    Effect.gen(function* () {
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        const ran = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);
        return yield* generateReportFromStorage(storage, crawlId, ran);
      }
      const ran = yield* runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS);
      return yield* buildV2Report(storage, crawlId, ran);
    }) as Effect.Effect<unknown, never, never>,
  ) as Promise<ReportShape>;
}

const findings = (checks: CheckResult[]) => checks.filter((c) => c.status === "fail" || c.status === "warn");

for (const engine of ["v1", "v2"] as const) {
  describe(`a site that refuses every fetch (${engine} report)`, () => {
    test("the audit is blocked with no pages, and says which fetches were refused and by whom", async () => {
      const report = await auditWall(engine, 403, { server: "cloudflare", "cf-mitigated": "challenge" });

      expect(report.status).toBe("blocked");
      expect(report.totalPages).toBe(0);

      const refused = report.refusedFetches ?? [];
      const resources = new Set(refused.map((r) => r.resource));
      for (const resource of ["robots.txt", "sitemap", "llms.txt", "markdown"]) {
        expect(resources.has(resource)).toBe(true);
      }
      expect(refused.every((r) => r.status === 403 && r.provider === "Cloudflare")).toBe(true);
    });

    test("no rule reports an absence it could not have observed", async () => {
      const report = await auditWall(engine, 403, { server: "cloudflare", "cf-mitigated": "challenge" });

      const reported = Object.entries(report.ruleResults).flatMap(([id, r]) =>
        findings(r.checks).map((c) => `${id}: ${c.message}`),
      );
      expect(reported).toEqual([]);
    });

    test("no category or group is scored off findings it could not have observed", async () => {
      const report = await auditWall(engine, 403, { server: "cloudflare", "cf-mitigated": "challenge" });

      expect(report.healthScore?.overall).toBeNull();
      expect(report.healthScore?.categories).toEqual([]);
      expect(report.healthScore?.groups ?? []).toEqual([]);
    });
  });
}

describe("a site that is down (500 on every path)", () => {
  test("is failed with no absence findings and no scores", async () => {
    const report = await auditWall("v1", 500, {});

    expect(report.status).toBe("failed");
    const reported = Object.values(report.ruleResults).flatMap((r) => findings(r.checks));
    expect(reported).toEqual([]);
    expect(report.healthScore?.categories).toEqual([]);
  });
});
