// SiteQuery edge API + bounded click depth (#1022, sub-PR 1).
//
// `links/click-depth` and `integrity/orphan-page` gained a streaming path that reads
// `siteQuery.clickDepths` / `siteQuery.outgoingEdges` instead of `site.pages`. Like the other
// dual-path goldens, each rule runs BOTH ways over ONE seeded crawl (links in `pages`, indexability
// in `page_features`) and the checks must be deep-equal. The streaming run gets an EMPTY
// `site.pages`, so a pass also proves the rule reads nothing from the resident page array.
//
// The fixture covers the parity-sensitive cases: a chain deeper than the rule's maxDepth, a
// shortcut, nofollow and chrome links, self-links, a query variant sharing another page's key, an
// external and an uncrawled target, meta and header noindex, a 404, hidden pages in and out of the
// sitemap, and an entry URL.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { loadAllRules } from "@squirrelscan/rules";
import type { CheckResult, ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { LinkData, PageRecord, SitemapDiscovery } from "@squirrelscan/core-contracts";

import { buildHeadersMap } from "../src/adapter";
import { createSiteQuery, extractPageFeatures } from "../src/index";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";
const P = (path: string) => `https://example.com/${path}`;

const rules = loadAllRules();
const clickDepthRule = rules.get("links/click-depth")!;
const orphanPageRule = rules.get("integrity/orphan-page")!;

// ── fixture builders ──────────────────────────────────────────────────────────

const link = (url: string): LinkData => ({ url, text: "l", isInternal: true });
const nofollow = (url: string): LinkData => ({
  url,
  text: "nf",
  isInternal: true,
  isNofollow: true,
  rel: ["nofollow"],
});
const chrome = (url: string): LinkData => ({ url, text: "c", isInternal: true, isChrome: true });
const external = (url: string): LinkData => ({ url, text: "e", isInternal: false });

interface Spec {
  url: string;
  links?: LinkData[];
  status?: number;
  robots?: string | null;
  xRobotsTag?: string | null;
}

function mkPage(spec: Spec): { page: PageRecord; parsed: ParsedPage } {
  const links = spec.links ?? [];
  const parsed = {
    links,
    meta: { title: "T", description: "D", canonical: null, robots: spec.robots ?? null },
    schemas: { types: [], valid: true, errors: [], raw: null },
    content: { wordCount: 100 },
    pageType: "generic",
    visibleAuthor: null,
    visibleDatePublished: null,
    visibleDateModified: null,
  } as unknown as ParsedPage;
  const page: PageRecord = {
    url: spec.url,
    normalizedUrl: spec.url,
    finalUrl: spec.url,
    depth: 1,
    status: spec.status ?? 200,
    contentType: "text/html",
    sizeBytes: 128,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: "<html></html>",
    parsedData: JSON.stringify({ links }),
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: spec.xRobotsTag ?? null,
    },
  };
  return { page, parsed };
}

const LANDING = P("landing");

// Depths from "/" and the landing entry (maxDepth 3 lists the ones above 3):
//   /a=1 /hub=1 /landing=0 /from-landing=1, /d1..: hub chain l1=2 .. l6=7,
//   /a -> /b=2 -> /c=3 -> /d=4 -> /e=5, /hub -> /e shortcut makes /e=2 and /f=3 (via /e),
//   /g=4 /h=5 under /f, deep noindex / 404 pages hang off the chain.
const FIXTURE: Spec[] = [
  {
    url: BASE,
    links: [
      link("/a"),
      link("/hub"),
      nofollow("/nf-only"),
      link("/notcrawled"),
      external("https://external.com/x"),
      chrome("/chrome-page"),
      link("/"),
    ],
  },
  { url: P("a"), links: [link("/b"), link("/a")] },
  // Shares the graph key of /a; only /a is a link source for click depth, but both count for orphan.
  { url: P("a?ref=1"), links: [link("/qonly")] },
  { url: P("b"), links: [link("/c")] },
  { url: P("c"), links: [link("/d")] },
  { url: P("d"), links: [link("/e")] },
  { url: P("e"), links: [link("/f")] },
  { url: P("f"), links: [link("/g")] },
  { url: P("g"), links: [link("/h")] },
  { url: P("h") },
  { url: P("hub"), links: [link("/l1"), link("/e")] },
  { url: P("l1"), links: [link("/l2")] },
  { url: P("l2"), links: [link("/l3")] },
  { url: P("l3"), links: [link("/l4"), link("/deep-header-noindex"), link("/deep-404")] },
  { url: P("l4"), links: [link("/l5"), link("/deep-meta-noindex")] },
  { url: P("l5"), links: [link("/l6")] },
  { url: P("l6") },
  { url: P("deep-meta-noindex"), robots: "noindex,follow", links: [link("/after-noindex")] },
  { url: P("after-noindex") },
  { url: P("deep-header-noindex"), xRobotsTag: "noindex" },
  { url: P("deep-404"), status: 404, links: [link("/after-404")] },
  { url: P("after-404") },
  { url: P("nf-only"), links: [link("/behind-nf")] },
  { url: P("behind-nf") },
  { url: P("chrome-page") },
  { url: P("hidden-nosm") },
  { url: P("hidden-insm") },
  { url: P("qonly") },
  { url: P("selfish"), links: [link("/selfish")] },
  { url: P("gone-404"), status: 404 },
  { url: LANDING, links: [link("/from-landing")] },
  { url: P("from-landing") },
];

