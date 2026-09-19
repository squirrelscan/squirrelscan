// squirrelscan/repo#2316: a robots.txt `Sitemap:` line with no scheme.
//
//   Sitemap: worldairops.com/sitemap.xml
//
// resolved with a plain `new URL(value, baseUrl)`, so the crawl fetched
// https://worldairops.com/worldairops.com/sitemap.xml, 404'd, and reported the
// site's own robots.txt as pointing at a dead sitemap. The report stored the
// raw line, which also 400'd the cloud publish (squirrelscan/repo#2308).
//
// Both sides are driven here, in one file, because the failure that produced
// item 4 of the issue was the two DISAGREEING: the crawl fetched one URL and
// the report named another. A test that only drove one side would stay green
// through exactly that.

import type { RobotsTxtData, RobotsTxtRecord } from "@squirrelscan/core-contracts";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { discoverSitemaps } from "@squirrelscan/crawler/sitemaps";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateReportFromStorage } from "../src/adapter";
import {
  buildRobotsData,
  buildV2Report,
  emptyRuleExecutionResult,
  type StreamingReportInput,
} from "../src/report-stream";

const ORIGIN = "https://worldairops.com";

const originalFetch = globalThis.fetch;
let requested: string[] = [];
let headersSeen: Map<string, Record<string, string>> = new Map();

/** Every candidate 404s, so nothing but the requested URLs is under test. */
function stubFetch(body?: (url: string) => string | null): void {
  requested = [];
  headersSeen = new Map();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const raw = init?.headers;
    headersSeen.set(
      url,
      raw instanceof Headers
        ? Object.fromEntries(raw.entries())
        : { ...((raw ?? {}) as Record<string, string>) },
    );
    const content = body?.(url) ?? null;
    if (content === null) return new Response("nope", { status: 404 });
    return new Response(content, { status: 200, headers: { "content-type": "application/xml" } });
  }) as typeof fetch;
}

