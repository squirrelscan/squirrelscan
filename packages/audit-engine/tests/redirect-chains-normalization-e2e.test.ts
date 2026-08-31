// #1510 end-to-end: a redirect chain may only be built from responses the crawl
// actually watched, and URL normalization must never manufacture a hop.
//
// The existing guards are split across layers and each one mocks the layer below
// it: `crawler/tests/trailing-slash-canonical-crawl.test.ts` stops at the stored
// `PageRecord`s and never runs a rule; `rules/tests/redirect-chains-*.test.ts`
// hand the rule a hand-written `RedirectChain`. Nothing joined them, so the
// question the bug report actually asked — "does auditing a slash-canonical site
// report redirects it does not have?" — had no test that could answer it.
//
// This runs the real crawler against a real origin, then the real rule over the
// real stored chains through the real adapter mapping. A fabricated hop
// introduced at ANY of those layers fails here.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage, type CrawlerConfig } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, type PreFetchedAssets } from "../src/adapter";

const RULE_ID = "links/redirect-chains";

// Only the rule under test: `filterRules` defaults every rule to disabled, so an
// enable list is mandatory — `rules: {}` would run nothing and pass vacuously.
const CONFIG = {
  rule_options: {},
  rules: { enable: [RULE_ID] },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const CRAWLER_CONFIG: Partial<CrawlerConfig> = {
  maxPages: 20,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 2000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
};

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

interface Site {
  origin: string;
  /** Every path the origin was asked for, in order. */
  requested: string[];
  stop: () => void;
}

const sites: Site[] = [];
afterEach(() => {
  while (sites.length > 0) sites.pop()?.stop();
});

function serve(handler: (path: string, url: URL) => Response): Site {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      requested.push(url.pathname + url.search);
      return handler(url.pathname, url);
    },
  });
  const site = {
    origin: `http://127.0.0.1:${server.port}`,
    requested,
    stop: () => server.stop(true),
  };
  sites.push(site);
  return site;
}