const SITEMAP_WITH_HIDDEN: SitemapDiscovery = {
  readState: "complete",
  discovered: [{ urls: [{ loc: P("hidden-insm") }, { loc: P("a") }] }],
} as unknown as SitemapDiscovery;

interface Env {
  store: SQLiteStorage;
  built: { page: PageRecord; parsed: ParsedPage }[];
}

async function seed(fixture: Spec[] = FIXTURE): Promise<Env> {
  const store = await freshStore();
  const built = fixture.map(mkPage);
  for (const { page, parsed } of built) {
    await run(store.upsertPage(CRAWL, page));
    await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));
  }
  built.sort((a, b) => (a.page.normalizedUrl < b.page.normalizedUrl ? -1 : 1));
  return { store, built };
}

interface Extra {
  sitemaps?: SitemapDiscovery | null;
  crawlLimits?: { pagesCrawled: number; maxPages: number };
  collectedSignals?: unknown;
}

async function runBothWays(
  env: Env,
  rule: Rule,
  options: Record<string, unknown>,
  extra: Extra = {}
) {
  const sitePages = env.built.map(({ page, parsed }) => ({
    url: page.normalizedUrl,
    finalUrl: page.finalUrl,
    statusCode: page.status,
    headers: buildHeadersMap(page),
    parsed,
  }));
  const site = (pages: typeof sitePages) => ({
    baseUrl: BASE,
    entryUrls: [BASE, LANDING],
    pages,
    robotsTxt: null,
    sitemaps: extra.sitemaps ?? null,
    ...(extra.crawlLimits ? { crawlLimits: extra.crawlLimits } : {}),
  });
  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options,
    ...(extra.collectedSignals ? { collectedSignals: extra.collectedSignals } : {}),
  };
  const legacy = (await Promise.resolve(rule.run({ ...base, site: site(sitePages) } as RuleContext)))
    .checks;
  const siteQuery = await run(createSiteQuery(env.store, CRAWL));
  const streamed = (
    await Promise.resolve(rule.run({ ...base, site: site([]), siteQuery } as RuleContext))
  ).checks;
  return { legacy: normalise(legacy), streamed: normalise(streamed) };
}

function normalise(checks: CheckResult[]): CheckResult[] {
  return [...checks]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((c) =>
      c.items ? { ...c, items: [...c.items].sort((x, y) => (x.id < y.id ? -1 : 1)) } : c
    );
}

const signalFor = (url: string) => ({ url, signals: [{ kind: "x" }] });
const signals = (...urls: string[]) => ({ pages: urls.map(signalFor) });

// ── links/click-depth ─────────────────────────────────────────────────────────

