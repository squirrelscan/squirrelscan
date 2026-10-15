// pub#807: `squirrel audit --offline` promises no request to a host outside the
// audited site. The asset phase still status-checked the third-party scripts,
// stylesheets and fonts the pages load (reliability/broken-resources, #703):
// that probe was gated only on the rule. An own-site-only run now skips it, so
// the rule reads third-party resources as not measured, never as passing.
//
// The third-party references are on `.invalid`, which a public site's audit
// refuses on the URL alone, so the control can see the probe run without any
// request leaving the machine.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { reliability } from "@squirrelscan/rules";

import { buildSiteContext, fetchResourceAssets } from "../src/adapter";

const BASE = "https://site.example.com";

const CONFIG = {
  rule_options: {},
  rules: { enable: ["reliability/broken-resources"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

const HOME = `<!doctype html><html lang="en"><head><title>Home</title>
  <link rel="stylesheet" href="https://cdn.invalid/site.css">
  <script src="https://widgets.invalid/w.js"></script>
</head><body><p>Home</p></body></html>`;

function homePage(): PageRecord {
  const url = `${BASE}/`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: HOME.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "hash-home",
    html: HOME,
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

function assets(ownSiteOnly: boolean) {
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
        stats: {} as never,
      } as never);
      yield* storage.upsertPage(crawlId, homePage());
      const siteContext = yield* buildSiteContext(yield* storage.getPages(crawlId));
      return yield* fetchResourceAssets(
        storage,
        crawlId,
        siteContext,
        CONFIG,
        ownSiteOnly ? { ownSiteOnly: true } : undefined,
      );
    }).pipe(Effect.orDie, Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

describe("an own-site-only (--offline) audit and third-party assets (pub#807)", () => {
  test("control: a normal audit status-checks the third-party references", async () => {
    const result = await assets(false);
    const urls = [
      ...(result.externalAssets?.css ?? []),
      ...(result.externalAssets?.scripts ?? []),
    ].map((a) => a.url);
    expect(urls.sort()).toEqual(["https://cdn.invalid/site.css", "https://widgets.invalid/w.js"]);
  });

  test("an own-site-only audit checks none, and the rule says they were not measured", async () => {
    const result = await assets(true);
    expect(result.externalAssets).toBeUndefined();

    const { checks } = reliability.brokenResourcesRule.run({
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {},
      site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, ...result },
      options: {},
    } as never) as { checks: Array<{ name: string; status: string; message: string }> };
    const unchecked = checks.find((c) => c.name === "unchecked-resources");
    expect(unchecked?.message).toContain("third-party resources were not measured this audit");
    expect(checks.some((c) => c.name === "broken-resources" && c.status === "fail")).toBe(false);
  });
});
