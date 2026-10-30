// `deadlineAt` on the streamed page-rule pass (#1271): once the wall clock passes it,
// no further page starts its rules, the pass ends cleanly with what it has, and the
// pages it left are counted. A page already running finishes. No deadline: every
// page runs and nothing is reported as left.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { createRunner, type SiteData } from "@squirrelscan/rules";

import { streamPageRules } from "../src/streaming";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } };
const PAGES = 24;

function siteData(): SiteData {
  return { baseUrl: "http://synthetic.example.com", pages: [], robotsTxt: null, sitemaps: null };
}

async function fixture() {
  return writeCrawlToStorage(generateSiteModel({ seed: 7, pageCount: PAGES }), ":memory:");
}

afterEach(() => setSystemTime());

describe("streamPageRules deadlineAt (#1271)", () => {
  test("no deadline: every page runs and none is left", async () => {
    const { storage, crawlId } = await fixture();
    const result = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), { batchSize: 8 })
    );
    expect(result.pagesNotEvaluated).toBe(0);
    expect(result.pageUrls.length).toBeGreaterThan(0);
  });

  test("a deadline in the past runs no page and counts them all", async () => {
    const { storage, crawlId } = await fixture();
    const universe = new Set(
      (await run(storage.getPages(crawlId))).map((page) => page.normalizedUrl)
    );
    const result = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), {
        batchSize: 8,
        deadlineAt: Date.now() - 1000,
        pageUniverse: universe,
        totalPages: universe.size,
      })
    );
    expect(result.pageUrls).toEqual([]);
    expect(result.pagesNotEvaluated).toBe(universe.size);
    expect(result.tallies.size).toBe(0);
  });

  test("a deadline that passes mid-run stops after the pages done and counts the rest", async () => {
    const { storage, crawlId } = await fixture();
    const universe = new Set(
      (await run(storage.getPages(crawlId))).map((page) => page.normalizedUrl)
    );
    const base = Date.now();
    const result = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), {
        batchSize: 4,
        deadlineAt: base + 60_000,
        pageUniverse: universe,
        totalPages: universe.size,
        pageLoopHooks: {
          heartbeatEveryPages: 1,
          // The clock passes the deadline after the fifth page.
          onProgress: (done) => {
            if (done === 5) setSystemTime(new Date(base + 120_000));
          },
        },
      })
    );
    expect(result.pageUrls.length).toBe(5);
    expect(result.pagesNotEvaluated).toBe(universe.size - 5);
  });
});