describe("SiteQuery dual-path: links/click-depth", () => {
  test("maxDepth 3 lists the same deep pages on both paths", async () => {
    const env = await seed();
    const { legacy, streamed } = await runBothWays(env, clickDepthRule, { maxDepth: 3 });
    expect(streamed).toEqual(legacy);
    const check = legacy[0]!;
    expect(check.status).toBe("warn");
    const ids = (check.items ?? []).map((i) => i.id);
    // Noindex pages and the 404 are never listed, the shortcut pulls /e and /f in.
    expect(ids).toContain(P("l4"));
    expect(ids).toContain(P("l6"));
    expect(ids).not.toContain(P("deep-meta-noindex"));
    expect(ids).not.toContain(P("deep-header-noindex"));
    expect(ids).not.toContain(P("deep-404"));
    expect(ids).not.toContain(P("e"));
    // Pages only reachable through a nofollow link or the query variant have no depth at all.
    expect(ids).not.toContain(P("behind-nf"));
    expect(ids).not.toContain(P("qonly"));
    expect(check.details).toMatchObject({ threshold: 3, deepest: 7 });
    await run(env.store.close());
  }, 30_000);

  test("maxDepth 1 and the all-clear maxDepth 10 match", async () => {
    const env = await seed();
    const one = await runBothWays(env, clickDepthRule, { maxDepth: 1 });
    expect(one.streamed).toEqual(one.legacy);
    expect(one.legacy[0]!.status).toBe("warn");
    const ten = await runBothWays(env, clickDepthRule, { maxDepth: 10 });
    expect(ten.streamed).toEqual(ten.legacy);
    expect(ten.legacy[0]!.status).toBe("pass");
    await run(env.store.close());
  }, 30_000);

  test("a crawl at its page cap is labelled a lower bound on both paths", async () => {
    const env = await seed();
    const { legacy, streamed } = await runBothWays(
      env,
      clickDepthRule,
      { maxDepth: 3 },
      { crawlLimits: { pagesCrawled: 10, maxPages: 10 } }
    );
    expect(streamed).toEqual(legacy);
    expect(legacy[0]!.details).toMatchObject({ lowerBound: true });
    expect(legacy[0]!.details).not.toHaveProperty("searchTruncated");
    await run(env.store.close());
  }, 30_000);

  test("the streaming path really ran: empty site.pages still finds the deep pages", async () => {
    const env = await seed();
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const emptyLegacy = await clickDepthRule.run({
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
      options: { maxDepth: 3 },
    } as RuleContext);
    expect(emptyLegacy.checks[0]!.status).toBe("skipped");
    const streamed = await clickDepthRule.run({
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
      siteQuery,
      options: { maxDepth: 3 },
    } as RuleContext);
    expect(streamed.checks[0]!.status).toBe("warn");
    expect(streamed.checks[0]!.items?.length).toBeGreaterThan(0);
    await run(env.store.close());
  }, 30_000);
});

// ── integrity/orphan-page ─────────────────────────────────────────────────────

describe("SiteQuery dual-path: integrity/orphan-page", () => {
  const withSignals = { collectedSignals: signals() };

  test("with a sitemap", async () => {
    const env = await seed();
    const { legacy, streamed } = await runBothWays(
      env,
      orphanPageRule,
      { minPages: 3 },
      { sitemaps: SITEMAP_WITH_HIDDEN, ...withSignals }
    );
    expect(streamed).toEqual(legacy);
    const ids = (legacy.find((c) => c.name === "orphan-page-review")?.items ?? []).map((i) => i.id);
    // In no sitemap and linked from nowhere (the query variant's link counts as inbound).
    expect(ids).toEqual([P("hidden-nosm")]);
    // A self-link counts as inbound, exactly like the legacy rule.
    expect(ids).not.toContain(P("selfish"));
    expect(ids).not.toContain(P("hidden-insm"));
    expect(ids).not.toContain(P("qonly"));
    expect(ids).not.toContain(P("nf-only"));
    expect(ids).not.toContain(P("chrome-page"));
    expect(ids).not.toContain(P("gone-404"));
    expect(ids).not.toContain(LANDING);
    await run(env.store.close());
  }, 30_000);

  test("without a sitemap", async () => {
    const env = await seed();
    const { legacy, streamed } = await runBothWays(env, orphanPageRule, { minPages: 3 }, withSignals);
    expect(streamed).toEqual(legacy);
    const ids = (legacy.find((c) => c.name === "orphan-page-review")?.items ?? []).map((i) => i.id);
    expect(ids).toContain(P("hidden-insm"));
    await run(env.store.close());
  }, 30_000);

  test("a truncated sitemap is never escalated", async () => {
    const env = await seed();
    const truncated = { ...SITEMAP_WITH_HIDDEN, truncated: true } as unknown as SitemapDiscovery;
    const { legacy, streamed } = await runBothWays(
      env,
      orphanPageRule,
      { minPages: 3 },
      { sitemaps: truncated, collectedSignals: signals(P("hidden-nosm")) }
    );
    expect(streamed).toEqual(legacy);
    expect(legacy.map((c) => c.name)).toEqual(["orphan-page-review"]);
    expect(legacy[0]!.details).toMatchObject({ sitemapIncomplete: true });
    await run(env.store.close());
  }, 30_000);

  test("a hidden page carrying a signal escalates on both paths", async () => {
    const env = await seed();
    const { legacy, streamed } = await runBothWays(
      env,
      orphanPageRule,
      { minPages: 3 },
      { sitemaps: SITEMAP_WITH_HIDDEN, collectedSignals: signals(P("hidden-nosm")) }
    );
    expect(streamed).toEqual(legacy);
    const fail = legacy.find((c) => c.name === "orphan-page")!;
    expect(fail.status).toBe("fail");
    expect((fail.items ?? []).map((i) => i.id)).toEqual([P("hidden-nosm")]);
    await run(env.store.close());
  }, 30_000);

  test("minPages above the universe size skips on both paths", async () => {
    const env = await seed();
    const { legacy, streamed } = await runBothWays(env, orphanPageRule, { minPages: 500 }, withSignals);
    expect(streamed).toEqual(legacy);
    expect(legacy[0]!.status).toBe("skipped");
    await run(env.store.close());
  }, 30_000);

  test("the streaming path really ran: empty site.pages still finds hidden pages", async () => {
    const env = await seed();
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const ctx = {
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: { baseUrl: BASE, entryUrls: [BASE, LANDING], pages: [], robotsTxt: null, sitemaps: null },
      collectedSignals: signals(),
      options: { minPages: 3 },
    } as unknown as RuleContext;
    expect((await orphanPageRule.run(ctx)).checks[0]!.status).toBe("skipped");
    const streamed = await orphanPageRule.run({ ...ctx, siteQuery });
    expect(streamed.checks[0]!.status).toBe("info");
    expect(streamed.checks[0]!.items?.length).toBeGreaterThan(0);
    await run(env.store.close());
  }, 30_000);
});

