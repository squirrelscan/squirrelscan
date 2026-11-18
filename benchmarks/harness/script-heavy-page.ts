/**
 * Synthetic script-heavy product page: the base page for `script-heavy-site.ts`
 * (squirrelscan/repo#1864).
 *
 * The record in 2026-09-perf-program.md used a real saved drscholls.com product
 * page, which is not committed. This generator builds a page of the same shape,
 * deterministically from a seed, so anyone can reproduce the measurement:
 *
 *   - about 1.15 MB of HTML, of which about 790 KB is inline script
 *   - 59 inline scripts: three large minified bundles, a product JSON blob, a
 *     storefront `meta` object, JSON-LD, a `shopify-features` config, a readable
 *     (unminified) theme script, and about fifty small vendor snippets
 *   - library banners and globals a real storefront ships (jQuery, lodash,
 *     Vue), brand keywords the secret scanner looks around (`segment`,
 *     `twilio`, `cloudflare`, `stripe`), and no credential-shaped value but
 *     the storefront's public `shopify-features` access token
 *   - a header with a long navigation, eleven H1/H2 headings, 440 product
 *     cards, a footer, and a cookie banner
 *
 * Usage: bun script-heavy-page.ts [--seed N] > base.html
 *   then: bun script-heavy-site.ts base.html 150
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

type Rng = () => number;

/** A 32-bit LCG on Math.imul, so the low bits stay random (the bench-leaked-secrets lesson). */
function seeded(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const IDENT = `${LOWER}0123456789_$`;
const WORDS =
  "comfort insole support arch foot heel cushion gel daily walk run work boot shoe sandal pain relief odor fresh plantar fasciitis orthotic memory foam massage extra wide women men kids sport active".split(
    " "
  );
const KEYWORDS = ["segment", "twilio", "cloudflare", "stripe", "klaviyo", "algolia"];

function run(r: Rng, alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}

function words(r: Rng, n: number): string {
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
}

/** Minified-bundle-looking JavaScript of about `bytes` characters, with no credential shapes. */
function minified(r: Rng, bytes: number, banner = ""): string {
  const parts: string[] = [banner, '"use strict";'];
  let size = parts.join("").length;
  let n = 0;
  while (size < bytes) {
    const a = run(r, LOWER, 1) + run(r, IDENT, 1 + Math.floor(r() * 3));
    const b = run(r, LOWER, 1) + run(r, IDENT, 1 + Math.floor(r() * 3));
    const kind = Math.floor(r() * 8);
    let chunk: string;
    if (kind === 0) chunk = `function ${a}(${b},t){return ${b}?t(${b}):null}`;
    else if (kind === 1) chunk = `var ${a}=${b}.exports={};`;
    else if (kind === 2) chunk = `${a}.${b}=function(e){for(var n=0;n<e.length;n++)e[n]&&e[n]()};`;
    else if (kind === 3) chunk = `${a}["${run(r, LOWER, 6)}"]=${Math.floor(r() * 1e6)};`;
    else if (kind === 4) chunk = `if(${a}!==${b}){${a}=${b}.slice(0,${1 + Math.floor(r() * 9)})}`;
    else if (kind === 5) chunk = `${a}.push({id:"${run(r, LOWER, 4)}-${run(r, "0123456789", 3)}",label:"${words(r, 2)}"});`;
    else if (kind === 6) chunk = `${a}.addEventListener("click",function(${b}){${b}.preventDefault();${a}.classList.toggle("is-open")});`;
    else chunk = `${a}=${a}||{};${a}.t=new Date().getTime();`;
    if (++n % 40 === 0) {
      const kw = KEYWORDS[n % KEYWORDS.length]!;
      const form = n % 3;
      chunk += form === 0 ? `/* ${kw} integration */` : form === 1 ? `${a}.provider="${kw}";` : `${a}.${kw}Enabled=!0;`;
    }
    parts.push(chunk);
    size += chunk.length;
  }
  return parts.join("");
}

/** A readable theme script: indentation, comments, long functions. */
function readable(r: Rng, bytes: number): string {
  const out: string[] = ["// Theme scripts", "(function () {", "  'use strict';"];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    const name = `${run(r, LOWER, 6)}Handler${i++}`;
    const block = [
      "",
      `  /**`,
      `   * ${words(r, 8)}`,
      `   */`,
      `  function ${name}(element, options) {`,
      `    var settings = Object.assign({ delay: ${Math.floor(r() * 500)}, label: "${words(r, 2)}" }, options);`,
      `    if (!element) {`,
      `      return null;`,
      `    }`,
      `    element.setAttribute("data-${run(r, LOWER, 5)}", settings.label);`,
      `    window.setTimeout(function () {`,
      `      element.classList.add("is-ready");`,
      `    }, settings.delay);`,
      `    return element;`,
      `  }`,
      `  document.querySelectorAll(".${run(r, LOWER, 7)}").forEach(function (el) { ${name}(el, {}); });`,
    ].join("\n");
    out.push(block);
    size += block.length;
  }
  out.push("})();");
  return out.join("\n");
}

