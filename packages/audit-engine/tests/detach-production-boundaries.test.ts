// #1860: the detach call sites must actually detach, on the shapes production
// produces — not just on handcrafted objects.
//
// `detachFromPage` falls back to returning the ORIGINAL when a value cannot be
// structured-cloned, and that fallback is invisible: the findings are unchanged,
// so every golden test stays green while the page-sized retention comes back.
// A handcrafted-input test cannot see it either, because the shapes that would
// throw come from the rule runner, not from the test.
//
// So this asserts against a real crawl driven through the real rule set:
//   1. a real `runPageRules` graph clones with no fallback;
//   2. both production boundaries actually ran (a removed call site fails here,
//      where an equality-only test would still pass).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { createRunner, type SiteData } from "@squirrelscan/rules";

import {
  buildSiteContext,
  buildHeadersMap,
  isRenderedFetch,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";
import { detachCounts, detachFromPage, resetDetachCounts } from "../src/detach";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

// The whole rule set, as the golden tests run it (filterRules defaults every
// rule to disabled, so `enable: ["*"]` is what makes this a real graph).
const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const EMPTY_SITE_DATA = {
  baseUrl: "http://synthetic.test",
  pages: [],
  robotsTxt: null,
  sitemaps: null,
} as unknown as SiteData;

async function fixture(seed: number, pageCount: number) {
  const model = generateSiteModel({ seed, pageCount });
  return writeCrawlToStorage(model, ":memory:");
}

describe("detach at the production boundaries", () => {
  test("a real rule-runner graph clones with no fallback", async () => {
    const { storage, crawlId } = await fixture(3, 6);
    const pages = await run(storage.getPages(crawlId));
    const ctx = await run(buildSiteContext(pages));
    const runner = createRunner(CONFIG);

    resetDetachCounts();
    let cloned = 0;

    for (const { page, parsed } of ctx) {
      if (!parsed || !page.html) continue;
      const raw = await runner.runPageRules(
        {
          url: page.url,
          html: page.html,
          statusCode: page.status,
          loadTime: page.loadTimeMs,
          ttfb: page.ttfb,
          downloadTime: page.downloadTime,
          headers: buildHeadersMap(page),
          parsed,
          finalUrl: page.finalUrl,
          redirectChain: page.redirectChain,
          rendered: isRenderedFetch(page.fetcherId),
        } as never,
        EMPTY_SITE_DATA,
      );

      // Exactly the graph streaming.ts detaches: the flat checks plus each
      // rule's checks, in ONE call, so the sharing between them is preserved.
      const byRule = [...raw.ruleResults];
      const source = { checks: raw.checks, ruleChecks: byRule.map(([, rr]) => rr.checks) };
      const copy = detachFromPage(source, "page-rules");

      // A copy, and an equal one. `toEqual` over the real graph is the check
      // that no rule emits a shape structuredClone alters.
      expect(copy).not.toBe(source);
      expect(copy).toEqual(source);
      expect(copy.ruleChecks.length).toBe(source.ruleChecks.length);
      cloned++;
    }

    expect(cloned).toBeGreaterThan(0);
    // The point of the test: the real graph took the clone path every time.
    expect(detachCounts("page-rules")).toEqual({ detached: cloned, fallbacks: 0 });

    await run(storage.close());
  }, 120_000);

  test("runStreamingRules detaches at BOTH boundaries, with no fallback", async () => {
    const { storage, crawlId } = await fixture(5, 8);

    resetDetachCounts();
    const streamed = await run(
      runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, { batchSize: 3 }),
    );
    expect(streamed.ruleResultsMap.size).toBeGreaterThan(0);

    const pageRules = detachCounts("page-rules");
    const signals = detachCounts("collected-signal");

    // Removing either call site zeroes its counter — an equality-only test would
    // not notice, because the findings are identical either way.
    expect(pageRules.detached).toBeGreaterThan(0);
    expect(signals.detached).toBeGreaterThan(0);
    // And no page silently kept its attachment.
    expect(pageRules.fallbacks).toBe(0);
    expect(signals.fallbacks).toBe(0);

    await run(storage.close());
  }, 120_000);
});