// ── SiteQuery.outgoingEdges ───────────────────────────────────────────────────

describe("SiteQuery.outgoingEdges", () => {
  test("streams every universe page with flags, keeping self-links and dropping unknown targets", async () => {
    const env = await seed();
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const seen = new Map<string, Awaited<ReturnType<typeof collect>>[number]>();
    async function collect() {
      const out = [];
      for await (const page of siteQuery.outgoingEdges!()) out.push(page);
      return out;
    }
    const all = await collect();
    for (const page of all) seen.set(page.source, page);

    expect(all.map((p) => p.source)).toEqual(env.built.map((b) => b.page.normalizedUrl));
    const home = seen.get(BASE)!;
    expect(home.sourceKey).toBe(BASE);
    expect(home.status).toBe(200);
    expect(home.edges).toEqual([
      { target: P("a"), nofollow: false, chrome: false },
      { target: P("hub"), nofollow: false, chrome: false },
      { target: P("nf-only"), nofollow: true, chrome: false },
      { target: P("chrome-page"), nofollow: false, chrome: true },
      { target: BASE, nofollow: false, chrome: false },
    ]);
    expect(seen.get(P("selfish"))!.edges).toEqual([
      { target: P("selfish"), nofollow: false, chrome: false },
    ]);
    // A query variant is its own source and shares the sourceKey of /a.
    expect(seen.get(P("a?ref=1"))!.sourceKey).toBe(P("a"));
    expect(seen.get(P("deep-404"))!.status).toBe(404);
    await run(env.store.close());
  }, 30_000);

  test("sources are restricted to the supplied universe", async () => {
    const env = await seed();
    const siteQuery = await run(
      createSiteQuery(env.store, CRAWL, { universe: [BASE, P("a"), P("b")] })
    );
    const sources: string[] = [];
    for await (const page of siteQuery.outgoingEdges!()) sources.push(page.source);
    expect(sources).toEqual([BASE, P("a"), P("b")]);
    await run(env.store.close());
  }, 30_000);
});

// ── SiteQuery.clickDepths ─────────────────────────────────────────────────────

