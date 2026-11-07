// links/broken-anchors - the per-page anchor record.
//
// A link to `#id` (or `/page#id`) is only broken when the target page has no
// element with that id and no `<a name>` with that value: the two targets the
// HTML spec resolves a fragment to. Judging a cross-page link needs the target
// page's ids, but a streaming audit drops each page's DOM after the page pass,
// so the ids are captured while the DOM is live (collected-signals.ts) and the
// site pass reads the record. The v1 path has the DOM and calls this same
// function, so both engines judge from identical records.

import { SKIP_LINK_SELECTOR, hasSkipLinkText } from "../a11y/skip-link";
import type { ParsedPage } from "../types";

/**
 * Most distinct ids and `<a name>` values kept per page. A page over the cap is
 * not judged: a link into it could target an id that was dropped, so it is
 * skipped rather than reported. Bounds the per-page record in a 25k-page stream.
 */
export const ANCHOR_IDS_CAP = 512;

/** Most skip-link fragments kept per page. */
const SKIP_FRAGMENTS_CAP = 16;

/**
 * Most distinct same-page fragments kept per page. The parser leaves `href="#x"`
 * out of `parsed.links`, so these come from the DOM; a page over the cap has its
 * extra same-page links left unjudged.
 */
const SELF_FRAGMENTS_CAP = 256;

/**
 * Visible body text under this many characters, with a script on the page and
 * no browser render, reads as an empty client-side shell whose ids may be added
 * by JavaScript after load.
 */
const CLIENT_SHELL_TEXT_LIMIT = 200;

/**
 * Most characters of inline script text read per unrendered page for the ids a script
 * names. Past it the page is marked {@link PageAnchorSignal.scriptIdsTruncated} and no
 * missing id on it is called definitely missing (#1616).
 */
const SCRIPT_SCAN_LIMIT = 256 * 1024;

/** Most distinct id-like tokens kept from a page's inline scripts. Bounds the per-page record in a 25k-page stream. */
export const SCRIPT_IDS_CAP = 256;

/**
 * A quoted token of 1 to 128 characters with no whitespace, quote, backslash or angle bracket in it:
 * `"size"`, `'size'`, and the `\"size\"` of an attribute written inside a string (`<h2 id="size">`).
 * Nothing about the text between two quotes matters, so a stray apostrophe elsewhere in the script
 * cannot shift which tokens are read, and the bound keeps the scan linear.
 */
