/**
 * Mixed-shape synthetic site for the 10k-page CLI benchmark (private #1028).
 *
 * Serves N deterministic pages across 6 templates whose sizes/node counts mimic
 * a real enterprise storefront + docs estate:
 *
 *   template   share   ~size    shape
 *   product     10%    982 KB   REAL saved drscholls page (1150 tags, 825 KB inline script)
 *   collection  10%    120 KB   same page with most inline script stripped (link-dense)
 *   docs        30%     20 KB   prose + code blocks, ~450 tags
 *   blog        30%     20 KB   article markup, ~380 tags
 *   listing     10%     35 KB   index page, 60 outbound links
 *   thin        10%      8 KB   utility page, ~90 tags
 *
 * Every page is byte-unique (page id is woven into title/h1/canonical/body) so
 * the crawler's content_hash store cannot dedupe them and hide storage cost.
 *
 * Link graph guarantees reachability of all N pages from "/": the seed links to
 * every hub, each hub links to a 50-page block, and each page cross-links 40
 * siblings. robots.txt + a sitemap index are served too (enterprise shape).
 *
 * Usage: bun site.ts <base-page.html> <N> [--port P]
 * Prints the chosen port on stdout, then serves until killed.
 */

// Relative into the package source, not the "@squirrelscan/parser" specifier:
// `benchmarks/` is not a workspace member, so under Bun's isolated linker it has
// no node_modules of its own and the bare specifier does not resolve.
import { parseDocument } from "../../packages/parser/src/index.ts";
const basePath = process.argv[2];
const N = Number(process.argv[3] ?? 1000);
const portArgIdx = process.argv.indexOf("--port");
const wantPort = portArgIdx > -1 ? Number(process.argv[portArgIdx + 1]) : 0;
// A salt woven into every page so a stage can be genuinely COLD against
// squirrel's GLOBAL ~/.squirrel/content-store.db (keyed by content hash).
// Same salt on a later run = warm/incremental. Never clear the user's store.
const saltIdx = process.argv.indexOf("--salt");
const SALT = saltIdx > -1 ? String(process.argv[saltIdx + 1]) : "";

const BASE = await Bun.file(basePath).text();
const BLOCK = 50; // pages per hub
const HUBS = Math.max(1, Math.ceil(N / BLOCK));

// ── template mix ────────────────────────────────────────────────
// Deterministic assignment by page id so a given id always renders the same
// template across cold/warm runs.
type Tpl = "product" | "collection" | "docs" | "blog" | "listing" | "thin";
const MIX: Tpl[] = [
  "product",
  "collection",
  "docs",
  "docs",
  "docs",
  "blog",
  "blog",
  "blog",
  "listing",
  "thin",
];
function tplFor(i: number): Tpl {
  // cheap deterministic scatter so templates interleave rather than clump
  return MIX[(i * 7 + ((i / 10) | 0) * 3) % MIX.length]!;
}

// ── collection template: real page with most inline script removed ──
// Parsed with a real HTML parser rather than a regex, so `</script >` variants and
// nested `<script` text cannot leak through (CodeQL js/bad-tag-filter).
const COLLECTION_BASE = (() => {
  const document = parseDocument(BASE);
  const scripts = Array.from(document.querySelectorAll("script"));
  for (const el of scripts.slice(6)) el.remove();
  return document.toString();
})();

// ── light templates, built once, node-dense (not rope-cheap filler) ──
const WORDS =
  "insole arch support cushioning orthotic heel plantar comfort midsole gel foam pressure alignment stability pronation fascia metatarsal shock absorption footbed lining".split(
    " ",
  );
function words(seed: number, n: number): string {
  let s = seed >>> 0;
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push(WORDS[s % WORDS.length]!);
  }
  return out.join(" ");
}

function crossLinks(i: number, count: number): string {
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const t = (i * 7 + k * 13 + 1) % N;
    out.push(`<li><a href="/p/${t}">${WORDS[t % WORDS.length]} guide ${t}</a></li>`);
  }
  return `<ul class="xlinks">${out.join("")}</ul>`;
}

