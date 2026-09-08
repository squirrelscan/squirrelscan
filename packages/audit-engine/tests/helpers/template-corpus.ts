// The authored template corpus shared by #1950's parity gate and #1951's fan-out
// equivalence gate.
//
// It lives here because the two files are falsifiers for the SAME claim — that a
// rule declaring `verdictScope: "template"` gives one verdict per cluster — and a
// second copy of the fixture is a second thing to drift. #1950's own lesson was
// that both of its falsifiers must import one comparison function; this is the
// same argument applied to the corpus.
//
// WHY IT IS SHAPED THIS WAY. A corpus whose pages are all one template passes
// either gate vacuously, and the synthetic bench corpora are exactly that —
// generated from 1-6 templates, so every clustering definition collapses to ~99%
// redundancy on them (#1026). So this is authored: three templates with 4, 4 and 3
// members plus two singletons, and the members of a template differ the way real
// template siblings differ — different amounts of the same kind of content: more
// paragraphs, more images, more links, different titles, different JSON-LD, an
// image missing its alt on some pages. What they do NOT differ in is the KIND of
// markup, because that is the template, and that distinction is the
// classification's whole premise.
//
// The importing tests are what check the corpus is adversarial enough to mean
// anything: it must produce several multi-page clusters AND a substantial number
// of "page"-declared rules that genuinely disagree inside a cluster.

import type { PageRecord } from "@squirrelscan/core-contracts";

export const ORIGIN = "https://shop.test";

export interface Template {
  readonly id: string;
  readonly stylesheet: string;
  readonly scriptHost: string;
  readonly imageHost: string;
  readonly bodyClass: string;
  readonly cssVars: string;
  readonly footer: boolean;
}

export const TEMPLATES: Template[] = [
  {
    id: "product",
    stylesheet: "/assets/product.css",
    scriptHost: "cdn.shopkit.test",
    imageHost: "img.shopkit.test",
    bodyClass: "tpl-product theme-light",
    cssVars: "--brand:#101010;--gutter:16px",
    footer: true,
  },
  {
    id: "article",
    stylesheet: "/assets/article.css",
    scriptHost: "cdn.editorial.test",
    imageHost: "media.editorial.test",
    bodyClass: "tpl-article theme-light",
    cssVars: "--brand:#202020;--measure:68ch",
    footer: true,
  },
  {
    id: "landing",
    stylesheet: "/assets/landing.css",
    scriptHost: "cdn.campaign.test",
    imageHost: "img.campaign.test",
    bodyClass: "tpl-landing",
    cssVars: "--brand:#303030",
    // No footer: a chrome difference, so this cannot merge into another cluster.
    footer: false,
  },
];

/**
 * The template's chrome, byte-identical for every member. Everything the cluster
 * key reads lives here: stylesheet hrefs, asset hosts, body classes, CSS custom
 * properties, nav and footer presence.
 */
export function chrome(t: Template): { head: string; nav: string; foot: string } {
  return {
    head:
      `<meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="icon" href="/favicon.ico">` +
      `<link rel="stylesheet" href="${t.stylesheet}">` +
      `<script src="https://${t.scriptHost}/app.js" defer></script>` +
      // An inline script, template-emitted and byte-identical across members, so
      // the script-reading declarations (integrity/obfuscated-script,
      // perf/legacy-js, perf/duplicate-js) are compared on something rather than
      // passing by absence.
      `<script>window.__cfg={locale:"en",tpl:"${t.id}"};</script>` +
      `<style>:root{${t.cssVars}}</style>`,
    nav:
      `<nav aria-label="Primary"><ul>` +
      `<li><a href="/">Home</a></li><li><a href="/about">About</a></li>` +
      `</ul></nav>`,
    foot: t.footer
      ? `<footer><form action="/subscribe" method="post">` +
        `<label for="em">Email</label><input id="em" type="email" name="email">` +
        `<button type="submit">Subscribe</button></form>` +
        `<p>&copy; 2026 Shop Test</p></footer>`
      : "",
  };
}

/**
 * One member's body. `n` is the only thing that moves: more paragraphs, more
 * images, more links, a different title and description, a different JSON-LD
 * offer, and on every third page an image with no alt. That is how real siblings
 * of one template differ, and it is what makes the "page"-declared rules disagree
 * here.
 */
export function body(t: Template, n: number): string {
  const paragraphs = Array.from(
    { length: n + 1 },
    (_, i) =>
      `<p>Paragraph ${i + 1} of the ${t.id} page number ${n}. ` +
      "It carries enough prose that word count, reading level and text-to-html ratio move with n. ".repeat(n) +
      "</p>",
  ).join("");
  const images = Array.from({ length: n }, (_, i) =>
    i === 0 && n % 3 === 0
      ? `<img src="https://${t.imageHost}/${t.id}-${n}-${i}.jpg" width="800" height="600">`
      : `<img src="https://${t.imageHost}/${t.id}-${n}-${i}.jpg" width="800" height="600" alt="${t.id} view ${i}">`,
  ).join("");
  const links = Array.from(
    { length: n },
    (_, i) => `<a href="/${t.id}/related-${i}">Related ${i}</a>`,
  ).join(" ");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": t.id === "article" ? "Article" : "Product",
    name: `${t.id} ${n}`,
    description: `A ${t.id} with ${n} related items.`,
  });
  return (
    `<main><h1>${t.id} number ${n}</h1>` +
    Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2>`).join("") +
    paragraphs +
    images +
    `<p>${links}</p>` +
    `<script type="application/ld+json">${jsonLd}</script>` +
    `</main>`
  );
}

export function pageHtml(t: Template, n: number): string {
  const c = chrome(t);
  return (
    `<!DOCTYPE html><html lang="en"><head><title>${t.id} ${n} | Shop Test</title>` +
    `<meta name="description" content="The ${t.id} page numbered ${n}, with ${n} related items and ${n} images.">` +
    `<link rel="canonical" href="${ORIGIN}/${t.id}/${n}">` +
    c.head +
    `</head><body class="${t.bodyClass}">${c.nav}${body(t, n)}${c.foot}</body></html>`
  );
}

/** A page nothing else shares chrome with, so it lands in a cluster of one. */
export function singletonHtml(slug: string): string {
  return (
    `<!DOCTYPE html><html lang="en"><head><title>${slug} | Shop Test</title>` +
    `<meta name="description" content="A one-off ${slug} page.">` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<link rel="stylesheet" href="/assets/${slug}.css">` +
    `<script src="https://cdn.${slug}.test/app.js" defer></script>` +
    `<style>:root{--brand-${slug}:#404040}</style>` +
    `</head><body class="tpl-${slug}"><nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main><h1>${slug}</h1><p>One of a kind.</p>` +
    `<img src="https://img.${slug}.test/hero.jpg" width="100" height="100" alt="hero"></main></body></html>`
  );
}

export interface Fixture {
  readonly url: string;
  readonly html: string;
}

export const CORPUS: Fixture[] = [
  ...TEMPLATES.flatMap((t) =>
    (t.id === "landing" ? [1, 2, 3] : [1, 2, 3, 4]).map((n) => ({
      url: `${ORIGIN}/${t.id}/${n}`,
      html: pageHtml(t, n),
    })),
  ),
  { url: `${ORIGIN}/contact`, html: singletonHtml("contact") },
  { url: `${ORIGIN}/status`, html: singletonHtml("status") },
];

export function mkPage(url: string, html: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html; charset=utf-8",
    sizeBytes: html.length,
    loadTimeMs: 12,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h:${url}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html; charset=utf-8" },
    securityHeaders: {},
  } as unknown as PageRecord;
}
