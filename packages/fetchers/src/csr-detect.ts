// CSR-shell detection for the HTTP-first hybrid fetcher (#294).
//
// Decides whether a plain-HTTP HTML response is a client-side-rendered *shell*
// — i.e. the real content only appears after JS runs, so a browser render is
// worth the cost. Tuned for LOW false positives: SSR/SSG pages ship real markup
// and are never flagged, so static sites pay zero render credits. A missed CSR
// page (false negative) just audits the shell, same as a plain --http run.

import { stripHtmlForText } from "@squirrelscan/utils";

// Thresholds tuned for LOW false positives so static/SSR sites pay zero render
// credits.
/** Visible-text length below which a page counts as "empty-ish" (a shell). */
export const CSR_MIN_VISIBLE_TEXT_CHARS = 200;
/** Min <script> tags for a sparse page to look like a JS app (not just empty). */
export const CSR_MIN_SCRIPTS_WHEN_SPARSE = 1;

// Empty, known SPA mount points. Strong signal: a server-rendered page fills
// these with markup, so an *empty* one is almost certainly client-rendered.
const EMPTY_SPA_ROOT_PATTERNS: RegExp[] = [
  // <div id="root|app|__next|__nuxt|root-app"></div> (allow attrs + whitespace)
  /<div\b[^>]*\bid=["'](?:root|app|__next|__nuxt|root-app|svelte)["'][^>]*>\s*<\/div>/i,
  // <app-root></app-root>, <app-component></app-component> (Angular & friends)
  /<(app-root|app-component)\b[^>]*>\s*<\/\1>/i,
];

/** Approximate visible text: strip comments, non-rendered elements, head, tags. */
export function extractVisibleText(html: string): string {
  return stripHtmlForText(html, {
    exclude: ["script", "style", "template", "noscript", "svg", "head"],
  })
    .replace(/\s+/g, " ")
    .trim();
}

function scriptCount(html: string): number {
  return html.match(/<script\b/gi)?.length ?? 0;
}

/**
 * True when the HTML looks like a client-side-rendered shell worth re-fetching
 * via a browser render. Pure + cheap (regex only) so it can run in the fetch
 * hot path before the page is parsed.
 */
export function looksClientRendered(html: string): boolean {
  if (!html) return false;

  // Strong signal: an empty known SPA mount point.
  if (EMPTY_SPA_ROOT_PATTERNS.some((re) => re.test(html))) {
    return true;
  }

  // Backstop: a near-empty body that still ships JS — a bundle that renders the
  // page on the client. Requires BOTH so content-rich pages are never flagged.
  const visibleText = extractVisibleText(html);
  return (
    visibleText.length < CSR_MIN_VISIBLE_TEXT_CHARS &&
    scriptCount(html) >= CSR_MIN_SCRIPTS_WHEN_SPARSE
  );
}
