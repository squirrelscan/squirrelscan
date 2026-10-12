// squirrelscan/squirrelscan#670: the walk probes eight common sitemap
// locations on every site. A catch-all (or soft-404) server answers 200 with a
// web page for every path, and each of those pages used to be stored as a
// sitemap that failed with `Unknown sitemap format`: sitemap errors the site
// never published. A page at a location the walk only guessed now means no
// sitemap lives there. Where the site CLAIMED a sitemap (a robots.txt line, an
// index entry), an HTML answer is still a defect, with a message saying what
// came back.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { gzipSync } from "node:zlib";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";

import { SITEMAP_HTML_PAGE_ERROR, decodeSitemapBody, discoverSitemaps } from "../src/sitemaps";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const HTML_TYPE = { "Content-Type": "text/html; charset=utf-8" };
const XML_TYPE = { "Content-Type": "application/xml" };
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Welcome</h1></body></html>';

const COMMON_LOCATIONS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemaps.xml",
  "/sitemap1.xml",
  "/post-sitemap.xml",
  "/page-sitemap.xml",
  "/news-sitemap.xml",
];

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

type Route = { body: string; headers: Record<string, string>; status?: number };

/** A catch-all origin: `routes` where given, the same 200 web page everywhere else. */
function catchAll(routes: (base: string) => Record<string, Route> = () => ({})): string {
  let table: Record<string, Route> = {};
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const route = table[new URL(req.url).pathname] ?? { body: PAGE, headers: HTML_TYPE };
      return new Response(route.body, { headers: route.headers, status: route.status });
    },
  });
  servers.push(server);
  const base = `http://localhost:${server.port}`;
  table = routes(base);
  return base;
}

function urlset(...locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${NS}">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;
}

function robots(origin: string, ...sitemaps: string[]): RobotsTxtData {
  return {
    exists: true,
    url: `${origin}/robots.txt`,
    content: "",
    sizeBytes: 0,
    sitemaps,
    rules: [],
    errors: [],
  };
}

async function discover(origin: string, robotsTxt: RobotsTxtData | null = null) {
  return Effect.runPromise(discoverSitemaps(origin, robotsTxt, "squirrel-test"));
}

describe("guessed sitemap locations on a catch-all server (#670)", () => {
  test("every guessed location answering with a web page means no sitemap, not eight broken ones", async () => {
    const origin = catchAll();

    const result = await discover(origin, robots(origin));

    expect(result.all).toEqual([]);
    expect(result.discovered).toEqual([]);
    expect(result.truncated).toBe(false);
    // Recorded as guesses that found nothing, which no rule reports.
    expect(result.failed).toHaveLength(COMMON_LOCATIONS.length);
    expect(result.failed.every((f) => f.source === "common" && f.error === SITEMAP_HTML_PAGE_ERROR)).toBe(
      true,
    );
  });

  test("a sitemap DECLARED in robots.txt that returns a web page still fails, saying what came back", async () => {
    const origin = catchAll();

    const result = await discover(origin, robots(origin, `${origin}/site-map.xml`));

    expect(result.all.map((sitemap) => [sitemap.url, sitemap.errors])).toEqual([
      [`${origin}/site-map.xml`, [SITEMAP_HTML_PAGE_ERROR]],
    ]);
    expect(result.discovered.map((sitemap) => sitemap.url)).toEqual([`${origin}/site-map.xml`]);
  });

  test("a declared sitemap that redirects to a web page is still the declared one", async () => {
    // The walk records a result under the URL it requested, not where the
    // redirect landed, so the claim still matches.
    const origin = catchAll(() => ({
      "/old-sitemap.xml": { body: "", headers: { location: "/" }, status: 301 },
    }));

    const result = await discover(origin, robots(origin, `${origin}/old-sitemap.xml`));

    expect(result.all.map((sitemap) => [sitemap.url, sitemap.errors])).toEqual([
      [`${origin}/old-sitemap.xml`, [SITEMAP_HTML_PAGE_ERROR]],
    ]);
  });

  test("a declared sitemap at a common location keeps its error too", async () => {
    const origin = catchAll();

    const result = await discover(origin, robots(origin, `${origin}/sitemap.xml`));

    expect(result.all.map((sitemap) => [sitemap.url, sitemap.errors])).toEqual([
      [`${origin}/sitemap.xml`, [SITEMAP_HTML_PAGE_ERROR]],
    ]);
  });

  test("a real sitemap at a guessed location is still parsed and validated", async () => {
    const origin = catchAll((base) => ({
      "/sitemap_index.xml": { body: urlset(`${base}/`, `${base}/about`), headers: XML_TYPE },
    }));

    const result = await discover(origin);

    expect(result.discovered.map((sitemap) => [sitemap.url, sitemap.errors, sitemap.urlCount])).toEqual([
      [`${origin}/sitemap_index.xml`, [], 2],
    ]);
    expect(result.all).toHaveLength(1);
  });

  test("a guessed location that is ALSO an index's child is a claimed sitemap", async () => {
    // The index lists /post-sitemap.xml, which the walk had already fetched as a
    // guess. The site named it, so its HTML answer is reported.
    const origin = catchAll((base) => ({
      "/sitemap.xml": {
        body: `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="${NS}"><sitemap><loc>${base}/post-sitemap.xml</loc></sitemap></sitemapindex>`,
        headers: XML_TYPE,
      },
    }));

    const result = await discover(origin);

    expect(result.all.map((sitemap) => [sitemap.url, sitemap.errors])).toEqual([
      [`${origin}/sitemap.xml`, []],
      [`${origin}/post-sitemap.xml`, [SITEMAP_HTML_PAGE_ERROR]],
    ]);
  });

  test("a broken XML sitemap at a guessed location is still reported", async () => {
    // XML that is not a sitemap is something the site put there; only a web
    // page or a body that is not XML at all is ruled out.
    const origin = catchAll(() => ({
      "/sitemap.xml": { body: '<?xml version="1.0"?><rss><channel/></rss>', headers: XML_TYPE },
    }));

    const result = await discover(origin);

    expect(result.all.map((sitemap) => [sitemap.url, sitemap.errors])).toEqual([
      [`${origin}/sitemap.xml`, ["Unknown sitemap format"]],
    ]);
  });
});

