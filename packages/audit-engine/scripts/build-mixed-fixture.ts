// A mixed-shape crawl DB for the rules-scaling work (#1910).
//
// Shares follow the corpus #1910 was measured on: 10% script-heavy product,
// 10% collection, 30% docs, 30% blog, 10% listing, 10% thin. Shape matters more
// than raw size for this question — the DOM scanners walk inline script, the
// link rules walk the graph, and the duplicate rules walk titles and
// descriptions — so every page carries 40 internal links spread across the whole
// estate, six images, an external link, and a description that repeats across
// half the corpus so the duplicate rules have real work.
//
//   bun run scripts/build-mixed-fixture.ts --db /tmp/mix400.sqlite --pages 400
//
// `--weight N` scales every template. Weight 1 is ~13 KB mean and weight 5 is
// ~100 KB, which brackets the 128 KB mean of #1910's estate; the scaling
// EXPONENT came out the same at both, which is the point of having the dial.
//
// html is stored in the crawl DB, never in the global content store, so #1908's
// scan-per-insert cannot participate in anything measured on these fixtures.
import { SQLiteStorage } from "@squirrelscan/crawler";
import { parseHtmlForRules } from "../src/adapter";
import { Effect } from "effect";

const run = <A,>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? (process.argv[i + 1] ?? d) : d; };
const DB = arg("db", "");
const N = Number.parseInt(arg("pages", "400"), 10);
const W = Number.parseFloat(arg("weight", "1"));
const BASE = "https://bench.test";

const pad = (s: string, n: number) => s.padEnd(n, " lorem ipsum dolor sit amet consectetur ");
const pathFor = (i: number) => (i === 0 ? "/" : `/p/${String(i).padStart(5, "0")}`);

/** Mixed estate: shares from #1910's corpus, scaled so 2,500 pages is buildable. */
function template(i: number): { kind: string; body: string; title: string } {
  const m = i % 10;
  if (m === 0) {
    // Script-heavy, like the real product pages in #1910's corpus: most of the
    // weight is inline script, which is what the DOM scanners actually walk.
    const scripts = Array.from({ length: Math.max(1, Math.round(20 * W)) }, (_, k) =>
      `<script>var block${k}=${JSON.stringify(`payload ${i}-${k} `.padEnd(2000, "abcdefghij"))};</script>`).join("");
    return { kind: "product", title: `Product ${i} | Bench Store`, body: pad(`<h1>Product ${i}</h1><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Product ${i}","offers":{"@type":"Offer","price":"${10 + (i % 90)}.00","priceCurrency":"USD"}}</script>${scripts}`, Math.round(40_000*W)) };
  }
  if (m === 1) return { kind: "collection", title: `Collection ${i} | Bench Store`, body: pad(`<h1>Collection ${i}</h1>`, Math.round(16_000*W)) };
  if (m < 4) return { kind: "docs", title: `Docs page ${i}`, body: pad(`<h1>Docs ${i}</h1><h2>Section</h2>`, Math.round(12_000*W)) };
  if (m < 7) return { kind: "blog", title: `Blog post ${i}`, body: pad(`<h1>Post ${i}</h1><article>text</article>`, Math.round(10_000*W)) };
  if (m < 9) return { kind: "listing", title: `Listing ${i}`, body: pad(`<h1>Listing ${i}</h1>`, Math.round(6_000*W)) };
  // Deliberate duplicates: title/description rules are among the suspects.
  return { kind: "thin", title: "Thin page", body: `<h1>Thin</h1><p>short</p>` };
}

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawlId = await run(storage.createCrawl({ baseUrl: BASE, seedUrl: BASE, originalUrl: BASE, startedAt: Date.now(), status: "completed", config: {}, stats: { pagesTotal: N, pagesFetched: N, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0 } } as never));

for (let i = 0; i < N; i++) {
  const t = template(i);
  const links = Array.from({ length: 40 }, (_, k) => `<a href="${pathFor((i * 7 + k * 13) % N)}">Link ${(i * 7 + k * 13) % N}</a>`).join("");
  const imgs = Array.from({ length: 6 }, (_, k) => `<img src="/img/${i}/${k}.jpg" alt="Image ${k} for ${i}">`).join("");
  const ext = `<a href="https://partner-${i % 50}.example.com/r">Partner</a>`;
  const html = `<!doctype html><html lang="en"><head><title>${t.title}</title><meta name="description" content="Description for ${t.kind} ${i % (N / 2 || 1)}"><link rel="canonical" href="${BASE}${pathFor(i)}"></head><body>${t.body}<nav>${links}</nav>${imgs}${ext}</body></html>`;
  const url = `${BASE}${pathFor(i)}`;
  const parsed = parseHtmlForRules(html, url) as unknown as Record<string, unknown>;
  const { document: _d, ...rest } = parsed;
  await run(storage.upsertPage(crawlId, { url, normalizedUrl: url, finalUrl: url, depth: i === 0 ? 0 : 1, status: 200, contentType: "text/html", sizeBytes: Buffer.byteLength(html, "utf8"), loadTimeMs: 100, fetchedAt: Date.now(), etag: null, lastModified: null, contentHash: `mix-${i}`, html, parsedData: JSON.stringify(rest), headers: { contentType: "text/html", contentEncoding: null, cacheControl: null, vary: null, etag: null, server: "bench", lastModified: null, link: null, serverTiming: null, age: null, xCache: null, cfCacheStatus: null, xVercelCache: null, altSvc: null, acceptRanges: null }, securityHeaders: { hsts: null, csp: null, xFrameOptions: null, xContentTypeOptions: null, referrerPolicy: null, permissionsPolicy: null, xRobotsTag: null } } as never));
}
console.log(`built ${DB}: ${N} mixed pages`);
await run(storage.close());
