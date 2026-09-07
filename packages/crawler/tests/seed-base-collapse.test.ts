// squirrelscan/repo#1899 — a crawl must not collapse to one page when the seed's
// redirect probe is refused.
//
// The crawl's base origin is pinned from ONE unauthenticated probe of the seed
// (`detectRedirects` → `resolveSeedRedirect`). That probe treated any response
// it could read as proof of where the seed settles, so a WAF answering the apex
// with 403 — no `Location`, nothing to follow — pinned the base to the apex.
// `isInScope` then rejected every `www.` link off the homepage as cross_domain,
// the frontier emptied, and a 150-page audit fetched a single page and charged
// for the rest. Nothing in the run said why.
//
// Two independent defences, one per test below:
//   1. the probe sends the crawl's own user agent, the way every other request
//      in the crawl does, so the common cause of the refusal goes away;
//   2. a crawl based on a bare apex keeps that apex's `www.` host in scope, so
//      it recovers from the seed page's own links even when the probe is
//      refused for reasons the crawler cannot fix.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import { SQLiteStorage } from "../src/storage/sqlite";
import { isInScope } from "../src/frontier";
import type { RedirectChain, ResponseHeaders, SecurityHeaders } from "../src/storage/types";

const APEX = "https://example.com";
const WWW = "https://www.example.com";

const EMPTY_RESPONSE_HEADERS: ResponseHeaders = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  expires: null,
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
};

const EMPTY_SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function redirectChain(sourceUrl: string, finalUrl: string): RedirectChain {
  return {
    sourceUrl,
    finalUrl,
    hops: [],
    chainLength: sourceUrl === finalUrl ? 0 : 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

interface Page {
  body: string;
  /** Where the fetch actually landed, when the origin redirected. */
  finalUrl?: string;
}

/**
 * The page-fetch seam. Deliberately NOT the preamble: the seed-redirect probe,
 * robots.txt and the AX sweep all go through `globalThis.fetch`, which the
 * tests stub separately so the two vantages can disagree — which is the whole
 * failure being reproduced.
 */
function buildFetcher(site: Record<string, Page>, fetched: string[]): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      fetched.push(url);
      const page = site[url];
      const status = page ? 200 : 404;
      const body = page?.body ?? "";
      yield* applyStatusGuards(url, status, new Headers(), body);
      const contentType = page ? "text/html" : "text/plain";
      const finalUrl = page?.finalUrl ?? url;
      return {
        url,
        finalUrl,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType, setCookie: null },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType,
        body,
        sizeBytes: body.length,
        redirectChain: redirectChain(url, finalUrl),
      };
    });
}

function linksTo(...urls: string[]): string {
  const anchors = urls.map((u) => `<a href="${u}">link</a>`).join("");
  return `<!doctype html><html><head><title>Home</title></head><body>${anchors}</body></html>`;
}

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 10,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 1000,
  userAgent: "squirrel-test-agent",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: false,
  coverageMode: "full",
};

/** Every URL the preamble asked for, with the user agent it asked under. */
interface ProbeLog {
  url: string;
  userAgent: string | null;
}

let originalFetch: typeof globalThis.fetch;
let probes: ProbeLog[];

/**
 * Stub the preamble's vantage: the apex refuses the probe with the 403 that
 * pinned the base to it in production, and nothing else is there.
 *
 * The SUCCESS path is deliberately not modelled here. `detectRedirects` reads
 * `response.url` to learn where `redirect: "follow"` landed, and a constructed
 * `Response` always reports that as empty, so a stub can only ever look like an
 * origin that did not redirect. Successful seed adoption runs against real
 * servers in seed-redirect-pinning.test.ts.
 */
function stubRefusedPreamble(): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    probes.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });

    if (url === `${APEX}/`) {
      // A WAF refusal: readable, HTML, and carrying no redirect whatsoever.
      return Promise.resolve(
        new Response("<html><body>Access denied</body></html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  probes = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CrawlResult {
  /** URLs the crawl ASKED for. An attempt, not an outcome. */
  fetched: string[];
  /** URLs the crawl came away with a stored 200 page for. */
  stored: string[];
}

async function crawl(site: Record<string, Page>): Promise<CrawlResult> {
  const fetched: string[] = [];
  const fetcher = buildFetcher(site, fetched);
  const storage = new SQLiteStorage(":memory:");
  const stored = await Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ fetcher, storage, config: CONFIG });
      const crawlId = yield* crawler.start(`${APEX}/`, `${APEX}/`);
      const pages = yield* storage.getPages(crawlId);
      return pages.filter((page) => page.status === 200).map((page) => page.normalizedUrl);
    }),
  );
  return { fetched, stored };
}