function json(r: Rng, bytes: number): string {
  const items: string[] = [];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    const item = JSON.stringify({
      id: 40000000000 + i,
      title: words(r, 4),
      handle: words(r, 3).replaceAll(" ", "-"),
      price: Math.floor(r() * 5000),
      available: r() > 0.2,
      options: ["Size", "Width"],
      variants: Array.from({ length: 3 }, (_, k) => ({ id: 30000000000 + i * 10 + k, sku: run(r, "ABCDEFGH0123456789", 10), title: `${k + 6} / Wide` })),
      featured_image: `//cdn.example-store.test/products/${run(r, LOWER, 10)}.jpg`,
    });
    items.push(item);
    size += item.length + 1;
    i++;
  }
  return `{"products":[${items.join(",")}]}`;
}

function build(seed: number): string {
  const r = seeded(seed);
  const scripts: string[] = [];
  const add = (body: string, attrs = "") => scripts.push(`<script${attrs}>${body}</script>`);

  add(
    JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Gel Comfort Insoles", description: words(r, 60), sku: "GCI-001", brand: { "@type": "Brand", name: "Example Store" }, offers: { "@type": "Offer", price: "19.99", priceCurrency: "USD", availability: "https://schema.org/InStock" } }),
    ' type="application/ld+json"'
  );
  add(`{"accessToken":"${run(r, "0123456789abcdef", 32)}","betas":["rich-media-storefront-analytics"],"domain":"example-store.test","predictiveSearch":true,"shopId":${Math.floor(r() * 1e8)},"locale":"en"}`, ' id="shopify-features" type="application/json"');
  add(`var meta = ${json(r, 30_000)};\nfor (var attr in meta) { window.ShopifyAnalytics.meta[attr] = meta[attr]; }`);
  add("(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-ABCD123');");
  add(minified(r, 195_000, "/*! jQuery v3.6.0 | (c) OpenJS Foundation and other contributors | jquery.org/license */"));
  add(minified(r, 160_000, "/** @license lodash 4.17.21 */var _={VERSION:\"4.17.21\"};"));
  add(minified(r, 120_000, "/*! Vue.js v2.6.14 (c) 2014-2021 Evan You */window.__VUE__=!0;"));
  add(json(r, 80_000), ' type="application/json" data-product-json');
  add(readable(r, 16_000));
  // About fifty vendor snippets of 1 to 6 KB, which is where a storefront's
  // remaining inline script weight lives.
  while (scripts.length < 59) add(minified(r, 1_000 + Math.floor(r() * 5_000)));

  const nav = Array.from({ length: 90 }, (_, i) => `<li><a href="/collections/${words(r, 2).replaceAll(" ", "-")}-${i}">${words(r, 2)}</a></li>`).join("");
  const cards = Array.from(
    { length: 440 },
    (_, i) =>
      `<div class="grid__item product-card" data-product-id="${40000000000 + i}"><a href="/products/${words(r, 3).replaceAll(" ", "-")}-${i}" class="product-card__link"><img src="//cdn.example-store.test/products/${run(r, LOWER, 10)}_360x.jpg" alt="${words(r, 4)}" width="360" height="360" loading="lazy"><h3 class="product-card__title">${words(r, 4)}</h3></a><div class="product-card__badges"><svg class="icon icon-star" aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="14" height="14"><path d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9L10 1.5z" fill="currentColor"/></svg><span class="visually-hidden">Rated ${(3 + r() * 2).toFixed(1)} out of 5</span></div><span class="price">$${(r() * 50).toFixed(2)}</span><button type="button" class="btn add-to-cart" data-variant="${30000000000 + i}">Add to cart</button></div>`
  ).join("\n");
  const headings = Array.from({ length: 10 }, (_, i) => `<section class="section-${i}"><h2>${words(r, 4)}</h2><p>${words(r, 30)}</p></section>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gel Comfort Insoles | Example Store</title>
<meta name="description" content="${words(r, 20)}">
<link rel="canonical" href="https://example-store.test/products/gel-comfort-insoles">
<link rel="stylesheet" href="//cdn.example-store.test/theme.css">
${scripts.slice(0, 4).join("\n")}
</head><body class="template-product">
<header class="site-header"><a href="/" class="logo">Example Store</a><nav aria-label="Main"><ul>${nav}</ul></nav></header>
<main id="MainContent"><h1>Gel Comfort Insoles</h1>
${headings}
<div class="grid">${cards}</div>
</main>
<footer class="site-footer"><p>${words(r, 40)}</p><a href="/policies/privacy-policy">Privacy policy</a> <a href="/policies/terms-of-service">Terms of service</a></footer>
<div id="cookie-banner" class="cookie-consent" role="dialog" aria-label="Cookie consent"><p>We use cookies to improve your experience.</p><button type="button" class="cookie-accept">Accept</button><button type="button" class="cookie-reject">Reject</button></div>
${scripts.slice(4).join("\n")}
</body></html>
`;
}

process.stdout.write(build(Number(arg("seed", "1864"))));