describe("what counts as a web page rather than a sitemap", () => {
  const url = "https://example.com/sitemap.xml";
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("a doctype or <html> opening is a page, whatever the Content-Type says", () => {
    for (const body of [
      PAGE,
      "\n  <!-- served by edge -->\n<HTML><body>x</body></HTML>",
      '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x"><html/>',
    ]) {
      const decoded = decodeSitemapBody(bytes(body), url, "application/xml");
      expect(decoded.notASitemap).toBe(true);
      expect(decoded.data.errors).toEqual([SITEMAP_HTML_PAGE_ERROR]);
    }
  });

  test("a fragment served as text/html is a page", () => {
    const decoded = decodeSitemapBody(bytes("<div>Not found</div>"), url, "text/html; charset=utf-8");
    expect(decoded.notASitemap).toBe(true);
    expect(decoded.data.errors).toEqual([SITEMAP_HTML_PAGE_ERROR]);
  });

  test("a body that is not XML at all is not a sitemap", () => {
    const decoded = decodeSitemapBody(bytes('{"error":"not found"}'), url, "application/json");
    expect(decoded.notASitemap).toBe(true);
  });

  test("a valid sitemap served as text/html is still a sitemap", () => {
    const decoded = decodeSitemapBody(bytes(urlset("https://example.com/")), url, "text/html");
    expect(decoded.notASitemap).toBeUndefined();
    expect(decoded.data.errors).toEqual([]);
    expect(decoded.data.urlCount).toBe(1);
  });

  test("a sitemap root with a broken entry is a broken sitemap, not a page, whatever the Content-Type", () => {
    // A bare-number lastmod reaches the extractor as a number and fails there.
    const entry = `<urlset xmlns="${NS}"><url><loc>https://example.com/</loc><lastmod>2024</lastmod></url></urlset>`;
    for (const body of [
      `<?xml version="1.0"?>${entry}`,
      `<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY a "x>y">]>\n${entry}`,
      `<!DOCTYPE urlset [<!-- ] > --><?pi ] > ?>]>${entry}`,
    ]) {
      const decoded = decodeSitemapBody(bytes(body), url, "text/html");
      expect(decoded.notASitemap).toBeUndefined();
      expect(decoded.data.errors[0]?.startsWith("Parse error: ")).toBe(true);
    }
  });

  test("a gzip-compressed page is a page too", () => {
    const decoded = decodeSitemapBody(gzipSync(PAGE), url, "application/gzip");
    expect(decoded.notASitemap).toBe(true);
    expect(decoded.data.errors).toEqual([SITEMAP_HTML_PAGE_ERROR]);
  });

  test("an opening comment of any length is skipped", () => {
    const decoded = decodeSitemapBody(bytes(`<!--${"x".repeat(10_000)}--><html><body>x</body></html>`), url, "application/xml");
    expect(decoded.notASitemap).toBe(true);
  });

  test("many opening comments are read in linear time", () => {
    // A backtracking pattern over repeated comments took seconds here.
    const started = performance.now();
    const decoded = decodeSitemapBody(bytes(`${"<!--x-->".repeat(5_000)}${urlset("https://example.com/")}`), url, "application/xml");
    expect(decoded.data.urlCount).toBe(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
