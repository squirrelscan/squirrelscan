// Soft-404 detection — a page that serves error/"not found" content with a
// success (2xx) HTTP status. Google treats these specially and downstream
// content/legal rules must not assess them as if they were real pages.
//
// CONSERVATIVE BY DESIGN: a page is only flagged when it shows at least two
// independent signals AND at least one of them is a STRONG content signal
// (an error-shell marker or "page not found" title/heading text). Supporting
// signals (robots noindex, tiny content) can never flag a page on their own —
// this protects legitimate thin/noindexed pages, and a real article titled
// "How to fix 404 errors" (one weak text hit at most) is never flagged.

import type { Document } from "linkedom";

export type Soft404SignalName =
  | "error-shell"
  | "not-found-title"
  | "not-found-heading"
  | "noindex"
  | "tiny-content";

export interface Soft404Signal {
  name: Soft404SignalName;
  /** Whether this signal is strong enough to anchor a soft-404 verdict. */
  strong: boolean;
  /** Short human-readable explanation of what matched. */
  detail: string;
}

export interface Soft404Detection {
  isSoft404: boolean;
  signals: Soft404Signal[];
}

/**
 * Verdict from the end-of-crawl confirmation re-fetch (#1177). A single crawl
 * observation is not enough to warn — audit-engine re-fetches a flagged 2xx page
 * once and re-runs detection:
 * - `confirmed`    — the error shell reproduced → real soft-404, warn as normal.
 * - `intermittent` — the re-fetch served real content → nondeterministic 404-shell
 *                    serving (the owner's browser may show the page; still bad for
 *                    SEO because crawlers can hit the poisoned variant).
 * - `unconfirmed`  — no re-fetch was possible (offline / fetch error / non-2xx /
 *                    confirmation budget exhausted) → warn, annotated as based on a
 *                    single observation rather than silently dropped.
 * - `unconfirmed-rendered` — the crawl content came from a JS render, so a plain
 *                    (unrendered) re-fetch would falsely trip the tiny-content
 *                    signal; the confirm pass skips the fetch and warns, annotated
 *                    that it can't verify without rendering. A sub-kind of
 *                    unconfirmed (still warns, never dropped).
 */
export type Soft404Confirmation =
  | "confirmed"
  | "intermittent"
  | "unconfirmed"
  | "unconfirmed-rendered";

export interface Soft404Input {
  /** HTTP status of the crawled page. Only 2xx pages can be soft-404s. */
  statusCode: number;
  /** Parsed DOM (null for pages with no document) — used for the error-shell marker. */
  document?: Document | null;
  /** <title> text. */
  title?: string | null;
  /** All <h1> texts on the page. */
  h1Texts?: readonly string[];
  /** First `meta[name=robots]` content (e.g. "noindex"). */
  robotsMeta?: string | null;
  /** Visible word count (from content extraction). */
  wordCount?: number;
  /**
   * Optional site median word count. When provided, tiny-content fires only if
   * the page is far below the site's typical page; otherwise an absolute floor
   * is used.
   */
  siteMedianWordCount?: number;
}

// Below this absolute word count a 2xx page carries essentially no content — a
// supporting signal only (never flags a page without a strong signal).
const TINY_ABS_WORDS = 25;
// When a site median is known, a page below this fraction of it is "tiny".
const TINY_MEDIAN_FRACTION = 0.2;

// Framework error-shell root ids (Next.js App Router renders `<html
// id="__next_error__">` for its not-found/error boundary; the generic form
// covers equivalents like `__error__`).
const ERROR_SHELL_ID_RE = /^__\w*error\w*__$/i;

// "Page not found"-style phrasing. The not-found phrase must be immediately
// preceded by a subject qualifier (page/content/post/article/url) — a BARE
// "not found" / "no longer available" substring is NOT enough. This keeps real
// titles like "How to Fix File Not Found Errors" ("file" is not a qualifier) and
// "This Item Is No Longer Available" ("item" is not a qualifier) from producing a
// strong signal. A title that LEADS with 404 (below) is the other strong path.
const NOT_FOUND_PHRASE_RE =
  /\b(?:page|content|post|article|url)\s+(?:not\s+found|does(?:n['’]t| not)\s+exist|no\s+longer\s+(?:exists|available)|(?:cannot|can\s+not|can['’]t)\s+be\s+found|could(?:n['’]t| not)\s+be\s+found)\b/i;
const LEADING_404_RE = /^\s*(?:error\s*)?404(?:\b|[\s:|/–—-])/i;

/** True when a title/heading string reads as "page not found". */
export function looksLikeNotFoundText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return LEADING_404_RE.test(t) || NOT_FOUND_PHRASE_RE.test(t);
}

/** True when the document root carries a framework error-shell marker. */
export function hasErrorShellMarker(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  const rootId = doc.documentElement?.getAttribute("id");
  if (rootId && ERROR_SHELL_ID_RE.test(rootId)) return true;
  // Fall back to any element carrying the canonical Next.js error id.
  return doc.querySelector('[id="__next_error__"]') !== null;
}

/**
 * Detect whether a 2xx page is serving 404 / error content. Cheap and pure —
 * reads only already-parsed fields plus the DOM root, no extra fetches.
 */
export function detectSoft404(input: Soft404Input): Soft404Detection {
  const empty: Soft404Detection = { isSoft404: false, signals: [] };

  // Only success responses can be "soft" 404s. A real 4xx/5xx (or redirect) is
  // handled by status-based rules and is never a soft-404.
  if (input.statusCode < 200 || input.statusCode >= 300) return empty;

  const signals: Soft404Signal[] = [];

  // STRONG: framework error-shell marker.
  if (hasErrorShellMarker(input.document)) {
    signals.push({
      name: "error-shell",
      strong: true,
      detail: "Framework error-shell marker on the document root",
    });
  }

  // STRONG: "page not found" title and/or heading text. Title and heading are
  // counted as independent signals — a custom 404 template that returns 200 with
  // both a "Page Not Found" <title> and <h1> (and no framework shell / noindex)
  // is then still flagged. The strict phrasing keeps real content that merely
  // mentions "404" (e.g. "How to fix 404 errors") from matching either.
  if (looksLikeNotFoundText(input.title)) {
    signals.push({
      name: "not-found-title",
      strong: true,
      detail: `"Not found" title: ${JSON.stringify(input.title)}`,
    });
  }
  const notFoundHeading = (input.h1Texts ?? []).find((h) => looksLikeNotFoundText(h));
  if (notFoundHeading) {
    signals.push({
      name: "not-found-heading",
      strong: true,
      detail: `"Not found" heading: ${JSON.stringify(notFoundHeading)}`,
    });
  }

  // SUPPORTING: robots noindex.
  if (input.robotsMeta && /\bnoindex\b/i.test(input.robotsMeta)) {
    signals.push({
      name: "noindex",
      strong: false,
      detail: "Page declares robots noindex",
    });
  }

  // SUPPORTING: tiny content relative to site median (or an absolute floor).
  const words = input.wordCount;
  if (typeof words === "number") {
    const median = input.siteMedianWordCount;
    const tiny =
      typeof median === "number" && median > 0
        ? words < median * TINY_MEDIAN_FRACTION && words <= TINY_ABS_WORDS * 4
        : words <= TINY_ABS_WORDS;
    if (tiny) {
      signals.push({
        name: "tiny-content",
        strong: false,
        detail: `Only ${words} words of visible content`,
      });
    }
  }

  const hasStrong = signals.some((s) => s.strong);
  const isSoft404 = hasStrong && signals.length >= 2;

  return { isSoft404, signals };
}
