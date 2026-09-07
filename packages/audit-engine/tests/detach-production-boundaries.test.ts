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
import { SchemaCollection } from "@squirrelscan/parser";

import {
  absorbExternalLinkOccurrences,
  buildSiteContext,
  buildHeadersMap,
  isRenderedFetch,
  parseHtmlForRules,
  runStreamingRules,
  type ExternalLinkOccurrences,
  type PreFetchedAssets,
  type SiteContextPage,
} from "../src/adapter";
import { extractLinks } from "@squirrelscan/parser";
import { detachCounts, detachFromPage, detachParsedPage, resetDetachCounts } from "../src/detach";

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
    const universe = detachCounts("parsed-universe");

    // Removing any call site zeroes its counter — an equality-only test would
    // not notice, because the findings are identical either way.
    expect(pageRules.detached).toBeGreaterThan(0);
    expect(signals.detached).toBeGreaterThan(0);
    expect(universe.detached).toBeGreaterThan(0);
    // And no page silently kept its attachment.
    expect(pageRules.fallbacks).toBe(0);
    expect(signals.fallbacks).toBe(0);
    expect(universe.fallbacks).toBe(0);

    await run(storage.close());
  }, 120_000);

  test("a real parsed page detaches with its schemas still usable", async () => {
    const { storage, crawlId } = await fixture(9, 5);
    const pages = await run(storage.getPages(crawlId));
    const ctx = await run(buildSiteContext(pages));

    resetDetachCounts();
    let checked = 0;

    for (const { parsed } of ctx) {
      if (!parsed) continue;
      const copy = detachParsedPage(parsed);
      checked++;

      // The DOM is dropped, not cloned: cloning a live linkedom document throws,
      // and a throw here would silently keep the whole page attached.
      expect(copy.document).toBeNull();
      expect(copy).not.toBe(parsed);

      // `structuredClone` keeps SchemaCollection's data and loses its prototype.
      // Without the rehydrate, site rules would read `undefined` off a plain
      // object and quietly stop reporting.
      expect(copy.schemas).toBeInstanceOf(SchemaCollection);
      expect(copy.schemas.types).toEqual(parsed.schemas.types);
      expect(copy.schemas.all).toEqual(parsed.schemas.all);
      expect(copy.schemas.organization).toEqual(parsed.schemas.organization);
      expect(copy.schemas.raw).toEqual(parsed.schemas.raw);

      // Everything else survives byte for byte — this is what the golden gate
      // depends on, asserted here per field rather than per report.
      const { document: _d, schemas: _s, ...restCopy } = copy;
      const { document: _d2, schemas: _s2, ...restSource } = parsed;
      expect(restCopy).toEqual(restSource);

      // DEEP, not shallow. A copy that only dropped `document` would satisfy
      // every assertion above while every nested string still pinned the page,
      // which is the whole point of the change.
      expect(copy.schemas).not.toBe(parsed.schemas);
      for (const key of ["meta", "content", "h1", "links", "images"] as const) {
        const nested = parsed[key] as unknown;
        if (nested && typeof nested === "object") {
          expect(copy[key] as unknown).not.toBe(nested);
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(detachCounts("parsed-universe")).toEqual({ detached: checked, fallbacks: 0 });

    // The path this change is FOR: a crawl with no stored parsedData, where the
    // parse ran against a live DOM and every scalar is a slice of the page.
    resetDetachCounts();
    const pagesNoParse = pages.map((p) => ({ ...p, parsedData: null }));
    const ctxNoParse = await run(buildSiteContext(pagesNoParse));
    let reparsed = 0;
    for (const { parsed } of ctxNoParse) {
      if (!parsed) continue;
      const copy = detachParsedPage(parsed);
      expect(copy.document).toBeNull();
      expect(copy.schemas).toBeInstanceOf(SchemaCollection);
      expect(copy.links).toEqual(parsed.links);
      reparsed++;
    }
    expect(reparsed).toBeGreaterThan(0);
    expect(detachCounts("parsed-universe")).toEqual({ detached: reparsed, fallbacks: 0 });

    await run(storage.close());
  }, 120_000);

  test("external-link occurrences detach, and stop pinning their page", async () => {
    // This boundary is the pre-rules walk's, not the page loop's, and it outlives
    // every batch for the whole walk. `href` and `text` come off the LIVE DOM, so
    // both are slices of the page's html — including the map KEY, which pins a
    // page exactly as well as a value does.
    //
    // Hand-built pages rather than the synthetic model: the model renders no
    // external links at all, so a fixture-driven version of this test would
    // compare two empty maps and pass while asserting nothing.
    const ctx = [0, 1, 2].flatMap((i) => externalLinkPage(i, 2_000));

    resetDetachCounts();
    const collected: ExternalLinkOccurrences = new Map();
    absorbExternalLinkOccurrences(collected, ctx);

    expect(collected.size).toBeGreaterThan(0);

    const counts = detachCounts("external-links");
    // One clone per absorb CALL, not per link — so this is the batch count.
    expect(counts.detached).toBe(1);
    expect(counts.fallbacks).toBe(0);

    // Same entries, same per-href order, as the attached version produced. The
    // batched-vs-resident parity is pinned separately by
    // streaming-pre-rules-golden.test.ts; this pins detached-vs-attached.
    const reference: ExternalLinkOccurrences = new Map();
    absorbAttached(reference, ctx);
    expect([...collected.keys()]).toEqual([...reference.keys()]);
    for (const [href, list] of reference) expect(collected.get(href)).toEqual(list);
  }, 120_000);

  test("absorbing from a page-sized document does not retain the document", () => {
    // The assertions above cannot see the thing this change is for: the values
    // are identical whether or not they are attached. So this measures on
    // page-sized inputs, with the same INCONCLUSIVE guard
    // detach-from-page.test.ts uses — a run where the control retains nothing
    // demonstrates nothing, and asserting on it would report a pass it did not
    // earn.
    //
    // heapUsed + external, not heapUsed alone: a string's backing store is not
    // on the JS heap, and a slice pins the BUFFER. Measuring heapUsed by itself
    // reports 0 KB/page for the attached control and makes this test
    // permanently inconclusive.
    // Page-SIZED, and few enough that the transient DOMs stay modest: a real
    // drscholls page is ~959 KB, and the retention this catches is proportional
    // to the source buffer, so a small fixture makes the control indistinguishable
    // from noise (a 300 KB one measured 30 KB/page and stayed inconclusive).
    const N = 30;

    function retainedPerPage(
      absorb: (target: ExternalLinkOccurrences, ctx: SiteContextPage[]) => void,
    ): number {
      Bun.gc(true);
      const before = process.memoryUsage();
      const target: ExternalLinkOccurrences = new Map();
      for (let i = 0; i < N; i++) absorb(target, externalLinkPage(i, 900_000));
      Bun.gc(true);
      const after = process.memoryUsage();
      const grown = after.heapUsed - before.heapUsed + (after.external - before.external);
      expect(target.size).toBe(N); // touch it after the sample
      return grown / N;
    }

    // Warm both paths before measuring either. The first arm to run pays for
    // the parser's one-time structures, which on this fixture is hundreds of KB
    // per page — enough to make whichever arm goes first look like the leaker.
    retainedPerPage(absorbExternalLinkOccurrences);
    retainedPerPage(absorbAttached);

    const detached = retainedPerPage(absorbExternalLinkOccurrences);
    const attached = retainedPerPage(absorbAttached);

    const KB = 1024;
    if (attached < 100 * KB) {
      console.warn(
        `[detach] INCONCLUSIVE: control retained only ${Math.round(attached / KB)} KB/page, ` +
          `so this run did not demonstrate the retention it is meant to catch.`,
      );
      return;
    }
    expect(detached).toBeLessThan(attached / 4);
  }, 120_000);
});

/**
 * One page carrying one distinct external link, parsed the way production parses.
 * `filler` is unique per page so the html cannot share a backing store with any
 * other page's — a corpus built by repeating one string is nearly free to hold
 * and would make the attached control look detached.
 */
function externalLinkPage(i: number, fillerChars: number): SiteContextPage[] {
  const url = `http://synthetic.test/p/${i}`;
  // Long text per node rather than many tiny nodes: the size that matters here
  // is the html BUFFER, and a node-dense page of the same byte count costs
  // several times as much to hold as a live DOM for no extra signal.
  const chunk = 200;
  const filler = Array.from(
    { length: Math.ceil(fillerChars / (chunk + 24)) },
    (_, k) => `<p>${`${i}-${k} `.padEnd(chunk, "abcdefghij")}</p>`,
  ).join("");
  const html =
    `<html><body>${filler}` +
    `<a href="https://partner-${i}.example.com/ref/${i}">Partner ${i} anchor text</a>` +
    `<a href="/local/${i}">Local ${i}</a></body></html>`;
  return [
    { page: { normalizedUrl: url, finalUrl: url, html } as never, parsed: parseHtmlForRules(html, url) },
  ] as unknown as SiteContextPage[];
}

/** Exactly what absorbExternalLinkOccurrences did before the detach. */
function absorbAttached(target: ExternalLinkOccurrences, siteContext: SiteContextPage[]): void {
  for (const { page, parsed } of siteContext) {
    if (!parsed || !parsed.document) continue;
    for (const link of extractLinks(parsed.document, page.finalUrl)) {
      if (link.isInternal || !link.href) continue;
      const list = target.get(link.href) ?? [];
      list.push({
        pageUrl: page.normalizedUrl,
        text: link.text,
        position: link.position,
        isNofollow: link.isNofollow,
      });
      target.set(link.href, list);
    }
  }
}
