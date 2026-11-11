// #1769 end to end: the server HTML of a page holds an external script and an inline script that client code
// removes after hydration, so the rendered DOM lacks them. Through the real crawler, the real conditional-render
// gate, the real asset phase and both rule paths (v1 and the streaming engine): the audit reads the union of
// both, so security/leaked-secrets reports the secrets, the external script is fetched, and the page set is the
// same for a fast and a slow render.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";
import {
  createConditionalRenderDocumentFetcher,
  createFetchDocumentFetcher,
  type DocumentFetcher,
} from "@squirrelscan/fetchers";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

// Secret-shaped values built from parts.
const EXTERNAL_KEY = "AKIA" + "QWERTYUIOP234567"; // pragma: allowlist secret
const INLINE_KEY = "AKIA" + "ZXCVBNMASD234567"; // pragma: allowlist secret

let requested: string[] = [];

function serveSite(): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      requested.push(pathname);
      if (pathname === "/_fault/shop-config.js") {
        return new Response(`window.SHOP = { awsKey: "${EXTERNAL_KEY}" };\n`, {
          headers: { "content-type": "text/javascript" },
        });
      }
      if (pathname === "/") {
        return new Response(
          `<!doctype html><html lang="en"><head><title>Product</title>` +
            `<script src="/_fault/shop-config.js"></script>` +
            `<script>window.__cfg = { awsKey: "${INLINE_KEY}" };</script>` +
            `</head><body><h1>Product</h1></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

/** A render that hydrated: the DOM comes back without the head scripts. `delayMs` is a slow render. */
function hydratedRender(http: DocumentFetcher, delayMs: number, keepScripts: boolean): DocumentFetcher {
  return {
    id: "cloud-render",
    capabilities: { jsRendering: true, cookies: false, screenshot: false },
    async fetch(req) {
      const res = await http.fetch(req);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const body = keepScripts ? res.body : res.body.replace(/<script[\s\S]*?<\/script>/g, "");
      return { ...res, body, fetcherMethod: "cloud-render" };
    },
  };
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["security/leaked-secrets"] },
  crawler: { max_pages: 5, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(engine: "v1" | "v2", delayMs: number) {
  const origin = serveSite();
  const http = createFetchDocumentFetcher();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 5,
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
        documentFetcher: createConditionalRenderDocumentFetcher({
          http,
          render: hydratedRender(http, delayMs, false),
        }),
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage as SQLiteStorage;
  const stored = await Effect.runPromise(storage.getPages(crawlId));
  const checks = await Effect.runPromise(
    Effect.gen(function* () {
      const preRules = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(stored);
        const ran = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, preRules.assets);
        return ran.siteRuleResults.get("security/leaked-secrets") ?? [];
      }
      const ran = yield* runStreamingRules(storage, crawlId, CONFIG, preRules.assets);
      return ran.siteRuleResults.get("security/leaked-secrets") ?? [];
    }) as Effect.Effect<CheckResult[], never, never>,
  );
  return { origin, html: stored[0]?.html ?? "", checks, requested: [...requested] };
}

describe("server-sent scripts that client code removed are still audited (#1769)", () => {
  for (const engine of ["v1", "v2"] as const) {
    for (const [label, delayMs] of [["fast", 0], ["slow", 300]] as const) {
      test(`${engine}, ${label} render: both scripts are read and the secrets name the page`, async () => {
        const run = await audit(engine, delayMs);
        // The stored page holds the union, the server-only scripts marked.
        expect(run.html).toContain('src="/_fault/shop-config.js"');
        expect(run.html).toContain("data-sq-server-only");
        // The external script was fetched.
        expect(run.requested).toContain("/_fault/shop-config.js");
        // Both secrets are reported, and the finding names the page.
        const text = JSON.stringify(run.checks);
        expect(text).toContain(`${run.origin}/`);
        const found = run.checks.find((c) => c.name.startsWith("leaked-secrets-"));
        expect(found?.items?.length).toBe(2);
        expect(found?.items?.every((i) => i.sourcePages?.includes(`${run.origin}/`))).toBe(true);
        expect(text).toContain("inline-script");
        expect(text).toContain("external-script");
      }, 30_000);
    }
  }
});