function urlset(...locs: string[]): string {
  const entries = locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

function robotsTxtData(sitemaps: string[], origin = ORIGIN): RobotsTxtData {
  return {
    exists: true,
    url: `${origin}/robots.txt`,
    content: sitemaps.map((value) => `Sitemap: ${value}`).join("\n"),
    sizeBytes: 0,
    sitemaps,
    rules: [],
    errors: [],
  };
}

function robotsRecord(sitemaps: string[], origin = ORIGIN): RobotsTxtRecord {
  return {
    url: `${origin}/robots.txt`,
    exists: true,
    content: sitemaps.map((value) => `Sitemap: ${value}`).join("\n"),
    sizeBytes: 0,
    sitemaps,
    fetchedAt: 0,
    error: null,
  };
}

/** The URLs the crawl actually requested that are not a common-location probe. */
function declaredFetches(origin = ORIGIN): string[] {
  const common = new Set(
    [
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/sitemap-index.xml",
      "/sitemaps.xml",
      "/sitemap1.xml",
      "/post-sitemap.xml",
      "/page-sitemap.xml",
      "/news-sitemap.xml",
    ].map((path) => new URL(path, origin).toString()),
  );
  return requested.filter((url) => !common.has(url));
}

/**
 * Did the crawl request anything AT this host?
 *
 * Parsed, never prefix-matched. `url.startsWith("https://sitemap.xml")` reads
 * as a host check and is not one: it misses `https://sitemap.xml:443/` and
 * `https://user@sitemap.xml/`, and matches `https://sitemap.xml.evil.test/`.
 * Since the whole point of these assertions is "the crawl never went to a host
 * the audited site does not own", the weaker form would be the wrong test even
 * where it happens to pass.
 */
function requestedHost(host: string): boolean {
  return requested.some((url) => {
    try {
      return new URL(url).host === host;
    } catch {
      return false;
    }
  });
}

/** Did the crawl request anything under one of these schemes? */
function requestedProtocol(...protocols: string[]): boolean {
  return requested.some((url) => {
    try {
      return protocols.includes(new URL(url).protocol);
    } catch {
      return false;
    }
  });
}

async function discover(robotsTxt: RobotsTxtData, origin = ORIGIN) {
  return await Effect.runPromise(
    discoverSitemaps(origin, robotsTxt, "squirrel-test", { maxUrls: 50 }),
  );
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("scheme-less Sitemap line, crawl side (#2316)", () => {
  test("worldairops shape is fetched at the declared HOST, not as a path", async () => {
    stubFetch((url) =>
      url === "https://worldairops.com/sitemap.xml" ? urlset(`${ORIGIN}/a`) : null,
    );

    const result = await discover(robotsTxtData(["worldairops.com/sitemap.xml"]));

    expect(requested).toContain("https://worldairops.com/sitemap.xml");
    expect(requested).not.toContain("https://worldairops.com/worldairops.com/sitemap.xml");
    // The declared line and the common location are the same file, so the walk
    // has exactly one entry point for it.
    expect(declaredFetches()).toEqual([]);
    // AC: no robots.txt-sourced failure that only our own resolution created.
    expect(result.failed.filter((entry) => entry.source === "robots.txt")).toEqual([]);
    expect(result.discovered.map((sitemap) => sitemap.url)).toEqual([
      "https://worldairops.com/sitemap.xml",
    ]);
  });

  test("a declared path that is NOT a common location is still reached", async () => {
    stubFetch((url) =>
      url === "https://worldairops.com/custom/sitemap-index.xml" ? urlset(`${ORIGIN}/b`) : null,
    );

    const result = await discover(robotsTxtData(["worldairops.com/custom/sitemap-index.xml"]));

    expect(declaredFetches()).toEqual(["https://worldairops.com/custom/sitemap-index.xml"]);
    expect(result.all.flatMap((sitemap) => sitemap.urls.map((u) => u.loc))).toEqual([
      "https://worldairops.com/b",
    ]);
  });

  test("a scheme-less line naming ANOTHER host is fetched there, without customHeaders", async () => {
    stubFetch((url) => (url === "https://cdn.example.test/s.xml" ? urlset(`${ORIGIN}/c`) : null));

    await Effect.runPromise(
      discoverSitemaps(ORIGIN, robotsTxtData(["cdn.example.test/s.xml"]), "squirrel-test", {
        maxUrls: 50,
        customHeaders: { "signature-agent": "https://squirrelscan.com" },
      }),
    );

    expect(requested).toContain("https://cdn.example.test/s.xml");
    // #1393: the caller's secret headers are scoped to the audited origin.
    expect(headersSeen.get("https://cdn.example.test/s.xml")).not.toHaveProperty("signature-agent");
    expect(headersSeen.get("https://worldairops.com/sitemap.xml")).toHaveProperty("signature-agent");
  });

  test("a bare filename with a query string stays on the audited origin", async () => {
    await discover(robotsTxtData(["sitemap.xml?offset=100"]));

    // The trap #2315 hit: `sitemap.xml` must never be read as a HOST.
    expect(declaredFetches()).toEqual(["https://worldairops.com/sitemap.xml?offset=100"]);
    expect(requestedHost("sitemap.xml")).toBe(false);
  });

  test("relative declarations resolve against the origin", async () => {
    await discover(robotsTxtData(["/sitemap-news.xml", "nested/sitemap.xml"]));

    expect(declaredFetches()).toEqual([
      "https://worldairops.com/sitemap-news.xml",
      "https://worldairops.com/nested/sitemap.xml",
    ]);
  });

  test("a relative declaration resolves against the ORIGIN, not a deep base path", async () => {
    await discover(robotsTxtData(["sitemap-news.xml"], ORIGIN), `${ORIGIN}/en/docs/`);

    expect(requested).toContain("https://worldairops.com/sitemap-news.xml");
    expect(requested).not.toContain("https://worldairops.com/en/docs/sitemap-news.xml");
  });

  test("unusable values are dropped before any fetch", async () => {
    const result = await discover(
      robotsTxtData([
        "not a url at all",
        "ftp://worldairops.com/s.xml",
        "file:///etc/passwd",
        // A value that declares its own scheme is dropped, never reinterpreted
        // against the base. `new URL("https:/", base)` is the audited site's
        // ROOT, which would be walked as if robots.txt had declared it a
        // sitemap.
        "https:/",
        "",
      ]),
    );

    expect(declaredFetches()).toEqual([]);
    expect(requestedProtocol("ftp:", "file:")).toBe(false);
    expect(requested).not.toContain(`${ORIGIN}/`);
    expect(result.failed.filter((entry) => entry.source === "robots.txt")).toEqual([]);
  });

  test("an absolute declaration keeps its path and query", async () => {
    await discover(robotsTxtData(["https://cdn.example.test/Sitemap_Index.XML?v=2"]));

    expect(declaredFetches()).toEqual(["https://cdn.example.test/Sitemap_Index.XML?v=2"]);
  });

  test("a differently spelled declaration is the SAME entry point as the common location", async () => {
    // Default port and host case are not a second sitemap. Keeping the declared
    // spelling would fetch this file twice, spend the walk's URL budget twice,
    // and on a 404 record one file as failed under two different sources.
    const result = await discover(robotsTxtData(["https://WORLDAIROPS.COM:443/sitemap.xml"]));

    expect(declaredFetches()).toEqual([]);
    expect(requested.filter((url) => url.endsWith("/sitemap.xml"))).toEqual([
      "https://worldairops.com/sitemap.xml",
    ]);
    expect(result.failed.filter((entry) => entry.url.endsWith("/sitemap.xml"))).toHaveLength(1);
  });

  test("a scheme with no authority is dropped, never read as a host", async () => {
    // WHATWG parses both of these as the HOST `sitemap.xml`, a domain the
    // audited site does not own. They are not absolute URLs and are not
    // resolved against the base either.
    await discover(robotsTxtData(["https:sitemap.xml", "https:/sitemap.xml"]));

    expect(requestedHost("sitemap.xml")).toBe(false);
    expect(declaredFetches()).toEqual([]);
  });
});

describe("scheme-less Sitemap line, report side (#2316)", () => {
  test("the stored report fields hold resolved absolute URLs only", () => {
    const data = buildRobotsData(
      robotsRecord([
        "worldairops.com/sitemap.xml",
        "/sitemap-news.xml",
        "https://cdn.example.test/s.xml",
        "not a url at all",
      ]),
    );

    expect(data?.sitemaps).toEqual([
      "https://worldairops.com/sitemap.xml",
      "https://worldairops.com/sitemap-news.xml",
      "https://cdn.example.test/s.xml",
    ]);
    for (const url of data?.sitemaps ?? []) {
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).protocol).toMatch(/^https?:$/);
    }
  });

  test("the repair is reported, not silent", () => {
    const data = buildRobotsData(
      robotsRecord(["worldairops.com/sitemap.xml", "ftp://worldairops.com/s.xml"]),
    );

    expect(data?.errors).toEqual([
      'Sitemap "worldairops.com/sitemap.xml" is missing a scheme; read as https://worldairops.com/sitemap.xml',
      'Sitemap "ftp://worldairops.com/s.xml" is not an absolute http(s) URL; ignored',
    ]);
  });

  test("healthy declarations add no parse problems", () => {
    const data = buildRobotsData(
      robotsRecord(["https://worldairops.com/sitemap.xml", "/sitemap-news.xml"]),
    );

    expect(data?.errors).toEqual([]);
  });

  // The two report fields are separate copies of the same robots.txt lines and
  // used to be filled from different objects, which is how one line ended up
  // named twice with two different URLs. Both assembly paths are driven.
  test("both stored fields carry the resolved URL, in v1 and v2", async () => {
    const storage = new SQLiteStorage(":memory:");
    const streamingInput: StreamingReportInput = {
      ...emptyRuleExecutionResult(),
      tallies: new Map(),
    };

    const { v1, v2 } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawlId = yield* storage.createCrawl({
          baseUrl: ORIGIN,
          originalUrl: ORIGIN,
          startedAt: Date.now(),
          status: "completed",
          config: {} as never,
          stats: {
            pagesTotal: 0,
            pagesFetched: 0,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
        });
        yield* storage.setRobotsTxt(crawlId, robotsRecord(["worldairops.com/sitemap.xml"]));
        return {
          v1: yield* generateReportFromStorage(storage, crawlId, emptyRuleExecutionResult()),
          v2: yield* buildV2Report(storage, crawlId, streamingInput),
        };
      }),
    );

    for (const report of [v1, v2]) {
      expect(report.robotsTxt?.sitemaps).toEqual(["https://worldairops.com/sitemap.xml"]);
      expect(report.sitemaps?.sources.robotsTxt).toEqual([
        "https://worldairops.com/sitemap.xml",
      ]);
    }
  });
});

