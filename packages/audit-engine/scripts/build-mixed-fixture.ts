// A mixed-shape crawl DB for the rules-scaling work (#1910).
//
// A NEGATIVE result is only as good as its corpus, and this fixture exists to
// support one — "the rules phases are not superlinear in page count" — so what
// it does NOT contain is as important as what it does. Each of these is here
// because a uniform corpus lets a rule take an early exit and then report a flat
// line that says nothing:
//
//   - LINK DENSITY VARIES and some pages are unreachable. A corpus where every
//     page has exactly N inbound links never enters orphan detection's hidden-page
//     analysis, and hubs are where a link-graph rule's cost concentrates.
//   - SCHEMA IS ON MORE THAN ONE TEMPLATE. `schema/coverage-outlier` groups by
//     page type and excludes `unknown`, so a corpus where 90% of pages are
//     unknown never builds a group large enough to compare.
//   - INDEXABILITY AND CANONICALS VARY. All-self-canonical, all-indexable pages
//     skip the canonical-drift, noindex-conflict and sitemap-conflict paths.
//   - SOME PAGES FAIL. 4xx pages are what broken-link and error-page rules read.
//   - TITLES AND DESCRIPTIONS REPEAT in more than one distribution: a few large
//     duplicate groups and a long tail of pairs.
//   - THERE IS A SHARED THEME, AND A MINORITY THAT DIVERGES FROM IT. This one
//     matters more than it looks. `integrity/template-discontinuity` compares
//     each page's fingerprint — asset hosts, stylesheet hrefs, body classes,
//     nav/footer presence — against a site baseline, and gives up immediately if
//     no baseline exists. A corpus where every page is identically themed
//     produces no outliers and never reaches the branch that costs anything, and
//     on the v1 path that branch does a linear scan of the page set PER OUTLIER.
//     A fixed share of divergent pages is what makes that term visible.
//
// It still is not a real estate. It has no redirect chains, no sitemap records,
// no fetched sub-resources and no cross-origin variety, so any rule whose cost
// lives in those is untested here and this fixture cannot speak for it.
//
//   bun run scripts/build-mixed-fixture.ts --db /tmp/mix400.sqlite --pages 400
//
// `--weight N` scales the text and script payload of every template. The script
// prints the resulting mean page size rather than asserting one, because the
// mean is a consequence of the template mix and the weight, and quoting a
// remembered number is how a fixture comment goes stale.

import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { parseHtmlForRules } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const N = Number.parseInt(arg("pages", "400"), 10);
const WEIGHT = Number.parseFloat(arg("weight", "1"));
const BASE = "https://bench.test";

const pad = (s: string, n: number) => s.padEnd(Math.max(s.length, n), " lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ");
const pathFor = (i: number) => (i === 0 ? "/" : `/p/${String(i).padStart(5, "0")}`);
const scale = (n: number) => Math.round(n * WEIGHT);

/**
 * Template shares, asserted by construction rather than by a comment: the
 * cumulative table IS the distribution, so it cannot drift from the prose.
 */
const TEMPLATES = [
  { kind: "product", share: 10 },
  { kind: "collection", share: 10 },
  { kind: "docs", share: 30 },
  { kind: "blog", share: 30 },
  { kind: "listing", share: 10 },
  { kind: "thin", share: 10 },
] as const;

function kindFor(i: number): (typeof TEMPLATES)[number]["kind"] {
  const bucket = i % 100;
  let acc = 0;
  for (const t of TEMPLATES) {
    acc += t.share;
    if (bucket < acc) return t.kind;
  }
  return "thin";
}

interface Page {
  title: string;
  description: string;
  body: string;
  status: number;
  noindex: boolean;
  canonical: string;
  outLinks: number;
}

/**
 * The site's shared theme, and the minority that diverges from it.
 *
 * `DIVERGENT_IN` of every that-many pages carry a different asset host, a
 * different stylesheet and different body classes, which is what makes them
 * outliers against the baseline the other pages establish.
 */
const DIVERGENT_IN = 10;
const isDivergent = (i: number) => i % DIVERGENT_IN === 3;

interface Theme {
  head: string;
  bodyClass: string;
  footer: string;
  /** Wrapper for the internal links. `<nav>` is itself a fingerprint signal. */
  navTag: string;
  imageHost: string;
}