const SCRIPT_TOKEN_RE = /(["'`])([^\s"'`\\<>]{1,128})\\?\1/g;

/** `<script type>` values the browser runs as code. Anything else (JSON-LD, import maps, templates) is data. */
const EXECUTABLE_SCRIPT_TYPE_RE = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i;

export interface PageAnchorSignal {
  /** Distinct `id` attribute values and `<a name>` values, capped at {@link ANCHOR_IDS_CAP}. */
  ids: string[];
  /** True when the page had more distinct values than the cap, so links into it are not judged. */
  idsTruncated?: boolean;
  /** Decoded fragments of the page's skip-link anchors, so a broken skip link is labelled. */
  skipFragments: string[];
  /**
   * Decoded, judgeable fragments of the page's own same-page links (`href="#x"`),
   * capped at {@link SELF_FRAGMENTS_CAP}. Taken from the DOM because the parser
   * does not keep these in `parsed.links`.
   */
  selfFragments: string[];
  /**
   * How many same-page links point at each of {@link selfFragments}, by index (pub#837). Present
   * only when the page links some fragment more than once; absent, as on a record cached before
   * the field existed, every fragment reads as one link.
   */
  selfFragmentLinks?: number[];
  /**
   * The page was fetched without rendering and looks like an empty client-side
   * shell, so a missing id may be added by JavaScript. Reported as unconfirmed.
   */
  clientShell: boolean;
  /**
   * Quoted id-like tokens from the page's inline scripts, kept only when the page was fetched
   * without rendering and has some (#1616). A missing fragment that a script names may be created
   * at init, so it is reported as unconfirmed, not as definitely missing. Capped at
   * {@link SCRIPT_IDS_CAP}.
   */
  scriptIds?: string[];
  /** The inline scripts had more tokens, or more text, than were kept: no missing id on the page is confirmed. */
  scriptIdsTruncated?: boolean;
}

/**
 * The quoted id-like tokens in the page's inline scripts. Only code is read, never a JSON-LD or
 * template block. Returns null when the page has no inline script.
 */
function inlineScriptIds(
  doc: NonNullable<ParsedPage["document"]>,
): { ids: string[]; truncated: boolean } | null {
  const ids = new Set<string>();
  let truncated = false;
  let read = 0;
  let any = false;
  for (const el of doc.querySelectorAll("script:not([src])")) {
    const type = (el.getAttribute("type") ?? "").trim();
    if (type !== "" && !EXECUTABLE_SCRIPT_TYPE_RE.test(type)) continue;
    const text = el.textContent ?? "";
    if (text.trim() === "") continue;
    any = true;
    if (read + text.length > SCRIPT_SCAN_LIMIT) {
      truncated = true;
      break;
    }
    read += text.length;
    for (const match of text.matchAll(SCRIPT_TOKEN_RE)) {
      const token = match[2]!;
      if (ids.has(token)) continue;
      if (ids.size >= SCRIPT_IDS_CAP) {
        truncated = true;
        break;
      }
      ids.add(token);
    }
    if (truncated) break;
  }
  return any ? { ids: [...ids], truncated } : null;
}

/**
 * Whether a script on the page may create `fragment` after load, so a miss is not confirmed:
 * a script names it, or the scripts were too large to read in full.
 */
export function scriptMayCreateId(rec: PageAnchorSignal, fragment: string): boolean {
  if (rec.scriptIdsTruncated) return true;
  return rec.scriptIds?.includes(fragment) === true;
}

/** Percent-decode a fragment the way the browser matches it; a malformed escape stays as written. */
export function decodeFragment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Whether a decoded fragment names an element id this rule can judge. Excluded:
 * hash routes and state (`/route`, `!route`, `key=value`), text fragments
 * (`:~:`), `top`, which the spec scrolls to the top of the page for even when
 * no element has that id, and purely numeric fragments (`#0`, `#1`), which
 * templates use as do-nothing hrefs for script-driven links far more often
 * than as ids.
 */
export function isJudgeableFragment(fragment: string): boolean {
  if (fragment === "") return false;
  if (/^\d+$/.test(fragment)) return false;
  if (fragment.startsWith("/") || fragment.startsWith("!")) return false;
  if (fragment.includes("=") || fragment.includes(":~:")) return false;
  if (fragment.toLowerCase() === "top") return false;
  return true;
}

function fragmentOf(href: string): string | null {
  const hash = href.indexOf("#");
  if (hash < 0) return null;
  return decodeFragment(href.slice(hash + 1));
}

/**
 * Build a page's anchor record from its parsed document. Returns null when the
 * page has no document (an error page, a non-HTML response), which means it is
 * not judged, on either engine.
 */
export function buildPageAnchorSignal(input: {
  parsed: ParsedPage | undefined;
  rendered: boolean;
}): PageAnchorSignal | null {
  const doc = input.parsed?.document;
  if (!doc) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  let idsTruncated = false;
  const add = (value: string | null): void => {
    if (!value || seen.has(value)) return;
    if (ids.length >= ANCHOR_IDS_CAP) {
      idsTruncated = true;
      return;
    }
    seen.add(value);
    ids.push(value);
  };
  for (const el of doc.querySelectorAll("[id]")) add(el.getAttribute("id"));
  for (const el of doc.querySelectorAll("a[name]")) add(el.getAttribute("name"));

  // Skip links by class or target (the a11y/skip-link selector), or by the
  // skip-link text patterns a11y/skip-link also accepts.
  const skipFragments: string[] = [];
  const pushSkip = (href: string | null): void => {
    if (!href || skipFragments.length >= SKIP_FRAGMENTS_CAP) return;
    const fragment = fragmentOf(href);
    if (fragment && !skipFragments.includes(fragment)) skipFragments.push(fragment);
  };
  for (const el of doc.querySelectorAll(SKIP_LINK_SELECTOR)) pushSkip(el.getAttribute("href"));
  for (const el of doc.querySelectorAll("a[href^='#']")) {
    if (hasSkipLinkText(el.textContent ?? "")) pushSkip(el.getAttribute("href"));
  }

  // Same-page links. The parser drops every `#`-prefixed href from parsed.links,
  // so they are read here, from the same DOM the ids come from.
  const selfFragments: string[] = [];
  // Index into selfFragments; a fragment linked again counts its links, so a finding can say
  // "3 links".
  const selfIndex = new Map<string, number>();
  const selfFragmentLinks: number[] = [];
  let repeated = false;
  for (const el of doc.querySelectorAll("a[href]")) {
    const href = el.getAttribute("href")?.trim() ?? "";
    if (!href.startsWith("#")) continue;
    const fragment = decodeFragment(href.slice(1));
    if (!isJudgeableFragment(fragment)) continue;
    const index = selfIndex.get(fragment);
    if (index !== undefined) {
      selfFragmentLinks[index]!++;
      repeated = true;
      continue;
    }
    if (selfFragments.length >= SELF_FRAGMENTS_CAP) continue;
    selfIndex.set(fragment, selfFragments.length);
    selfFragments.push(fragment);
    selfFragmentLinks.push(1);
  }

  let clientShell = false;
  const body = doc.querySelector("body");
  if (!input.rendered && body && doc.querySelectorAll("script").length > 0) {
    // Visible text: the body's text less the text of scripts, styles and templates.
    let visible = (body.textContent ?? "").length;
    for (const el of body.querySelectorAll("script, style, noscript, template")) {
      visible -= (el.textContent ?? "").length;
    }
    clientShell = visible < CLIENT_SHELL_TEXT_LIMIT;
  }

  // Unrendered pages only: a rendered page's DOM already holds what its scripts created.
  const scripts = !input.rendered ? inlineScriptIds(doc) : null;

  const signal: PageAnchorSignal = {
    ids,
    skipFragments,
    selfFragments,
    clientShell,
  };
  if (idsTruncated) signal.idsTruncated = true;
  if (repeated) signal.selfFragmentLinks = selfFragmentLinks;
  if (scripts && scripts.ids.length > 0) signal.scriptIds = scripts.ids;
  if (scripts?.truncated) signal.scriptIdsTruncated = true;
  return signal;
}