describe("SiteQuery.clickDepths", () => {
  test("roots outside the universe are ignored; only the first page per key is a source", async () => {
    const env = await seed();
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const none = await siteQuery.clickDepths!(["https://other.com/x", P("not-crawled")], {
      maxDepth: 50,
      maxNodes: 1000,
    });
    expect(none.depths.size).toBe(0);
    expect(none.truncated).toBeNull();

    const result = await siteQuery.clickDepths!([BASE, "https://other.com/x"], {
      maxDepth: 50,
      maxNodes: 1000,
    });
    expect(result.truncated).toBeNull();
    expect(result.depths.get(BASE)).toEqual({ depth: 0, status: 200 });
    expect(result.depths.get(P("e"))).toEqual({ depth: 2, status: 200 });
    expect(result.depths.get(P("deep-404"))).toEqual({ depth: 5, status: 404 });
    expect(result.depths.get(P("l6"))!.depth).toBe(7);
    // /a?ref=1 links to /qonly but is a duplicate key of /a, so it is not a source and not a node.
    expect(result.depths.has(P("qonly"))).toBe(false);
    expect(result.depths.has(P("a?ref=1"))).toBe(false);
    // Nofollow targets are not followed.
    expect(result.depths.has(P("nf-only"))).toBe(false);
    expect(result.depths.has(P("behind-nf"))).toBe(false);
    await run(env.store.close());
  }, 30_000);

  async function chain(n: number): Promise<Env> {
    const specs: Spec[] = [];
    for (let i = 0; i < n; i++) {
      specs.push({ url: P(`p${i}`), links: i + 1 < n ? [link(`/p${i + 1}`)] : [] });
    }
    return seed(specs);
  }

  test("maxNodes caps the depth map and reports it", async () => {
    const env = await chain(200);
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const r = await siteQuery.clickDepths!([P("p0")], { maxDepth: 500, maxNodes: 25 });
    expect(r.depths.size).toBeLessThanOrEqual(25);
    expect(r.depths.size).toBe(25);
    expect(r.truncated).toBe("maxNodes");
    // Every node still carries its status.
    for (const node of r.depths.values()) expect(node.status).toBe(200);

    const empty = await siteQuery.clickDepths!([P("p0")], { maxDepth: 500, maxNodes: 0 });
    expect(empty.depths.size).toBe(0);
    expect(empty.truncated).toBe("maxNodes");
    await run(env.store.close());
  }, 30_000);

  test("maxDepth stops the search one level past the limit and reports it", async () => {
    const env = await chain(200);
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const r = await siteQuery.clickDepths!([P("p0")], { maxDepth: 10, maxNodes: 100_000 });
    expect(Math.max(...[...r.depths.values()].map((n) => n.depth))).toBe(10);
    expect(r.depths.size).toBe(11);
    expect(r.truncated).toBe("maxDepth");
    for (const node of r.depths.values()) expect(node.status).toBe(200);
    await run(env.store.close());
  }, 30_000);

  test("a maxDepth that reaches the end of the chain is not truncated", async () => {
    const env = await chain(200);
    const siteQuery = await run(createSiteQuery(env.store, CRAWL));
    const exact = await siteQuery.clickDepths!([P("p0")], { maxDepth: 199, maxNodes: 100_000 });
    expect(exact.depths.size).toBe(200);
    expect(exact.truncated).toBeNull();
    const longer = await siteQuery.clickDepths!([P("p0")], { maxDepth: 200, maxNodes: 100_000 });
    expect(longer.depths.size).toBe(200);
    expect(longer.truncated).toBeNull();
    await run(env.store.close());
  }, 30_000);
});

// ── SQLiteStorage.getPageLinkRowsByUrls ───────────────────────────────────────

describe("SQLiteStorage.getPageLinkRowsByUrls", () => {
  test("returns only the requested rows, sorted, across chunk boundaries", async () => {
    const specs: Spec[] = [];
    for (let i = 0; i < 1200; i++) {
      specs.push({ url: P(`r${String(i).padStart(4, "0")}`), links: [link("/x")] });
    }
    const store = await freshStore();
    for (const { page } of specs.map(mkPage)) await run(store.upsertPage(CRAWL, page));

    // Every other page: 600 urls, more than one 500-url statement, plus one unknown url.
    const wanted = specs.filter((_, i) => i % 2 === 0).map((s) => s.url);
    const rows = await run(
      store.getPageLinkRowsByUrls(CRAWL, [...wanted].reverse().concat(P("missing")))
    );
    expect(rows.map((r) => r.normalizedUrl)).toEqual(wanted);
    expect(rows[0]!.status).toBe(200);
    expect(rows[0]!.parsedData).toContain("/x");

    expect(await run(store.getPageLinkRowsByUrls(CRAWL, []))).toEqual([]);
    expect(await run(store.getPageLinkRowsByUrls("other-crawl", wanted))).toEqual([]);
    await run(store.close());
  }, 30_000);
});
