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
let scriptSeen = 0;
const COLLECTION_BASE = BASE.replace(
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  (m) => (scriptSeen++ < 6 ? m : ""),
);

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

const server = Bun.serve({
  port: wantPort,
  // generous: the crawler may open many sockets
  idleTimeout: 60,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (reqLogPath) {
      reqCount++;
      reqLog.push(`${Date.now() - t0}\t${req.method}\t${p}\t${req.headers.get("accept") ?? ""}`);
    }
    const html = (body: string) =>
      new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" },
      });

    if (p === "/robots.txt") {
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (p === "/sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
        { length: SM_COUNT },
        (_, s) => `<sitemap><loc>${url.origin}/sitemap-${s}.xml</loc></sitemap>`,
      ).join("")}</sitemapindex>`;
      return new Response(body, { headers: { "content-type": "application/xml" } });
    }
    const sm = p.match(/^\/sitemap-(\d+)\.xml$/);
    if (sm) {
      const s = Number(sm[1]);
      const start = s * SM_CHUNK;
      const end = Math.min(N, start + SM_CHUNK);
      const urls: string[] = [];
      for (let i = start; i < end; i++) urls.push(`<url><loc>${url.origin}/p/${i}</loc></url>`);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    }
    if (p === "/" || p === "/index.html") return html(seedPage());

    const hub = p.match(/^\/hub\/(\d+)$/);
    if (hub) {
      const h = Number(hub[1]);
      if (h < 0 || h >= HUBS) return new Response("Not found", { status: 404 });
      return html(hubPage(h));
    }
    const m = p.match(/^\/p\/(\d+)$/);
    if (m) {
      const i = Number(m[1]);
      if (i < 0 || i >= N) return new Response("Not found", { status: 404 });
      return html(render(i));
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
