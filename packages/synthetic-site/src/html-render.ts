// Lazy per-page HTML rendering. Pure function of (page, origin) — deterministic
// via the page's own seedTag, independent of request/write order. Never called
// eagerly for a whole SiteModel; callers render one page at a time and let the
// string go out of scope (server.ts per-request, storage-writer.ts per-upsert).

import type { PageModel } from "./types";

import { ADJECTIVES, NOUNS, TOPICS, VERBS } from "./lexicon";
import { createRng, rngPick, type Rng } from "./prng";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Exported for reuse by storage-writer.ts so link_appearances hrefs match rendered <a href>s. */
export function absoluteHref(href: string, origin: string): string {
  // Already absolute (issue-injected redirect targets etc.) — leave as-is.
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  return `${origin}${href}`;
}

export function linkText(href: string): string {
  const path = href.split("?")[0] ?? href;
  const slug = path.split("/").filter(Boolean).pop();
  return slug ? slug.replaceAll("-", " ") : "home";
}

function sentence(rng: Rng): string {
  const adjective = rngPick(rng, ADJECTIVES);
  const noun = rngPick(rng, NOUNS);
  const verb = rngPick(rng, VERBS);
  const topic = rngPick(rng, TOPICS);
  return `The ${adjective} ${noun} ${verb} ${topic} for everyday use.`;
}

function buildParagraphs(rng: Rng, targetSizeBytes: number): string[] {
  const paragraphs: string[] = [];
  let approxBytes = 400; // rough head/nav/chrome overhead already accounted for by caller
  while (approxBytes < targetSizeBytes) {
    const sentenceCount = 3 + Math.floor(rng() * 4);
    const sentences: string[] = [];
    for (let i = 0; i < sentenceCount; i++) sentences.push(sentence(rng));
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    approxBytes += paragraph.length + 10; // + <p></p> overhead
  }
  return paragraphs;
}

/** Structural markup differs per template so template-clustering rules see real fingerprints. */
function templateChrome(templateId: string): {
  headerExtra: string;
  mainWrapperOpen: string;
  mainWrapperClose: string;
} {
  switch (templateId) {
    case "home":
      return {
        headerExtra: '<div class="hero"></div>',
        mainWrapperOpen: '<main class="home">',
        mainWrapperClose: "</main>",
      };
    case "product":
      return {
        headerExtra: "",
        mainWrapperOpen: '<main class="product"><div class="price">$0.00</div>',
        mainWrapperClose: "</main>",
      };
    case "blog":
      return {
        headerExtra: "",
        mainWrapperOpen: '<main class="blog"><article><time datetime="2026-01-01"></time>',
        mainWrapperClose: "</article></main>",
      };
    case "category":
      return {
        headerExtra: "",
        mainWrapperOpen: '<main class="category"><div class="grid">',
        mainWrapperClose: "</div></main>",
      };
    default:
      return {
        headerExtra: "",
        mainWrapperOpen: `<main class="${templateId}">`,
        mainWrapperClose: "</main>",
      };
  }
}

export function renderPageHtml(page: PageModel, origin: string): string {
  const rng = createRng(page.seedTag);
  const chrome = templateChrome(page.templateId);
  const paragraphs = buildParagraphs(rng, page.targetSizeBytes);
  const bodyHtml = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  const linksHtml = page.outgoingLinks
    .map(
      (href) =>
        `<a href="${escapeHtml(absoluteHref(href, origin))}">${escapeHtml(linkText(href))}</a>`,
    )
    .join("\n");
  const robotsMeta = page.noindex ? '<meta name="robots" content="noindex">' : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
${robotsMeta}
<link rel="canonical" href="${origin}${page.path}">
</head>
<body class="tpl-${escapeHtml(page.templateId)}">
<header>${chrome.headerExtra}<nav><a href="${origin}/">home</a></nav></header>
${chrome.mainWrapperOpen}
<h1>${escapeHtml(page.h1)}</h1>
${bodyHtml}
<div class="links">
${linksHtml}
</div>
${chrome.mainWrapperClose}
<footer><p>&copy; synthetic-site</p></footer>
</body>
</html>`;
}

export function buildRobotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

export function buildSitemapXml(sitemapPaths: string[], origin: string): string {
  const urls = sitemapPaths
    .map((path) => `  <url><loc>${escapeHtml(`${origin}${path}`)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