describe("seed probe refused (#1899)", () => {
  test("the crawl still reaches the www pages the homepage links to", async () => {
    stubRefusedPreamble();
    const site: Record<string, Page> = {
      // The page fetch uses the crawl's own user agent and its retry stack, so
      // it gets through where the bare preamble probe did not — and it lands on
      // www, which is where the apex was redirecting all along.
      [`${APEX}/`]: { body: linksTo(`${WWW}/a`, `${WWW}/b`), finalUrl: `${WWW}/` },
      [`${WWW}/a`]: { body: linksTo() },
      [`${WWW}/b`]: { body: linksTo() },
    };

    const { stored } = await crawl(site);

    // Asserted on STORED pages, not on fetch attempts: a crawl that requests a
    // URL and then discards it is the same one-page audit from the report's
    // point of view, and would pass an attempts-only assertion.
    expect(stored).toContain(`${WWW}/a`);
    expect(stored).toContain(`${WWW}/b`);
    // The regression this pins: one page audited, a 150-page audit charged.
    expect(stored.length).toBe(3);
  });

  test("the seed probe identifies itself with the crawl's user agent", async () => {
    stubRefusedPreamble();
    await crawl({ [`${APEX}/`]: { body: linksTo(), finalUrl: `${WWW}/` } });

    // The FIRST request of the crawl, specifically: seed resolution opens the
    // preamble, and the root probes that follow already send the crawl's agent.
    // Asserting on "some request for the seed URL" would be satisfied by one of
    // those and pass against the bug.
    expect(probes[0]?.url).toBe(`${APEX}/`);
    expect(probes[0]?.userAgent).toBe("squirrel-test-agent");
  });
});

describe("apex/www scope (#1899)", () => {
  const scope = { include: [], exclude: [], allowedDomains: [] };

  test("a crawl based on the apex keeps its www host in scope", () => {
    expect(isInScope(`${WWW}/a`, { ...scope, baseUrl: APEX }).allowed).toBe(true);
  });

  test("the apex's own paths stay in scope", () => {
    expect(isInScope(`${APEX}/a`, { ...scope, baseUrl: APEX }).allowed).toBe(true);
  });

  test("a different subdomain is still cross_domain", () => {
    const decision = isInScope(`https://blog.example.com/a`, { ...scope, baseUrl: APEX });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cross_domain");
  });

  test("a crawl based on www does NOT pull in the apex", () => {
    // One direction only. The apex redirects to www on these sites, so adopting
    // it back would re-crawl every page through a redirect for nothing.
    const decision = isInScope(`${APEX}/a`, { ...scope, baseUrl: WWW });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cross_domain");
  });

  test("a lookalike host that merely starts with the base is still refused", () => {
    const decision = isInScope("https://wwwexample.com/a", { ...scope, baseUrl: APEX });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cross_domain");
  });

  test("a base that is a subdomain does NOT get its own www host", () => {
    // "does not start with www." is not the same test as "is the apex":
    // www.shop.example.com is a different service, not this base's www half.
    const decision = isInScope("https://www.shop.example.com/a", {
      ...scope,
      baseUrl: "https://shop.example.com",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cross_domain");
  });

  test("the port travels with the host", () => {
    expect(
      isInScope("https://www.example.com:8443/a", { ...scope, baseUrl: "https://example.com:8443" })
        .allowed,
    ).toBe(true);
    expect(
      isInScope("https://www.example.com/a", { ...scope, baseUrl: "https://example.com:8443" })
        .allowed,
    ).toBe(false);
  });

  test("case is normalized by the URL parser, so an uppercase host still matches", () => {
    expect(isInScope("https://WWW.EXAMPLE.COM/a", { ...scope, baseUrl: APEX }).allowed).toBe(true);
  });

  test("a base that is a public suffix is not an apex", () => {
    // pages.dev is a private suffix: www.pages.dev is another tenant, not this
    // base's www half. registrableDomain()'s fallback would call it its own
    // apex, which is why the check reads tldts directly.
    const decision = isInScope("https://www.pages.dev/a", {
      ...scope,
      baseUrl: "https://pages.dev",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cross_domain");
  });

  test("a host with no registrable domain is not an apex", () => {
    // An IP literal needs no case of its own: `www.192.0.2.1` is not a URL any
    // parser will produce, so such a candidate never reaches the scope check.
    for (const baseUrl of ["http://localhost:3000", "https://co.uk"]) {
      const base = new URL(baseUrl);
      const decision = isInScope(`${base.protocol}//www.${base.host}/a`, { ...scope, baseUrl });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("cross_domain");
    }
  });

  test("an explicit allowedDomains list still decides on its own", () => {
    // The apex/www rule is the LAST resort, reached only when no include list
    // and no allowedDomains were configured. A caller that named its domains
    // gets exactly those.
    const decision = isInScope(`${WWW}/a`, {
      ...scope,
      allowedDomains: ["other.test"],
      baseUrl: APEX,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cross_domain");
  });
});
