// Build a crawl DB from a SAVED REAL PAGE (#1860).
//
// The synthetic fixture was wrong about the thing that matters. A real
// drscholls page is 959 KB of html with 1051 DOM nodes and 5 KB of visible
// text — almost all of it inline script. The synthetic one was 983 KB with
// 18,917 nodes. Those are opposite shapes, and the retention census run on the
// synthetic one reported 96 KB/page retained where production measured ~8 MB.
//
//   bun run scripts/build-real-fixture.ts --page /path/page.html --db /tmp/real.sqlite --pages 150

import { SQLiteStorage } from "@squirrelscan/crawler";
import { parseHtmlForRules } from "../src/adapter";
import { Effect } from "effect";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const PAGE = arg("page", "");
const DB = arg("db", "/tmp/real-fixture.sqlite");
const N = Number.parseInt(arg("pages", "150"), 10);
// The crawler stores parsedData (JSON of the extracted scalars) for every page,
// and buildSiteContext reuses it instead of re-extracting. That path matters for
// memory: JSON.parse produces FRESH strings, where a re-extract produces strings
// that share the page's html buffer. A fixture with parsedData null therefore
// measures a path production does not take. `--no-parsed-data` keeps the old
// behaviour so the two can be compared.
const STORE_PARSED = !process.argv.includes("--no-parsed-data");
const BASE = "https://www.drscholls.com";

const base = await Bun.file(PAGE).text();

/** What the crawler persists: the parsed scalars, minus the live document. */
function serializeParsed(html: string, url: string): string {
  const parsed = parseHtmlForRules(html, url) as unknown as Record<string, unknown>;
  const { document: _document, ...rest } = parsed;
  return JSON.stringify(rest);
}

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawlId = await run(
  storage.createCrawl({
    baseUrl: BASE,
    seedUrl: BASE,
    originalUrl: BASE,
    startedAt: Date.now(),
    status: "completed",
    config: {},
    stats: {
      pagesTotal: N, pagesFetched: N, pagesFailed: 0, pagesSkipped: 0,
      pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0,
    },
  } as never),
);

for (let i = 0; i < N; i++) {
  // Same per-page variation the live repro server applies: a distinct title and
  // a nav of internal links, so link-graph and duplicate rules see a real site
  // rather than N copies of one page.
  const links = Array.from(
    { length: 40 },
    (_, k) => `<a href="/p/${(i * 7 + k * 13) % N}">Product ${(i * 7 + k * 13) % N}</a>`,
  ).join("\n");
  const html = base
    .replace(/<title>[^<]*<\/title>/, `<title>Page ${i} Dr Scholls</title>`)
    .replace("</body>", `<nav id="syn">${links}</nav></body>`);
  const url = i === 0 ? `${BASE}/` : `${BASE}/p/${String(i).padStart(4, "0")}`;
  await run(
    storage.upsertPage(crawlId, {
      url,
      normalizedUrl: url,
      finalUrl: url,
      depth: i === 0 ? 0 : 1,
      status: 200,
      contentType: "text/html",
      sizeBytes: Buffer.byteLength(html, "utf8"),
      loadTimeMs: 120,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: `real-${i}`,
      html,
      parsedData: STORE_PARSED ? serializeParsed(html, url) : null,
      headers: {
        contentType: "text/html", contentEncoding: "gzip", cacheControl: null, vary: null,
        etag: null, server: "cloudflare", lastModified: null, link: null, serverTiming: null,
        age: null, xCache: null, cfCacheStatus: "HIT", xVercelCache: null, altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null, csp: null, xFrameOptions: null, xContentTypeOptions: null,
        referrerPolicy: null, permissionsPolicy: null, xRobotsTag: null,
      },
    } as never),
  );
}

console.log(`built ${DB}: ${N} pages of ${(base.length / 1024).toFixed(0)} KB real html`);
await run(storage.close());