describe("the crawl and the report agree on one line (#2316)", () => {
  // The two sides that CAN disagree in this repo: what the walk fetched and
  // what the report stores. Both are driven from the same declared values, so a
  // change to the resolver or to either call site breaks this.
  //
  // The API-side publish repair (squirrelscan/repo#2308) lives in the private
  // repo and cannot be imported here, so it is NOT what this test pins. What
  // keeps that side in step is that the report now sends it values it already
  // accepts unchanged: every value below is either serialised http(s) or was
  // dropped before the report was built.
  const declared = [
    "worldairops.com/sitemap.xml",
    "worldairops.com/custom/deep.xml",
    "cdn.example.test/s.xml",
    "cdn.example.test:8443/s.xml",
    "/sitemap-news.xml",
    "sitemap.xml?offset=100",
    "//cdn.example.test/proto-relative.xml",
    "https://worldairops.com/absolute.xml",
    "ftp://worldairops.com/nope.xml",
    "not a url at all",
  ];

  test("every declared value resolves to the same URL on both sides", async () => {
    await discover(robotsTxtData(declared));
    const reported = buildRobotsData(robotsRecord(declared))?.sitemaps ?? [];

    // The crawl's robots-sourced entry points: everything it requested at depth
    // 0 that the report also names, plus nothing the report does not.
    const reportedSet = new Set(reported);
    const requestedSet = new Set(requested);
    for (const url of reportedSet) {
      expect(requestedSet.has(url)).toBe(true);
    }
    expect(reported).toEqual([
      "https://worldairops.com/sitemap.xml",
      "https://worldairops.com/custom/deep.xml",
      "https://cdn.example.test/s.xml",
      "https://cdn.example.test:8443/s.xml",
      "https://worldairops.com/sitemap-news.xml",
      "https://worldairops.com/sitemap.xml?offset=100",
      "https://cdn.example.test/proto-relative.xml",
      "https://worldairops.com/absolute.xml",
    ]);
    // Nothing the report dropped was fetched either.
    expect(requestedProtocol("ftp:")).toBe(false);
    expect(requested.some((url) => url.includes("not%20a%20url"))).toBe(false);
    // ...and nothing the crawl reached is missing from the report.
    expect(declaredFetches().every((url) => reportedSet.has(url))).toBe(true);
  });
});