function html(body: string): Response {
  return new Response(
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

function link(href: string): string {
  return `<a href="${href}">l</a>`;
}

function movedTo(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

interface Audit {
  checks: CheckResult[];
  /** Normalized URLs of the pages the crawl actually stored. */
  crawled: string[];
}

/** Crawl the origin for real, then run the real rule over the real stored chains. */
async function audit(origin: string): Promise<Audit> {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: CRAWLER_CONFIG, storage });
      const crawlId = yield* crawler.start(`${origin}/`, `${origin}/`);
      const pages = yield* storage.getPages(crawlId);
      const siteContext = yield* buildSiteContext(pages);
      const result = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);
      return {
        checks: result.ruleResultsMap.get(RULE_ID)?.checks ?? [],
        crawled: pages.map((page) => page.normalizedUrl),
      };
      // `Effect.gen`'s try/finally does not run on failure; `ensuring` does.
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

/**
 * The rule ran and reported no redirect anywhere. Asserting the explicit `pass`
 * check — not merely the absence of warnings — is what keeps a negative test
 * honest: an empty `checks` array means the rule never ran, which would satisfy
 * "no redirects reported" for entirely the wrong reason.
 */
function expectNoRedirectsReported(checks: CheckResult[]): void {
  expect(named(checks, "redirect-pages")).toBeUndefined();
  expect(named(checks, "links-to-redirect")).toBeUndefined();
  expect(named(checks, "redirect-chains")?.status).toBe("pass");
}

describe("#1510 — normalization never manufactures a hop (crawl → rule)", () => {
  test("(a) a slash-canonical site reports no redirects at all", async () => {
    // The reported case: every internal href ends in `/`, and the origin 301s
    // any no-slash form. If normalization asks for a form the site never linked,
    // the origin's 301 becomes a redirect the audit blames the site for.
    const PAGES = ["/", "/o-mnie/", "/blog/", "/kontakt/"];
    const site = serve((path) => {
      if (path !== "/" && !path.endsWith("/")) return movedTo(`${path}/`);
      if (!PAGES.includes(path)) return new Response("nope", { status: 404 });
      return html(PAGES.filter((p) => p !== path).map(link).join(""));
    });

    const { checks, crawled } = await audit(site.origin);

    // Non-vacuous: the crawl really walked the whole site, so the rule had every
    // page's chain in front of it.
    for (const path of PAGES) {
      expect(crawled).toContain(`${site.origin}${path}`);
    }
    // And the origin was never asked for a form the site does not link.
    const documentPaths = site.requested.filter((p) => !p.includes("."));
    expect(documentPaths.filter((p) => p !== "/" && !p.endsWith("/"))).toEqual([]);

    expectNoRedirectsReported(checks);
  });

  test("(a) normalization that reshapes the request is still not a redirect", async () => {
    // The frontier strips tracking params from the URL it FETCHES, so the href
    // as written and the URL requested genuinely differ. That difference is a
    // normalization, not a hop, and the origin sends no 3xx here at all.
    const site = serve((path, url) => {
      if (path === "/") return html(link("/blog/?utm_source=newsletter") + link("/kontakt/"));
      if (path === "/blog/" || path === "/kontakt/") {
        // Proves the strip rather than assuming it: a request that still carried
        // the param would be answered with a redirect, which the assertions
        // below would catch.
        if (url.searchParams.has("utm_source")) return movedTo(path);
        return html("");
      }
      return new Response("nope", { status: 404 });
    });

    const { checks, crawled } = await audit(site.origin);

    expect(crawled).toContain(`${site.origin}/blog/`);
    // The tracking param never reached the wire, so no redirect was provoked.
    expect(site.requested.filter((p) => p.includes("utm_source"))).toEqual([]);

    expectNoRedirectsReported(checks);
  });
});

describe("#1510 — real redirects still report, with their real statuses", () => {
  test("(b) a genuine 301 → 301 → 200 chain is reported with true statuses", async () => {
    const site = serve((path) => {
      if (path === "/") return html(link("/stary/"));
      if (path === "/stary/") return movedTo("/posredni/");
      if (path === "/posredni/") return movedTo("/nowy/");
      if (path === "/nowy/") return html("");
      return new Response("nope", { status: 404 });
    });

    const { checks } = await audit(site.origin);

    const redirectPages = named(checks, "redirect-pages");
    expect(redirectPages?.status).toBe("warn");
    expect(redirectPages?.items).toHaveLength(1);

    // The statuses, structurally — this is the assertion that would have caught
    // the reported `200 → 200`.
    const chain = (redirectPages?.items?.[0]?.meta as { chain?: { hops: { url: string; statusCode: number }[] } }).chain;
    expect(chain?.hops.map((hop) => hop.statusCode)).toEqual([301, 301, 200]);
    expect(chain?.hops.map((hop) => hop.url)).toEqual([
      `${site.origin}/stary/`,
      `${site.origin}/posredni/`,
      `${site.origin}/nowy/`,
    ]);
    expect(redirectPages?.items?.[0]?.label).toBe(
      `${site.origin}/stary/ (301) → ${site.origin}/posredni/ (301) → ${site.origin}/nowy/ (200)`,
    );

    // The page that linked the redirecting form is the one blamed.
    expect(named(checks, "links-to-redirect")?.items?.[0]?.sourcePages).toEqual([`${site.origin}/`]);
  });

  test("(c) normalization plus one real 301 yields exactly one hop", async () => {
    // The href carries a tracking param the frontier strips, so the URL asked
    // for is not the URL written — and the URL asked for really does 301.
    // Exactly one redirect happened, so exactly one hop belongs in the chain,
    // and the source reported is the URL that was actually requested.
    const site = serve((path, url) => {
      if (path === "/") return html(link("/stary/?utm_source=newsletter"));
      if (path === "/stary/") {
        if (url.searchParams.has("utm_source")) return new Response("nope", { status: 404 });
        return movedTo("/nowy/");
      }
      if (path === "/nowy/") return html("");
      return new Response("nope", { status: 404 });
    });

    const { checks } = await audit(site.origin);

    const redirectPages = named(checks, "redirect-pages");
    expect(redirectPages?.status).toBe("warn");
    expect(redirectPages?.items).toHaveLength(1);
    expect(redirectPages?.items?.[0]?.id).toBe(`${site.origin}/stary/`);

    const chain = (redirectPages?.items?.[0]?.meta as { chain?: { chainLength: number; hops: { statusCode: number }[] } }).chain;
    expect(chain?.chainLength).toBe(1);
    expect(chain?.hops.map((hop) => hop.statusCode)).toEqual([301, 200]);
  });

  test("no reported chain ever claims a 2xx status on a hop it says redirected", async () => {
    // The shape from the bug report — `(200) → (200)` — as an invariant over
    // whatever this crawl produces, not over a hand-written chain.
    const site = serve((path) => {
      if (path === "/") return html(link("/stary/") + link("/o-mnie") + link("/o-mnie/"));
      if (path === "/stary/") return movedTo("/o-mnie/");
      if (path === "/o-mnie") return movedTo("/o-mnie/");
      if (path === "/o-mnie/") return html("");
      return new Response("nope", { status: 404 });
    });

    const { checks } = await audit(site.origin);

    const items = named(checks, "redirect-pages")?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    const nonFinalHops = items.flatMap(
      (item) =>
        (item.meta as { chain?: { hops: { statusCode: number }[] } }).chain?.hops.slice(0, -1) ?? [],
    );
    expect(nonFinalHops.length).toBeGreaterThan(0);
    for (const hop of nonFinalHops) {
      expect(hop.statusCode >= 200 && hop.statusCode < 300).toBe(false);
    }
  });
});