function chrome(i: number, title: string): { head: string; nav: string; foot: string } {
  const hubLinks = Array.from(
    { length: Math.min(HUBS, 24) },
    (_, h) => `<li><a href="/hub/${h}">Section ${h}</a></li>`,
  ).join("");
  return {
    head: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${words(i + 91, 22)}">
<link rel="canonical" href="/p/${i}">`,
    nav: `<header><nav aria-label="Main"><ul>${hubLinks}</ul></nav></header>`,
    foot: `<footer><nav aria-label="Footer"><ul>${Array.from({ length: 12 }, (_, k) => `<li><a href="/p/${(i + k * 977) % N}">More ${(i + k * 977) % N}</a></li>`).join("")}</ul><p>&copy; 2026 Synthetic Estate</p></nav></footer>`,
  };
}

function docsPage(i: number): string {
  const c = chrome(i, `Docs ${i}: ${WORDS[i % WORDS.length]} reference`);
  const sections = Array.from({ length: 10 }, (_, s) => {
    const items = Array.from(
      { length: 6 },
      (_, k) => `<li><code>opt.${WORDS[(i + s + k) % WORDS.length]}</code> &mdash; ${words(i + s * 7 + k, 12)}</li>`,
    ).join("");
    return `<section id="s${s}"><h2>${s + 1}. ${WORDS[(i + s) % WORDS.length]} configuration</h2>
<p>${words(i + s * 31, 45)}</p>
<ul>${items}</ul>
<pre><code>const cfg = { ${WORDS[(i + s) % WORDS.length]}: ${s}, retries: 3, mode: "strict" };
await client.apply(cfg); // ${words(i + s, 6)}</code></pre>
<table><thead><tr><th>Field</th><th>Type</th><th>Default</th></tr></thead><tbody>
${Array.from({ length: 5 }, (_, r) => `<tr><td>${WORDS[(i + r) % WORDS.length]}</td><td>string</td><td><code>none</code></td></tr>`).join("")}
</tbody></table></section>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head>${c.head}</head><body>${c.nav}
<main><h1>Docs ${i}: ${WORDS[i % WORDS.length]} reference</h1>
<p class="lede">${words(i, 60)}</p>
${sections}
${crossLinks(i, 40)}
</main>${c.foot}</body></html>`;
}

function blogPage(i: number): string {
  const c = chrome(i, `${WORDS[i % WORDS.length]} and ${WORDS[(i + 3) % WORDS.length]}: field notes ${i}`);
  const paras = Array.from(
    { length: 22 },
    (_, p) => `<p>${words(i * 13 + p, 55)}</p>`,
  ).join("\n");
  const figs = Array.from(
    { length: 4 },
    (_, f) =>
      `<figure><img src="/img/${(i + f) % 200}.jpg" alt="${words(i + f, 5)}" width="800" height="450"><figcaption>${words(i + f * 3, 10)}</figcaption></figure>`,
  ).join("\n");
  return `<!doctype html><html lang="en"><head>${c.head}
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Field notes ${i}","datePublished":"2026-0${(i % 9) + 1}-1${i % 9}","author":{"@type":"Person","name":"Sam ${i % 40}"}}</script>
</head><body>${c.nav}
<main><article><h1>${WORDS[i % WORDS.length]} and ${WORDS[(i + 3) % WORDS.length]}: field notes ${i}</h1>
<p class="byline">By Sam ${i % 40} &middot; <time datetime="2026-0${(i % 9) + 1}-1${i % 9}">2026</time></p>
${paras}
${figs}
<h2>What we changed</h2><ol>${Array.from({ length: 8 }, (_, k) => `<li>${words(i + k * 5, 14)}</li>`).join("")}</ol>
</article>
${crossLinks(i, 40)}
</main>${c.foot}</body></html>`;
}

function listingPage(i: number): string {
  const c = chrome(i, `Index ${i}: ${WORDS[i % WORDS.length]} collection`);
  const cards = Array.from({ length: 60 }, (_, k) => {
    const t = (i * 11 + k * 7 + 5) % N;
    return `<li class="card"><a href="/p/${t}"><img src="/img/${t % 200}.jpg" alt="${WORDS[t % WORDS.length]} ${t}" width="320" height="320"><h3>${WORDS[t % WORDS.length]} ${t}</h3><p>${words(t, 14)}</p><span class="price">$${20 + (t % 80)}.99</span></a></li>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head>${c.head}</head><body>${c.nav}
<main><h1>Index ${i}: ${WORDS[i % WORDS.length]} collection</h1>
<p>${words(i, 40)}</p>
<ul class="grid">${cards}</ul>
</main>${c.foot}</body></html>`;
}

function thinPage(i: number): string {
  const c = chrome(i, `Note ${i}`);
  return `<!doctype html><html lang="en"><head>${c.head}</head><body>${c.nav}
<main><h1>Note ${i}</h1><p>${words(i, 70)}</p>
<dl>${Array.from({ length: 8 }, (_, k) => `<dt>${WORDS[(i + k) % WORDS.length]}</dt><dd>${words(i + k, 8)}</dd>`).join("")}</dl>
${crossLinks(i, 12)}
</main>${c.foot}</body></html>`;
}

// ── heavy templates derived from the real page ──────────────────
function heavy(base: string, i: number, label: string): string {
  const links = Array.from({ length: 40 }, (_, k) => {
    const t = (i * 7 + k * 13 + 1) % N;
    return `<a href="/p/${t}">${WORDS[t % WORDS.length]} ${t}</a>`;
  }).join("\n");
  const hubLinks = Array.from(
    { length: Math.min(HUBS, 24) },
    (_, h) => `<a href="/hub/${h}">Section ${h}</a>`,
  ).join("\n");
  return base
    .replace(/<title>[^<]*<\/title>/i, `<title>${label} ${i} | Synthetic Estate</title>`)
    .replace(
      /<\/head>/i,
      `<link rel="canonical" href="/p/${i}"><meta name="description" content="${words(i + 5, 20)}"></head>`,
    )
    .replace(
      "</body>",
      `<nav id="syn" aria-label="Related"><h2>Related ${i}</h2>${links}${hubLinks}</nav><p id="synid">sku-${i}-${words(i, 6)}</p></body>`,
    );
}

function hubPage(h: number): string {
  const start = h * BLOCK;
  const items = Array.from({ length: BLOCK }, (_, k) => start + k)
    .filter((t) => t < N)
    .map((t) => `<li><a href="/p/${t}">${WORDS[t % WORDS.length]} ${t}</a></li>`)
    .join("");
  const others = Array.from(
    { length: Math.min(HUBS, 60) },
    (_, o) => `<li><a href="/hub/${o}">Section ${o}</a></li>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Section ${h} | Synthetic Estate</title><link rel="canonical" href="/hub/${h}"><meta name="description" content="Section ${h} of the synthetic estate"></head><body>
<header><nav aria-label="Sections"><ul>${others}</ul></nav></header>
<main><h1>Section ${h}</h1><ul>${items}</ul></main>
<footer><p>&copy; 2026</p></footer></body></html>`;
}

function seedPage(): string {
  const hubs = Array.from(
    { length: HUBS },
    (_, h) => `<li><a href="/hub/${h}">Section ${h}</a></li>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic Estate | ${N} page benchmark site</title><link rel="canonical" href="/"><meta name="description" content="Synthetic enterprise estate with ${N} pages for crawl benchmarking"></head><body>
<header><h1>Synthetic Estate</h1></header>
<main><p>${N} pages across product, collection, docs, blog, listing and note templates.</p>
<nav aria-label="Sections"><ul>${hubs}</ul></nav></main>
<footer><p>&copy; 2026</p></footer></body></html>`;
}

function render(i: number): string {
  let body: string;
  switch (tplFor(i)) {
    case "product":
      body = heavy(BASE, i, "Product");
      break;
    case "collection":
      body = heavy(COLLECTION_BASE, i, "Collection");
      break;
    case "docs":
      body = docsPage(i);
      break;
    case "blog":
      body = blogPage(i);
      break;
    case "listing":
      body = listingPage(i);
      break;
    case "thin":
      body = thinPage(i);
      break;
  }
  if (!SALT) return body;
  // one comment before </body>: changes the content hash, not the DOM shape
  return body.replace("</body>", `<!-- build ${SALT} -->
</body>`);
}

// ── sitemaps (enterprise shape: index + 1000-url children) ──────
const SM_CHUNK = 1000;
const SM_COUNT = Math.ceil(N / SM_CHUNK);

// ── optional request log (BENCH_REQ_LOG=path) ───────────────────
const reqLogPath = process.env.BENCH_REQ_LOG;
const reqLog: string[] = [];
const t0 = Date.now();
let reqCount = 0;
if (reqLogPath) {
  const flush = () => {
    try {
      require("node:fs").writeFileSync(reqLogPath, reqLog.join("\n") + "\n");
    } catch {
      /* best effort */
    }
  };
  process.on("exit", flush);
  process.on("SIGTERM", () => {
    flush();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    flush();
    process.exit(0);
  });
}

// ── HTTP caching: a freshness window plus validators ────────────
// A re-crawl can only reuse what the origin lets it reuse. The estate therefore
// serves both halves of a real cache policy: a short freshness window with a
// long stale-while-revalidate (so a second run minutes later is stale but still
// serveable from store), and an ETag/Last-Modified pair (so a revalidation past
// that window can come back 304). Overridable to measure a different policy.
const CACHE_CONTROL =
  process.env.BENCH_CACHE_CONTROL ?? "public, max-age=60, stale-while-revalidate=86400";

// Last-Modified must be stable across a server RESTART (stages.sh restarts it
// between the cold and warm stage, and a date that moved with the process would
// make every warm revalidation a miss for harness reasons) but must MOVE when
// the fixture's content moves, or a date-only revalidation returns 304 for a
// body that changed. The salt is exactly "which fixture content is this", so
// derive the date from it: same salt, same date; new salt, new date.
const LAST_MODIFIED = (() => {
  const base = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00:00Z
  let h = 2166136261 >>> 0; // FNV-1a over the salt
  for (let i = 0; i < SALT.length; i++) {
    h ^= SALT.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Spread over a day, at second granularity, which is all an HTTP-date carries.
  return new Date(base + (h % 86400) * 1000).toUTCString();
})();
const LAST_MODIFIED_MS = Date.parse(LAST_MODIFIED);

// path -> etag, so a revalidation can be answered without rendering the page.
const etags = new Map<string, string>();

function etagFor(key: string, body: string): string {
  let tag = etags.get(key);
  if (tag === undefined) {
    tag = `"${Bun.hash(body).toString(16)}-${body.length.toString(16)}"`;
    etags.set(key, tag);
  }
  return tag;
}

// An opaque entity-tag may itself contain commas, so If-None-Match cannot be
// split on "," — `"foo,*,bar"` is ONE tag, and splitting it invents a wildcard
// that matches every representation. Pull out the quoted tags instead.
const ENTITY_TAG = /(W\/)?"[^"]*"/g;

/** True when the request already holds this exact representation. */
function clientHasIt(req: Request, tag: string): boolean {
  const inm = req.headers.get("if-none-match");
  if (inm !== null) {
    // "*" is a wildcard only as the WHOLE field value, never inside a tag.
    if (inm.trim() === "*") return true;
    for (const m of inm.matchAll(ENTITY_TAG)) {
      // Weak comparison: W/"x" and "x" match, which is what If-None-Match wants.
      if (m[0].replace(/^W\//, "") === tag) return true;
    }
    // A present but non-matching If-None-Match wins outright; per RFC 9110 the
    // If-Modified-Since below is only consulted when If-None-Match is absent.
    return false;
  }
  const ims = req.headers.get("if-modified-since");
  if (ims === null) return false;
  // Date.parse is lenient enough to accept "2027", which would 304 a page that
  // has no business being fresh. Only an IMF-fixdate counts; anything else is
  // ignored, as an invalid conditional header must be.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(ims.trim())) {
    return false;
  }
  const since = Date.parse(ims);
  return Number.isFinite(since) && since >= LAST_MODIFIED_MS;
}

const server = Bun.serve({
  port: wantPort,
  // generous: the crawler may open many sockets
  idleTimeout: 60,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (reqLogPath) {
      reqCount++;
      // `inm` is what makes a warm stage auditable: a re-crawl that revalidates
      // shows If-None-Match here, one that re-fetches blind shows a bare dash.
      const inm = req.headers.get("if-none-match") ?? "-";
      reqLog.push(
        `${Date.now() - t0}\t${req.method}\t${p}\t${req.headers.get("accept") ?? ""}\t${inm}`,
      );
    }
    // Behind a tunnel or proxy the server is reached over plain HTTP, so
    // `url.origin` is `http://<public host>` while callers arrive on https. The
    // sitemap and robots would then advertise a different scheme from the seed
    // URL and split the crawl across two origins. Trust the forwarded scheme.
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const origin =
      proto === "http" || proto === "https" ? `${proto}://${url.host}` : url.origin;
    const cacheHeaders = { "cache-control": CACHE_CONTROL, "last-modified": LAST_MODIFIED };
    // Conditional requests only mean "you already have this" on a retrieval.
    // Evaluating them on anything else answered POST + `If-None-Match: *` with a
    // 304, which is nonsense for a method that is not asking for the body.
    const conditional = req.method === "GET" || req.method === "HEAD";
    // `build` is lazy so a revalidation we already have an etag for costs no render.
    const html = (key: string, build: () => string) => {
      const known = etags.get(key);
      if (conditional && known !== undefined && clientHasIt(req, known)) {
        return new Response(null, { status: 304, headers: { ...cacheHeaders, etag: known } });
      }
      // Render exactly once: the heavy template is ~1 MB, so building it twice
      // to hash it would double the origin's cost per page.
      const body = build();
      const tag = etagFor(key, body);
      if (conditional && clientHasIt(req, tag)) {
        return new Response(null, { status: 304, headers: { ...cacheHeaders, etag: tag } });
      }
      return new Response(body, {
        headers: { ...cacheHeaders, "content-type": "text/html; charset=utf-8", etag: tag },
      });
    };

    if (p === "/robots.txt") {
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (p === "/sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
        { length: SM_COUNT },
        (_, s) => `<sitemap><loc>${origin}/sitemap-${s}.xml</loc></sitemap>`,
      ).join("")}</sitemapindex>`;
      return new Response(body, { headers: { "content-type": "application/xml" } });
    }
    const sm = p.match(/^\/sitemap-(\d+)\.xml$/);
    if (sm) {
      const s = Number(sm[1]);
      const start = s * SM_CHUNK;
      const end = Math.min(N, start + SM_CHUNK);
      const urls: string[] = [];
      for (let i = start; i < end; i++) urls.push(`<url><loc>${origin}/p/${i}</loc></url>`);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    }
    if (p === "/" || p === "/index.html") return html("/", seedPage);

    const hub = p.match(/^\/hub\/(\d+)$/);
    if (hub) {
      const h = Number(hub[1]);
      if (h < 0 || h >= HUBS) return new Response("Not found", { status: 404 });
      return html(p, () => hubPage(h));
    }
    const m = p.match(/^\/p\/(\d+)$/);
    if (m) {
      const i = Number(m[1]);
      if (i < 0 || i >= N) return new Response("Not found", { status: 404 });
      return html(p, () => render(i));
    }
    // images referenced by templates: tiny, real content-type, cheap
    if (/^\/img\/\d+\.jpg$/.test(p)) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(server.port);
await new Promise(() => {});