/**
 * Divergence has to beat the rule's own similarity threshold, not just look
 * different. `similarityToBaseline` is a weighted Jaccard over stylesheet
 * hrefs (0.35), asset hosts (0.25), body classes (0.15), CSS variables (0.10)
 * and nav/footer presence (0.15), and the default threshold is 0.2. A first
 * attempt at this scored 0.258 and produced ZERO outliers:
 *
 *   - the divergent pages still resolved `bench.test` from their canonical link
 *     and their relative image srcs, so host Jaccard was 1/3 rather than near 0;
 *   - both sides had NO css variables, and Jaccard of two empty sets is 1, so
 *     that term paid full weight to similarity;
 *   - both sides had a `<nav>`, so half the chrome term matched.
 *
 * So the baseline declares CSS variables, the divergent pages spread their
 * assets over three foreign hosts, and they wrap their links in a div. That
 * scores about 0.05 and the outliers are real.
 */
function theme(i: number): Theme {
  if (isDivergent(i)) {
    return {
      head:
        `<link rel="stylesheet" href="https://css.other-cdn.test/legacy-${i % 3}.css">` +
        `<script src="https://js.other-cdn.test/legacy.js"></script>`,
      bodyClass: `legacy-page variant-${i % 3}`,
      footer: "",
      navTag: "div",
      imageHost: "https://img.other-cdn.test",
    };
  }
  return {
    head:
      `<link rel="stylesheet" href="https://cdn.bench.test/theme.css">` +
      `<link rel="stylesheet" href="https://cdn.bench.test/layout.css">` +
      `<script src="https://cdn.bench.test/app.js"></script>` +
      `<style>:root{--brand-color:#123456;--brand-space:8px;--brand-font:sans-serif;}</style>`,
    bodyClass: "theme-main site-page",
    footer: `<footer class="site-footer"><a href="/">Home</a><p>Bench Store</p></footer>`,
    navTag: "nav",
    imageHost: "",
  };
}

