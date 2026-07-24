// HTTP mode: serveSite() must be a genuinely crawlable site — spin it up and
// crawl it with the REAL packages/crawler (not a fixture fetcher) over real
// loopback HTTP, then assert the crawl discovered the seeded issues.

import { createCrawler } from "@squirrelscan/crawler";
import { afterEach, describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";

import type { ServedSite } from "../src/server";

import { generateSiteModel } from "../src/page-model";
import { serveSite } from "../src/server";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

let served: ServedSite | undefined;

afterEach(() => {
  served?.stop();
  served = undefined;
});

describe("synthetic-site HTTP mode is crawlable", () => {
  test("packages/crawler discovers pages, duplicate titles, broken links, and an orphan page", async () => {
    const model = generateSiteModel({
      seed: "http-mode-crawl",
      pageCount: 50,
      issues: {
        duplicateTitles: { groupCount: 1, groupSize: 3 },
        duplicateDescriptions: false,
        brokenLinks: { count: 3 },
        orphanPages: { count: 2 },
        redirectChains: { count: 1, chainLength: 2 },
        longH1: false,
        oversizeTitle: false,
        oversizeDescription: false,
        longUrls: false,
        noindexInSitemap: false,
      },
    });

    served = serveSite(model);

    const outcome = await run(
      Effect.gen(function* () {
        const crawler = yield* createCrawler({
          config: {
            maxPages: 200,
            concurrency: 8,
            perHostConcurrency: 8,
            delayMs: 0,
            perHostDelayMs: 0,
            timeoutMs: 5000,
            respectRobots: false,
            breadthFirst: false,
            coverageMode: "full",
            useCacheControl: false,
          },
        });

        const crawlId = yield* crawler
          .start(served!.url)
          .pipe(Effect.timeout(Duration.seconds(20)));

        const pageCount = yield* crawler.storage.getPageCount(crawlId);
        const pages = yield* crawler.storage.getPages(crawlId, { limit: 1000 });
        const stats = yield* crawler.storage.getStats(crawlId);

        return { pageCount, pages, stats };
      }),
    );

    // Most content pages (including the sitemap-only orphan pages) got crawled.
    expect(outcome.pageCount).toBeGreaterThanOrEqual(40);

    // Duplicate titles: the injected group of 3 shows up at least 3x among
    // crawled pages' rendered <title> text.
    const titleCounts = new Map<string, number>();
    for (const page of outcome.pages) {
      if (!page.html) continue;
      const match = page.html.match(/<title>([^<]*)<\/title>/);
      if (!match) continue;
      const title = match[1]!;
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }
    const maxDuplicateCount = Math.max(0, ...titleCounts.values());
    expect(maxDuplicateCount).toBeGreaterThanOrEqual(3);

    // Broken links: the crawler attempted a discovered /broken/* href and
    // recorded the 404 as a failed page.
    expect(outcome.stats?.pagesFailed ?? 0).toBeGreaterThanOrEqual(1);
    const brokenPage = outcome.pages.find((p) => p.normalizedUrl.includes("/broken/"));
    expect(brokenPage?.status).toBe(404);

    // Orphan pages: unreachable via links, only discoverable via sitemap.xml —
    // still got crawled (that's exactly why the orphan-pages rule can flag them).
    const orphanModelPage = model.pages.find((p) => p.issues.includes("orphan"));
    expect(orphanModelPage).toBeDefined();
    const orphanCrawled = outcome.pages.some((p) =>
      p.normalizedUrl.endsWith(orphanModelPage!.path),
    );
    expect(orphanCrawled).toBe(true);
  }, 20_000);
});
