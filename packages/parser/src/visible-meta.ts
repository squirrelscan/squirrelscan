// Visible author / date extraction from rendered HTML markup.
//
// The schema path (`extractAuthorFromSchema`, JSON-LD `datePublished`/
// `dateModified`) misses sites that only expose E-E-A-T signals as visible
// markup — most notably WordPress themes (Kadence et al.) that emit an hCard
// byline (`.author.vcard .fn` / `rel="author"`) and an entry-meta `<time>`
// (`time.entry-date.published`, `[itemprop="datePublished"]`). This module
// reads that DOM markup so the eeat rules can fall back to it.
//
// IMPORTANT: only signals that are *content-specific* count. Org-level metadata
// (publisher / copyright / footer "© Company") appears on every page and must
// NOT be treated as a per-article author or publish date — that would make the
// homepage and every landing page look like authored, dated content. The
// guards below scope extraction to article/entry/post containers and ignore
// known org-level markers.

import { getAttrCI } from "@squirrelscan/utils";
import type { Document, Element } from "linkedom";

/** Visible (non-schema) author + date signals extracted from the DOM. */
export interface VisibleMeta {
  /** Visible byline author name, or null if none found. */
  visibleAuthor: string | null;
  /** Visible published date (ISO `datetime` preferred, else text), or null. */
  visibleDatePublished: string | null;
  /** Visible modified/updated date (ISO `datetime` preferred, else text). */
  visibleDateModified: string | null;
}

export const EMPTY_VISIBLE_META: VisibleMeta = {
  visibleAuthor: null,
  visibleDatePublished: null,
  visibleDateModified: null,
};

// hCard / WordPress author byline selectors, ordered most→least specific.
// `.author.vcard .fn` and `.url.fn.n` are the classic hCard microformat;
// `[rel="author"]`, `.entry-author`, `.author-name`, `.byline .author` cover
// common theme variants.
const AUTHOR_SELECTORS = [
  ".author.vcard .fn",
  ".author.vcard .url.fn.n",
  ".vcard .fn",
  "[rel~='author']",
  ".entry-author .author-name",
  ".entry-author",
  ".author-name",
  ".byline .author",
  ".posted-by .author",
  ".author.vcard",
  "[itemprop='author'] [itemprop='name']",
  "[itemprop='author']",
  ".author",
] as const;

// Containers that scope a byline/date to *article* content. Deliberately
// NOT bare `<main>` — almost every page has a `<main>`, so requiring a real
// article/entry/post container is what keeps marketing homepages (testimonial
// `.author`, header owner links) from being mistaken for authored content.
// `"article"` is intentionally absent: the `<article>` tag is matched directly,
// and a bare `class="article"` is too often a styling hook on non-article CMS
// pages.
const ARTICLE_CONTAINER_CLASSES = [
  "post",
  "entry",
  "entry-header",
  "entry-meta",
  "entry-content",
];

// Class/id tokens that mark a non-article context where an `.author` is
// unrelated to a byline: customer testimonials, comment threads, sidebar
// widgets. Deliberately narrow — `review` is excluded because review *articles*
// legitimately carry bylines (the rule explicitly supports `/review` pages);
// `quote` is excluded as too broad (pull-quotes etc.).
const NON_BYLINE_CONTEXT =
  /\b(testimonial|testimonials|comment|comments|commentlist|respond|widget|sidebar)\b/i;

// Text that signals org-level / boilerplate metadata, not a real byline.
const ORG_AUTHOR_NOISE = /\b(admin|administrator|webmaster|editorial team|staff)\b/i;

// Generic role labels that are only org-noise when they stand *alone* as the
// whole byline (a WP "Editor"-role user with no full name). Matched exactly so
// legit bylines that merely contain the word ("Jane (Editor)", "Edited by the
// Editor") are kept — that's why this is anchored, not a `\b` contains-match.
const EXACT_ROLE_NOISE = /^(editor|editorial)$/i;

// Max plausible length for a human author name — guards against grabbing a
// whole paragraph when a `.author` class is reused on a content block.
const MAX_AUTHOR_LEN = 80;