function build(i: number): Page {
  const kind = kindFor(i);
  const self = `${BASE}${pathFor(i)}`;
  // Structural variety, each one gating a rule path a uniform corpus skips.
  const status = i % 97 === 5 ? 404 : 200;
  const noindex = i % 23 === 3;
  // A tenth of pages point their canonical at another page, which is what the
  // canonical-drift and sitemap-conflict rules actually look for.
  const canonical = i % 11 === 4 ? `${BASE}${pathFor((i + 1) % N)}` : self;
  // Hubs, ordinary pages and a tail of pages nothing links to. Link COUNT and
  // link TARGETS both vary, so the graph has a real degree distribution.
  const outLinks = i % 50 === 0 ? 120 : i % 7 === 0 ? 4 : 40;

  const schema = (type: string, extra: string) =>
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"${type}","name":"${kind} ${i}"${extra}}</script>`;

  switch (kind) {
    case "product": {
      // Script-heavy, like the product pages in #1910's estate: most of the
      // weight is inline script, which is what the DOM scanners walk.
      const scripts = Array.from(
        { length: Math.max(1, scale(20)) },
        (_, k) => `<script>var b${k}=${JSON.stringify(`payload ${i}-${k} `.padEnd(2000, "abcdefghij"))};</script>`,
      ).join("");
      return {
        title: `Product ${i} | Bench Store`,
        description: `Buy product ${i % Math.max(1, Math.floor(N / 2))} at Bench Store`,
        body: pad(`<h1>Product ${i}</h1>${schema("Product", `,"offers":{"@type":"Offer","price":"${10 + (i % 90)}.00","priceCurrency":"USD"}`)}${scripts}`, scale(20_000)),
        status, noindex, canonical, outLinks,
      };
    }
    case "collection":
      return {
        title: `Collection ${i} | Bench Store`,
        description: `Shop the ${i % 40} collection`,
        body: pad(`<h1>Collection ${i}</h1>${schema("CollectionPage", "")}`, scale(16_000)),
        status, noindex, canonical, outLinks,
      };
    case "docs":
      return {
        title: `Docs page ${i}`,
        description: `Reference documentation for topic ${i % Math.max(1, Math.floor(N / 2))}`,
        body: pad(`<h1>Docs ${i}</h1><h2>Section</h2><h3>Detail</h3>${schema("TechArticle", "")}`, scale(12_000)),
        status, noindex, canonical, outLinks,
      };
    case "blog":
      return {
        title: `Blog post ${i}`,
        description: `Post ${i % Math.max(1, Math.floor(N / 2))} on the Bench blog`,
        body: pad(`<h1>Post ${i}</h1><article>text</article>${schema("BlogPosting", `,"datePublished":"2026-0${1 + (i % 9)}-01"`)}`, scale(10_000)),
        status, noindex, canonical, outLinks,
      };
    case "listing":
      return {
        title: `Listing ${i}`,
        description: `Listing page ${i % 25}`,
        body: pad(`<h1>Listing ${i}</h1>`, scale(6_000)),
        status, noindex, canonical, outLinks,
      };
    default:
      // One large duplicate group: 10% of the corpus shares a title AND a
      // description, which is the shape the duplicate rules are sized for.
      return {
        title: "Thin page",
        description: "A thin page with very little content",
        body: `<h1>Thin</h1><p>short</p>`,
        status, noindex, canonical, outLinks: 2,
      };
  }
}

/** Link targets for page i: spread across the estate, skipping the orphan tail. */
function linkTargets(i: number, count: number, orphanFrom: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push((i * 7 + k * 13) % orphanFrom);
  return out;
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

// The last 5% are reachable from the sitemap-shaped seed only, i.e. nothing in
// the link graph points at them. Orphan detection needs pages nobody links to;
// a fully connected corpus never reaches that branch.
const orphanFrom = Math.max(1, Math.floor(N * 0.95));
let totalBytes = 0;

for (let i = 0; i < N; i++) {
  const p = build(i);
  const links = linkTargets(i, p.outLinks, orphanFrom)
    .map((t) => `<a href="${pathFor(t)}">Link ${t}</a>`)
    .join("");
  const t = theme(i);
  const images = Array.from(
    { length: i % 13 === 0 ? 24 : 6 },
    (_, k) => `<img src="${t.imageHost}/img/${i}/${k}.jpg"${k % 5 === 0 ? "" : ` alt="Image ${k} for ${i}"`}>`,
  ).join("");
  const external = `<a href="https://partner-${i % 50}.example.com/r">Partner</a>`;
  const robots = p.noindex ? `<meta name="robots" content="noindex,follow">` : "";
  const html =
    `<!doctype html><html lang="en"><head><title>${p.title}</title>` +
    `<meta name="description" content="${p.description}">` +
    `<link rel="canonical" href="${p.canonical}">${robots}${t.head}</head>` +
    `<body class="${t.bodyClass}">${p.body}<${t.navTag}>${links}</${t.navTag}>` +
    `${images}${external}${t.footer}</body></html>`;
  const url = `${BASE}${pathFor(i)}`;
  totalBytes += Buffer.byteLength(html, "utf8");

  const parsed = parseHtmlForRules(html, url) as unknown as Record<string, unknown>;
  const { document: _document, ...rest } = parsed;
  await run(
    storage.upsertPage(crawlId, {
      url, normalizedUrl: url, finalUrl: url, depth: i === 0 ? 0 : 1,
      status: p.status, contentType: "text/html",
      sizeBytes: Buffer.byteLength(html, "utf8"), loadTimeMs: 100, fetchedAt: Date.now(),
      etag: null, lastModified: null, contentHash: `mix-${i}`, html,
      parsedData: JSON.stringify(rest),
      headers: {
        contentType: "text/html", contentEncoding: null, cacheControl: null, vary: null,
        etag: null, server: "bench", lastModified: null, link: null, serverTiming: null,
        age: null, xCache: null, cfCacheStatus: null, xVercelCache: null, altSvc: null,
        acceptRanges: null,
      },
      securityHeaders: {
        hsts: null, csp: null, xFrameOptions: null, xContentTypeOptions: null,
        referrerPolicy: null, permissionsPolicy: null, xRobotsTag: null,
      },
    } as never),
  );
}

const counts = new Map<string, number>();
for (let i = 0; i < N; i++) counts.set(kindFor(i), (counts.get(kindFor(i)) ?? 0) + 1);
console.log(
  `built ${DB}: ${N} pages, weight ${WEIGHT}, mean ${(totalBytes / N / 1024).toFixed(1)} KB\n` +
    `  mix: ${[...counts].map(([k, v]) => `${k} ${((100 * v) / N).toFixed(0)}%`).join(", ")}\n` +
    `  ${Math.max(0, N - orphanFrom)} pages with no inbound link, ` +
    `${Math.floor(N / 50)} hubs of 120 links, ` +
    `${Math.floor(N / 97)} 4xx, ${Math.floor(N / 23)} noindex, ${Math.floor(N / 11)} off-page canonicals, ` +
    `${Math.floor(N / DIVERGENT_IN)} off-theme`,
);
await run(storage.close());
