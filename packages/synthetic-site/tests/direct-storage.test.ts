// Direct-storage mode: writeCrawlToStorage must round-trip cleanly through the
// crawler's public CrawlStorage API, no raw SQL — page count matches the
// model, and link_appearances mirrors the real crawler's external-only
// convention (internal links live in the stored parsed HTML, not this table).

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel } from "../src/page-model";
import { writeCrawlToStorage } from "../src/storage-writer";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

let openStorages: Array<{ close: () => Effect.Effect<void, unknown, never> }> = [];

afterEach(async () => {
  for (const storage of openStorages) {
    await run(storage.close());
  }
  openStorages = [];
});

describe("synthetic-site direct-storage mode", () => {
  test("writes 200 pages and round-trips through getPages/getPageCount", async () => {
    const model = generateSiteModel({ seed: "direct-storage-200", pageCount: 200 });

    const result = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(result.storage);

    const storedCount = await run(result.storage.getPageCount(result.crawlId));
    expect(storedCount).toBe(result.pageCount);
    expect(storedCount).toBe(model.pages.length);

    const pages = await run(result.storage.getPages(result.crawlId, { limit: 10_000 }));
    expect(pages.length).toBe(model.pages.length);

    // Every model page path is present as a stored normalizedUrl.
    const storedPaths = new Set(pages.map((p) => new URL(p.normalizedUrl).pathname));
    for (const page of model.pages) {
      expect(storedPaths.has(page.path)).toBe(true);
    }

    // Non-redirect pages carry rendered HTML; redirect hops don't.
    const home = pages.find((p) => new URL(p.normalizedUrl).pathname === "/");
    expect(home?.html).toContain("<title>");
    const hop = pages.find((p) => p.status >= 300 && p.status < 400);
    if (hop) expect(hop.html).toBeNull();
  });

  test("link_appearances stays empty for an all-internal model — matches the real crawler's external-only convention", async () => {
    // The real crawler only ever writes EXTERNAL link occurrences into
    // link_appearances (apps/cli/src/audit/adapter.ts's only production call
    // site of addLinkAppearancesBatch is inside the external-link-checking
    // block) — internal links are derived from parsed HTML at rule-run time,
    // never stored here. A generated SiteModel never links off its own host,
    // so link_appearances should stay empty, same as a real crawl of a site
    // with zero external links would.
    const model = generateSiteModel({ seed: "direct-storage-links", pageCount: 200 });
    const totalInternalLinks = model.pages.reduce((sum, p) => sum + p.outgoingLinks.length, 0);
    expect(totalInternalLinks).toBeGreaterThan(0); // sanity: pages do link to each other

    const result = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(result.storage);
    expect(result.linkAppearanceCount).toBe(0);

    const home = model.pages.find((p) => p.path === "/")!;
    const homeUrl = `http://synthetic.test${home.path}`;
    // Home is linked from nearly every page, but ONLY internally — must never
    // show up in link_appearances.
    const appearances = await run(result.storage.getLinkAppearances(result.crawlId, homeUrl));
    expect(appearances.length).toBe(0);
  });

  test("link_appearances stores ONLY external hrefs when a page links off-site, excluding internal links on the same page", async () => {
    const model = generateSiteModel({ seed: "direct-storage-external-link", pageCount: 20 });
    const home = model.pages.find((p) => p.path === "/")!;
    const source = model.pages.find((p) => p.path !== "/" && p.templateId !== "redirect-hop")!;

    // Mutate in a genuinely external link alongside the model's normal
    // internal links (every page already links home) — proves the writer
    // classifies by hostname, not by construction order, and that internal
    // links on the SAME page still get excluded.
    const externalHref = "https://external-example.com/other-site-page";
    source.outgoingLinks.push(externalHref);

    const result = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(result.storage);

    expect(result.linkAppearanceCount).toBe(1);

    const externalAppearances = await run(
      result.storage.getLinkAppearances(result.crawlId, externalHref),
    );
    expect(externalAppearances.length).toBe(1);
    expect(externalAppearances[0]?.pageUrl).toBe(`http://synthetic.test${source.path}`);

    // The internal home link that `source` also carries must NOT appear.
    const homeUrl = `http://synthetic.test${home.path}`;
    const homeAppearances = await run(result.storage.getLinkAppearances(result.crawlId, homeUrl));
    expect(homeAppearances.length).toBe(0);
  });

  test("sitemap + robots round-trip, including orphan pages in the sitemap", async () => {
    const model = generateSiteModel({
      seed: "direct-storage-sitemap",
      pageCount: 100,
      issues: { orphanPages: { count: 3 } },
    });

    const result = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(result.storage);

    const robots = await run(result.storage.getRobotsTxt(result.crawlId));
    expect(robots?.exists).toBe(true);
    expect(robots?.content).toContain("Sitemap:");

    const sitemapUrls = await run(
      result.storage.getSitemapUrls(result.crawlId, "http://synthetic.test/sitemap.xml"),
    );
    expect(sitemapUrls.length).toBe(model.sitemapPaths.length);

    const orphanPages = model.pages.filter((p) => p.issues.includes("orphan"));
    expect(orphanPages.length).toBe(3);
    for (const orphan of orphanPages) {
      expect(model.sitemapPaths).toContain(orphan.path);
      expect(sitemapUrls.some((u) => u.loc === `http://synthetic.test${orphan.path}`)).toBe(true);
    }
  });

  test("timestamps are derived from the model seed, not Date.now() (two writes agree)", async () => {
    const model = generateSiteModel({ seed: "timestamp-determinism", pageCount: 50 });

    const first = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(first.storage);
    const firstCrawl = await run(first.storage.getCrawl(first.crawlId));
    const firstPages = await run(first.storage.getPages(first.crawlId, { limit: 1000 }));

    // A real wall-clock gap between the two writes — if fetchedAt/startedAt
    // were Date.now()-derived, these would differ across the two calls.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(second.storage);
    const secondCrawl = await run(second.storage.getCrawl(second.crawlId));
    const secondPages = await run(second.storage.getPages(second.crawlId, { limit: 1000 }));

    expect(firstCrawl?.startedAt).toBe(secondCrawl?.startedAt);
    expect(firstCrawl?.completedAt).toBe(secondCrawl?.completedAt);
    expect(firstPages.map((p) => p.fetchedAt)).toEqual(secondPages.map((p) => p.fetchedAt));
  });

  test("redirect-chain hop depth increases hop-by-hop instead of falling back to 0", async () => {
    // computeDepths' BFS only walks outgoingLinks by default; redirect hops
    // (empty outgoingLinks, chain expressed via redirectTo) need it to also
    // follow redirectTo, or every hop past hop-0 silently gets depth 0 —
    // indistinguishable from the homepage.
    const model = generateSiteModel({
      seed: "redirect-hop-depth",
      pageCount: 100,
      issues: { redirectChains: { count: 1, chainLength: 4 } },
    });

    const result = await writeCrawlToStorage(model, ":memory:");
    openStorages.push(result.storage);

    const pages = await run(result.storage.getPages(result.crawlId, { limit: 1000 }));
    const depthByPath = new Map(pages.map((p) => [new URL(p.normalizedUrl).pathname, p.depth]));

    const hop0Depth = depthByPath.get("/redirect-chain/0/hop-0")!;
    const hop1Depth = depthByPath.get("/redirect-chain/0/hop-1")!;
    const hop2Depth = depthByPath.get("/redirect-chain/0/hop-2")!;
    const hop3Depth = depthByPath.get("/redirect-chain/0/hop-3")!;

    expect(hop0Depth).toBeGreaterThan(0); // linked from some non-home source page
    expect(hop1Depth).toBe(hop0Depth + 1);
    expect(hop2Depth).toBe(hop1Depth + 1);
    expect(hop3Depth).toBe(hop2Depth + 1);
  });
});