function classTokens(el: Element): string[] {
  return (getAttrCI(el, "class") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when `el` is inside a genuine article/entry/post container — i.e. the
 * byline/date markup is content-scoped, not site chrome. Walking ancestors
 * also lets us reject site banner/footer chrome and non-byline contexts
 * (testimonials, comments) in a single pass.
 *
 * Note: a semantic `<header>`/`<footer>` *inside* an article (e.g. Kadence's
 * `<header class="entry-header">`) is article markup, so we only treat
 * banner/contentinfo by explicit ARIA role — not the bare tag — as chrome.
 */
function isInArticleContext(el: Element): boolean {
  let node: Element | null = el;
  let inArticle = false;
  while (node) {
    const tag = node.tagName?.toLowerCase();
    const role = getAttrCI(node, "role");
    // Explicit site chrome — never a per-article byline/date.
    if (role === "contentinfo" || role === "banner") return false;

    const tokens = classTokens(node);
    // A testimonial / comment / widget block is not an article byline. WP
    // comment threads are often keyed by `id` (`#comments`, `#respond`), so
    // check both class tokens and the element id.
    const id = (getAttrCI(node, "id") ?? "").toLowerCase();
    if (tokens.some((t) => NON_BYLINE_CONTEXT.test(t))) return false;
    if (id && NON_BYLINE_CONTEXT.test(id)) return false;
    const itemtype = getAttrCI(node, "itemtype") ?? "";

    if (
      tag === "article" ||
      tokens.some((t) => ARTICLE_CONTAINER_CLASSES.includes(t)) ||
      /Article|BlogPosting|NewsArticle/i.test(itemtype)
    ) {
      inArticle = true;
    }
    node = node.parentElement as Element | null;
  }
  return inArticle;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Extract a visible author name from byline markup, or null. */
function extractVisibleAuthor(doc: Document): string | null {
  for (const selector of AUTHOR_SELECTORS) {
    let els: Element[];
    try {
      els = Array.from(doc.querySelectorAll(selector)) as Element[];
    } catch {
      // Skip selectors linkedom can't parse (defensive).
      continue;
    }
    for (const el of els) {
      // Only count bylines inside a genuine article/entry/post container.
      // `rel="author"` site-owner links in headers and testimonial `.author`
      // spans on homepages are rejected here.
      if (!isInArticleContext(el)) continue;

      // Prefer an inner name element when the match is a wrapping container.
      const nameEl =
        (el.querySelector(".fn") as Element | null) ??
        (el.querySelector("[itemprop='name']") as Element | null) ??
        el;
      const name = cleanText(nameEl.textContent);
      if (!name || name.length > MAX_AUTHOR_LEN) continue;
      if (ORG_AUTHOR_NOISE.test(name)) continue;
      if (EXACT_ROLE_NOISE.test(name)) continue;
      return name;
    }
  }
  return null;
}

/**
 * Pull a usable date value from a `<time>` (or `[itemprop=date*]`) element:
 * the machine-readable `datetime` attribute if present, else trimmed text.
 */
function dateFromElement(el: Element): string | null {
  const dt = cleanText(getAttrCI(el, "datetime"));
  if (dt) return dt;
  const content = cleanText(getAttrCI(el, "content"));
  if (content) return content;
  const text = cleanText(el.textContent);
  return text || null;
}

/**
 * Find a date by itemprop, scoped to content containers so a footer
 * "© 2024" or a sidebar widget doesn't masquerade as a publish date.
 */
function findDateByItemprop(doc: Document, prop: string): string | null {
  let els: Element[];
  try {
    els = Array.from(
      doc.querySelectorAll(`[itemprop='${prop}']`)
    ) as Element[];
  } catch {
    return null;
  }
  for (const el of els) {
    if (!isInArticleContext(el)) continue;
    const value = dateFromElement(el);
    if (value) return value;
  }
  return null;
}

/** Find a date by `<time>` class (e.g. `entry-date published`, `updated`). */
function findDateByTimeClass(doc: Document, classNames: string[]): string | null {
  let times: Element[];
  try {
    times = Array.from(doc.querySelectorAll("time")) as Element[];
  } catch {
    return null;
  }
  for (const el of times) {
    if (!isInArticleContext(el)) continue;
    const cls = classTokens(el);
    if (classNames.every((c) => cls.includes(c))) {
      const value = dateFromElement(el);
      if (value) return value;
    }
  }
  return null;
}

/** Extract visible published date from entry-meta `<time>` markup, or null. */
function extractVisibleDatePublished(doc: Document): string | null {
  return (
    findDateByItemprop(doc, "datePublished") ??
    findDateByTimeClass(doc, ["entry-date", "published"]) ??
    findDateByTimeClass(doc, ["published"])
  );
}

/** Extract visible modified date from entry-meta `<time>` markup, or null. */
function extractVisibleDateModified(doc: Document): string | null {
  return (
    findDateByItemprop(doc, "dateModified") ??
    findDateByTimeClass(doc, ["updated"]) ??
    findDateByTimeClass(doc, ["entry-date", "modified"])
  );
}

/**
 * Extract visible author + date signals from rendered HTML markup. Every match
 * must sit inside a genuine article/entry/post container (see
 * `isInArticleContext`), so non-article pages (homepage, landing/marketing
 * pages) don't report a per-content author/date they don't have — even when
 * they carry org-level metadata (footer copyright, header owner link,
 * testimonial bylines).
 */
export function extractVisibleMeta(doc: Document | null): VisibleMeta {
  if (!doc) return { ...EMPTY_VISIBLE_META };

  return {
    visibleAuthor: extractVisibleAuthor(doc),
    visibleDatePublished: extractVisibleDatePublished(doc),
    visibleDateModified: extractVisibleDateModified(doc),
  };
}
