// Sign-in controls and their labels, read within a bound on work (#784).
//
// A phishing kit labels its control however the page's text detectors do not look: only in
// `aria-label`, `title` or a logo's `alt`, on a `<button>` or `<input type=submit>`, with Cyrillic
// look-alikes or fullwidth letters, with hidden text spliced into the words, or inside a `<template>`.
//
// Every bound here is on WORK, never on position: every control on the page is listed and every one
// gets a short read, so no amount of padding before the real control can starve it. The parser nests an
// unclosed `<a>` inside the next, so on junk markup every anchor holds the rest of the page; the per-control
// visit cap is what keeps that linear. The most relevant controls also get a longer read from a page-wide
// budget, and a relevant control whose read was cut is counted in `unread` so the rules can say so.

import { getAttrCI } from "@squirrelscan/utils";

import { BRAND_SPECS } from "./brand-specs";
import { CONFUSABLE_RUN, CONFUSABLES, INVISIBLE, digitForms } from "./confusables";
import { AUTH_CUE_PHRASES, AUTH_LABEL } from "./cues";
import { hiddenSelectors } from "./overlay-style";

/** Text with nothing outside ASCII (a linear test, with no backtracking). */
const ASCII_ONLY = /^\p{ASCII}*$/u;

/**
 * Text as a cue is matched against: combining marks gone, NFKC (fullwidth and styled letters become
 * ASCII), accents stripped, lower case, look-alike letters from other scripts mapped to the Latin letter,
 * invisible characters gone and every run of whitespace one space, so none of them can split `sign in` or
 * a brand phrase (pub#749, #784).
 *
 * The marks are removed BEFORE any normalisation: the normaliser is quadratic on a long run of combining
 * marks (30 KB of them took seconds, in one native call no time budget can interrupt), and every mark is
 * discarded afterwards anyway. After that step the input holds no marks, so the normaliser only ever sees
 * the short sequences compatibility characters expand to.
 */
export function readable(text: string): string {
  // Plain ASCII has no marks, invisible characters, compatibility forms or look-alikes: only case and spacing.
  if (ASCII_ONLY.test(text)) return text.toLowerCase().replace(/\s+/g, " ");
  return text
    .replace(INVISIBLE, "")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(CONFUSABLE_RUN, (ch) => CONFUSABLES[ch] ?? ch)
    .replace(/\s+/g, " ");
}

/** `readable` text with every space removed: a phrase matches however the markup splits or breaks it. */
export function squashed(text: string): string {
  return readable(text).replace(/ /g, "");
}

export interface Control {
  element: Element;
  /** The control's destination attribute: `href` of a link, `formaction` or the form's `action` of a button, else null. */
  href: string | null;
  /** Every distinct readable form of the label: text glued and with a break at each element, visible-only text, attributes. */
  labels: string[];
  /** The same labels with every space removed. */
  squashed: string[];
}

export interface ControlScan {
  controls: Control[];
  /** Relevant controls whose text was cut by the work bounds (a sign-in attribute, a button, a link to another host or a sign-in path). */
  unread: number;
  /** Templates with content that the template bound left unread (not counted in `unread`). */
  templatesUnread: number;
  /** A CSS rule that may hide text in a label was past the size bounds or the amount read: its text may be read as visible. */
  hiddenCssTruncated: boolean;
}

const ATTR_CHARS = 300;
/** An attribute is normalised (padding removed) over this many characters before it is cut to {@link ATTR_CHARS}. */
const ATTR_RAW_CHARS = 16_000;
const ATTR_STRIDE = ATTR_CHARS / 2;

/**
 * An attribute's text in overlapping windows over its first {@link ATTR_RAW_CHARS} normalised characters, so a cue
 * cannot straddle a cut (every run of 150 characters lies whole inside one window). A window edge that falls inside
 * a word gets a letter stuck on it (`x`): a window cut out of `Redesign in with Google` must not read as `sign in
 * with Google`, and a cue half-cut by the edge must not read as a whole word either.
 */
function boundedAttribute(text: string): { texts: string[]; cut: boolean } {
  const normalised = readable(text.slice(0, ATTR_RAW_CHARS)).trim();
  const limited = normalised.slice(0, ATTR_RAW_CHARS);
  const texts: string[] = [];
  for (let start = 0; start < limited.length; start += ATTR_STRIDE) {
    const end = Math.min(limited.length, start + ATTR_CHARS);
    const before = start > 0 && limited[start - 1] !== " " ? "x" : "";
    const after = end < limited.length && limited[end] !== " " ? "x" : "";
    texts.push(`${before}${limited.slice(start, end)}${after}`);
    if (start + ATTR_CHARS >= limited.length) break;
  }
  return { texts, cut: text.length > ATTR_RAW_CHARS || normalised.length > ATTR_RAW_CHARS };
}

/**
 * The words a cue is made of, derived from what the rules match: the auth cues of {@link AUTH_CUE_PHRASES} and every
 * brand lexicon phrase. A window can hold such a phrase only if it holds the phrase's first word (with a short first
 * word joined to the second, `sign ?in`: the rule lets a space be missing), so a window without one cannot match a cue
 * and is not read. Derived, not listed by hand: a new lexicon phrase widens the prefilter by itself.
 */
/** The pattern for windows (and raw attributes) that hold the start of any of `phrases`: see {@link cueAlternatives}. */
export function cuePattern(phrases: readonly string[]): string {
  const alternatives = new Set<string>();
  for (const phrase of phrases) {
    const [first, second] = phrase.split(" ");
    const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    alternatives.add(first!.length <= 4 && second ? `${escape(first!)} ?${escape(second)}` : escape(first!));
  }
  return `(?<![\\p{L}\\p{N}])(?:${[...alternatives].join("|")})`;
}
const CUE_PATTERN = cuePattern([...AUTH_CUE_PHRASES, ...BRAND_SPECS.flatMap((spec) => spec.lexicon)]);
/** A window (normalised, lower case) that holds the start of a cue phrase. */
export const WINDOW_CUE = new RegExp(CUE_PATTERN, "u");
/** The same test on an attribute as written, no normalisation: the cheap first tier. */
const RAW_CUE = new RegExp(CUE_PATTERN, "iu");
/**
 * Words of the brand lexicon that are not auth wording (`google`, `microsoft`, `calendly`, ...), derived from it. When an
 * attribute has more cue windows than the cap, windows holding one of these come before windows that only repeat a
 * sign-in word: a phrase of a brand is what decides, repeated `sign in` text is how a label is padded (#1458).
 */
const BRAND_WORDS = (() => {
  const auth = new Set([...AUTH_CUE_PHRASES, "with", "account", "in"].flatMap((phrase) => phrase.split(" ")));
  return [...new Set(BRAND_SPECS.flatMap((spec) => spec.lexicon).flatMap((phrase) => phrase.split(" ")).filter((word) => !auth.has(word)))];
})();
const BRAND_WINDOW = new RegExp(`(?<![\\p{L}\\p{N}])(?:${BRAND_WORDS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "u");
/** Windows past an attribute's first that the page may read, how they are shared, and the most one attribute adds. */
const SEQUENTIAL_WINDOW_BUDGET = 10_000;
const SHARED_WINDOW_BUDGET = 10_000;
const MAX_WINDOWS_PER_CONTROL = 160;
const WINDOWS_PER_ATTRIBUTE = 40;
/** Logo `alt` texts per control: how many are read in full, and how many are kept at all. */
const FULL_ALTS_PER_CONTROL = 4;
const MAX_ALTS_PER_CONTROL = 100;
/** Windows every control with long attributes gets past each attribute's first, outside the page budgets (#1459). */
const FLOOR_WINDOWS_PER_CONTROL = 2;
/** The page's window budgets. A mutable object so a test can lower them to exercise the exhausted path. */
export const integrityLimits = { sequentialWindows: SEQUENTIAL_WINDOW_BUDGET, sharedWindows: SHARED_WINDOW_BUDGET };

/**
 * One control's read: at most `SHORT_VISITS` nodes looked at (text or not) and `SHORT_CHARS` characters kept.
 * That is a ceiling, not an entitlement: see {@link TOTAL_VISITS}.
 */
const SHORT_VISITS = 256;
const SHORT_CHARS = 2_000;
/** Long read: the most relevant controls that the short read cut, while the long budget lasts. */
const LONG_VISITS = 4_000;
const LONG_CHARS = 20_000;
const LONG_BUDGET_VISITS = 40_000;
/**
 * Visits over ALL controls' short reads. A page can multiply per-control bounds (a hundred thousand
 * controls, or controls nested in controls, each at its ceiling), so the page as a whole has this much
 * to spend, shared fairly: a control's allowance is what is left divided by the controls still to read
 * (never below `MIN_ALLOWANCE`, so a plain link is always read), so cheap controls leave their surplus to
 * later ones and no number of decoys before the real control can starve it.
 */
const TOTAL_VISITS = 400_000;
const MIN_ALLOWANCE = 4;
const MAX_LABELLEDBY = 4;
/** Templates read per page (nested ones included); a page with more is not read past them. */
const MAX_TEMPLATES = 5_000;
/** Controls given a full prepare (attributes, rank): the most relevant by what a destination alone shows, the rest counted unread. */
const MAX_PREPARED = 60_000;
/**
 * A style attribute is read up to this many characters, once per element (the answer is cached, so a control nested around a big
 * one does not re-read it). Past it the read of the control is reported as cut, not silently taken as visible (#1423).
 */
const STYLE_ATTR_CHARS = 1_048_576;
const styleHiddenCache = new WeakMap<Element, boolean>();

function styleHides(el: Element, style: string): boolean {
  const cached = styleHiddenCache.get(el);
  if (cached !== undefined) return cached;
  const hides = HIDDEN_STYLE.test(style.length > STYLE_ATTR_CHARS ? style.slice(0, STYLE_ATTR_CHARS) : style);
  styleHiddenCache.set(el, hides);
  return hides;
}
const SCAN_SELECTOR = "a[href], button, input, [role='button'], form[id], img[alt], template";
/** Destination paths a sign-in control points at; a control to one of these is read before an ordinary link. */
const AUTH_PATH = /(sign-?in|log-?in|oauth|auth|sso|account)/i;
/** Subtrees that render as no text: reading them would let `Sign<script>0</script> in` hide a label. */
const UNRENDERED = new Set(["script", "style", "noscript", "template"]);
const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|em|rem|%|pt)?|opacity\s*:\s*0(?:\.0+)?)\s*(?:!important\s*)?(?:;|$)/i;

interface Chunk {
  text: string;
  hidden: boolean;
}

interface Hidden {
  classes: Set<string>;
  ids: Set<string>;
}

/** The label of `el` from its descendants' text, at most `maxVisits` nodes looked at and `maxChars` characters kept. */
function readChunks(
  el: Element,
  maxVisits: number,
  maxChars: number,
  hiddenBy: Hidden,
): { chunks: Chunk[]; visits: number; cut: boolean } {
  const chunks: Chunk[] = [];
  let chars = 0;
  let visits = 0;
  // Iterative walk, hidden-ness inherited: a stack of [node, hidden].
  let styleCut = false;
  const stack: Array<[Node, boolean]> = [];
  const push = (parent: Node, hidden: boolean): void => {
    const kids = parent.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, hidden]);
  };
  push(el, false);
  while (stack.length > 0) {
    if (visits >= maxVisits || chars >= maxChars) return { chunks, visits, cut: true };
    const [node, hidden] = stack.pop()!;
    visits++;
    if (node.nodeType === 3) {
      const text = (node as Text).data;
      if (text) {
        chunks.push({ text, hidden });
        chars += text.length;
      }
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (UNRENDERED.has(child.tagName.toLowerCase())) continue;
      let nowHidden = hidden;
      if (!hidden && child.attributes.length > 0) {
        const style = getAttrCI(child, "style");
        if (style !== null && style.length > STYLE_ATTR_CHARS) styleCut = true;
        const cls = getAttrCI(child, "class");
        const id = getAttrCI(child, "id");
        nowHidden =
          getAttrCI(child, "hidden") !== null ||
          getAttrCI(child, "aria-hidden")?.toLowerCase() === "true" ||
          (style !== null && styleHides(child, style)) ||
          (cls !== null && cls.toLowerCase().split(/\s+/).some((c) => hiddenBy.classes.has(c))) ||
          (id !== null && hiddenBy.ids.has(id.toLowerCase()));
      }
      push(child, nowHidden);
    }
  }
  return { chunks, visits, cut: styleCut };
}

function formsOf(label: Chunk[]): string[] {
  const visible = label.filter((c) => !c.hidden);
  return [
    label.map((c) => c.text).join(""),
    label.map((c) => c.text).join(" "),
    visible.map((c) => c.text).join(""),
    visible.map((c) => c.text).join(" "),
  ];
}

function isControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  // `a[href]` is what the scan selects, so a link here has its destination.
  if (tag === "a") return true;
  if (tag === "button") return true;
  if (tag === "input") {
    const type = (getAttrCI(el, "type") ?? "").toLowerCase();
    return type === "submit" || type === "button" || type === "image";
  }
  return (getAttrCI(el, "role") ?? "").toLowerCase() === "button";
}

type Root = { querySelectorAll(selector: string): ArrayLike<Element> };

/** The relevance of a control from what costs nothing to read (see {@link scanControls}). */
export function rank(tag: string, target: string | null, extra: string[], localIsOwn = true): number {
  // No destination (a script-driven button with no form): there is nothing to judge, so nothing to read.
  if (target === null) return 0;
  if (extra.some((text) => AUTH_LABEL.test(readable(text.slice(0, ATTR_CHARS))))) return 3;
  if (tag !== "a") return 2;
  // A `<base href>` that moves the site makes every relative destination (an empty one included) another host's: read first and counted if cut.
  if (!localIsOwn) return 2;
  // `target` is the destination as the parser reads it (see `urlText`), the same text `shortlist()` decided on, computed once per control.
  if (target && (offSiteText(target) || AUTH_PATH.test(target.slice(0, MAX_AUTH_PATH_CHARS)))) return 2;
  return 1;
}

/** Longest destination read for a sign-in path: a path or query padded past it is still read, up to this. */
const MAX_AUTH_PATH_CHARS = 8_192;

/**
 * Whether a destination may leave the page's own site, judged on the text the way a URL parser reads it: a protocol-
 * relative one (`//host`, and `\\host`, `/\host` and `\/host`, a backslash being a slash in a special URL), a scheme
 * with slashes, or an http(s), ws(s) or ftp scheme with or without them (`http:host` on an https page is
 * `http://host`). Leans toward "may": a wrong yes only costs a read. Property-tested against `new URL(href, base)`.
 */
export function looksOffSite(href: string): boolean {
  return offSiteText(urlText(href));
}

function offSiteText(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}/i.test(target) || /^(?:https?|wss?|ftp):/i.test(target);
}

/**
 * A URL as the parser sees it: leading control characters and spaces and every tab and newline are removed
 * (WHATWG URL parsing), so `/<TAB>/host/path` is the protocol-relative `//host/path`, not a root-relative path.
 */
export function urlText(href: string): string {
  // oxlint-disable-next-line no-control-regex
  return href.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
}

/** A destination that is plainly on the page's own site: a root-relative path, a fragment, a query or a bare relative path. */
export const PLAIN_LOCAL_HREF = /^(?:\/(?![/\\])|#|\?|[\w.~-]+(?:[/?#][^:\\]*)?$)/;

/**
 * The controls worth a full prepare, in the order they get it. A link whose destination is plainly the
 * page's own site cannot be off-brand, so one with no attribute that could carry a sign-in cue (`aria-label`,
 * `title`, `aria-labelledby`, a logo `alt`) needs no read at all; this is what keeps a page of hundreds of
 * thousands of ordinary links inside the time budget. Links to other hosts or sign-in paths come after buttons.
 * More than {@link MAX_PREPARED} are cut, the least relevant first, and counted unread.
 */
/**
 * Attributes of one control that are looked at, each by a length test first so a junk name costs no string work. The page's work
 * budget is what bounds the total; this bounds one element, and a control with more is read as cut (counted unread).
 */
const MAX_ATTRIBUTES_PER_CONTROL = 4_096;
/** Work units (one per attribute looked at, one per control) the page may spend finding the controls' destinations and cues. */
const SHORTLIST_ATTRIBUTE_BUDGET = 2_000_000;
/** The same for reading each prepared control's label attributes. */
const PREPARE_ATTRIBUTE_BUDGET = 1_500_000;

/** A control's attributes as one pass reads them: the names compared by length first, so a junk name costs no string work. */
export interface ControlAttributes {
  href: string | null;
  cue: boolean;
  ariaLabel: string | null;
  title: string | null;
  value: string | null;
  alt: string | null;
  labelledby: string | null;
  /** The element had more attributes than {@link MAX_ATTRIBUTES_PER_CONTROL}. */
  overlong: boolean;
  /** Attributes looked at: what the page's attribute budget is charged. */
  scanned: number;
}

/** One pass over the first {@link MAX_ATTRIBUTES_PER_CONTROL} attributes, past the 64th as well. The first of each name wins, as in a browser. */
export function readControlAttributes(el: Element): ControlAttributes {
  const out: ControlAttributes = { href: null, cue: false, ariaLabel: null, title: null, value: null, alt: null, labelledby: null, overlong: false, scanned: 0 };
  const attrs = el.attributes;
  const total = attrs.length;
  const limit = total > MAX_ATTRIBUTES_PER_CONTROL ? MAX_ATTRIBUTES_PER_CONTROL : total;
  out.overlong = total > limit;
  out.scanned = limit;
  for (let k = 0; k < limit; k++) {
    const attr = attrs[k]!;
    const name = attr.name;
    switch (name.length) {
      case 3:
        if (out.alt === null && name.toLowerCase() === "alt") out.alt = attr.value;
        break;
      case 4:
        if (out.href === null && name.toLowerCase() === "href") out.href = attr.value;
        break;
      case 5:
        if (out.title === null && name.toLowerCase() === "title") {
          out.title = attr.value;
          out.cue = true;
        } else if (out.value === null && name.toLowerCase() === "value") out.value = attr.value;
        break;
      case 10:
        if (out.ariaLabel === null && name.toLowerCase() === "aria-label") {
          out.ariaLabel = attr.value;
          out.cue = true;
        }
        break;
      case 15:
        if (out.labelledby === null && name.toLowerCase() === "aria-labelledby") {
          out.labelledby = attr.value;
          out.cue = true;
        }
        break;
    }
  }
  return out;
}

/** What `scanControls` spends the page's attribute work on: a mutable object so a test can lower the budgets. */
export const attributeLimits = { shortlist: SHORTLIST_ATTRIBUTE_BUDGET, prepare: PREPARE_ATTRIBUTE_BUDGET };

/** A test hook, off in production: when `enabled`, counts the distinct `aria-labelledby` targets whose text was read. */
export const integrityCounters = { enabled: false, targetReads: 0 };

export function shortlist(
  found: Element[],
  destinationOf: (el: Element) => string | null,
  hasLogo: (el: Element) => boolean,
  localIsOwn = true,
  budget: { left: number } = { left: Infinity },
): { chosen: Array<{ element: Element; href: string; target: string; order: number; read: ControlAttributes }>; cut: number } {
  type Entry = { element: Element; href: string; target: string; order: number; read: ControlAttributes };
  const first: Entry[] = [];
  const second: Entry[] = [];
  // Controls not looked at because the page's attribute budget ran out: counted as unread, never silently clean.
  let unexamined = 0;
  for (const [order, el] of found.entries()) {
    if (budget.left <= 0) {
      unexamined++;
      continue;
    }
    const isLink = el.tagName.toLowerCase() === "a";
    // One pass over the attributes: a link's first `href` (what a browser keeps) and whether any attribute could carry a cue.
    const read = readControlAttributes(el);
    budget.left -= 1 + read.scanned;
    const cue = read.cue;
    let href: string | null = isLink ? read.href : null;
    if (!isLink) href = destinationOf(el);
    // No destination (a script-driven button with no form): nothing to judge, nothing to read.
    // A link whose attributes were cut at the 64th may have its `href` past the cut: that is not "no destination", it is unread.
    if (href === null) {
      if (isLink && read.overlong) unexamined++;
      continue;
    }
    const normalised = urlText(href);
    // A plainly local destination is the page's own site only while no `<base href>` moves where relative URLs resolve.
    if (localIsOwn && (normalised === "" || PLAIN_LOCAL_HREF.test(normalised))) {
      if (cue || hasLogo(el)) first.push({ element: el, href, target: normalised, order, read });
      // A cue attribute past the cut would have made it a candidate: counted, not skipped silently.
      else if (read.overlong) unexamined++;
      continue;
    }
    // Off-site links are NOT promoted here (rank() reads them first once prepared): thousands of decoy links to other hosts must not fill the prepare cap ahead of a real control.
    (!isLink || AUTH_PATH.test(normalised.slice(0, MAX_AUTH_PATH_CHARS)) ? first : second).push({
      element: el,
      href,
      target: normalised,
      order,
      read,
    });
  }
  const all = first.concat(second);
  return { chosen: all.slice(0, MAX_PREPARED), cut: Math.max(0, all.length - MAX_PREPARED) + unexamined };
}

const scanCache = new WeakMap<object, ControlScan>();

/**
 * The `href` of the first `<base>` a browser honours, found in one iterative pass over the document in document order: a subtree
 * under `<noscript>` or `<template>` is skipped, a `<base>` inside `<svg>` or `<math>` is another namespace and ignored, and the
 * children of `<foreignObject>` are HTML again. The pass is linear, has no depth bound (a bound would let nesting decide which base
 * wins), and stops at the first honoured `<base href>`.
 */
function firstHonouredBaseHref(doc: Document): string | null {
  const root = doc.documentElement;
  if (!root) return null;
  const stack: Array<{ element: Element; foreign: boolean }> = [{ element: root, foreign: false }];
  while (stack.length > 0) {
    const { element, foreign } = stack.pop()!;
    const tag = element.tagName.toLowerCase();
    if (tag === "noscript" || tag === "template") continue;
    if (tag === "base" && !foreign) {
      const href = getAttrCI(element, "href");
      if (href !== null) return href;
    }
    const childForeign = tag === "foreignobject" ? false : foreign || tag === "svg" || tag === "math";
    // pushed in reverse so the first child is popped first: document order
    // `children` builds a new list on every access in some DOMs: read it once per element
    const children = element.children;
    for (let k = children.length - 1; k >= 0; k--) stack.push({ element: children[k]!, foreign: childForeign });
  }
  return null;
}

const baseHrefCache = new WeakMap<object, string | null>();

/**
 * The `href` of the first `<base>` element a browser would use: in the HTML namespace and in the document's own tree, so not one
 * inside `<noscript>` (not parsed as elements with scripting on), `<template>` (a separate fragment), `<svg>` or `<math>` (another
 * namespace; an element inside `<foreignObject>` is HTML again). The answer is computed once per document.
 */
export function documentBaseHref(doc: Document): string | null {
  const cached = baseHrefCache.get(doc);
  if (cached !== undefined) return cached;
  const found = firstHonouredBaseHref(doc);
  baseHrefCache.set(doc, found);
  return found;
}

/**
 * Whether a `<base href>` moves where relative URLs resolve: the first one with an `href` (what a browser uses) that is not itself a
 * plainly local path. Then `/signin` is not the page's own site, and a link or form to it is read like any other destination (#1423).
 */
export function baseMovesRelativeUrls(doc: Document): boolean {
  const href = documentBaseHref(doc);
  if (href === null) return false;
  const text = urlText(href);
  return !(text === "" || PLAIN_LOCAL_HREF.test(text));
}

/**
 * The page's sign-in controls (links, buttons, `input type=submit|button|image`, `role=button`) with the
 * destination they would send the user to and every readable form of their label: text as written and
 * with a break at each element, text without hidden descendants (inline or class-hidden, `aria-hidden`,
 * zero-size or transparent text), `aria-label`, `aria-labelledby`, `title`, `value` and the `alt` of a logo
 * image inside. Controls in `<template>`s (nested ones too) are read like the rest.
 *
 * Every control is listed and every one gets a short read, so a page cannot starve the real control by
 * padding before it. The most relevant (a sign-in attribute, then buttons and links to another host or a
 * sign-in path) also get a long read while a page-wide budget lasts; `unread` counts relevant controls whose
 * read was cut by the bounds, so a caller can say so.
 */
export function scanControls(doc: Document): ControlScan {
  const cached = scanCache.get(doc);
  if (cached) return cached;
  const hiddenBy = hiddenSelectors(doc);

  // One pass per root (the document, then each `<template>`, nested ones included, as a worklist) finds the
  // controls, forms with an id, logo images and templates together: every selector call walks the whole tree.
  // A template's parsed children stay on the template node, so `template.querySelectorAll` reads them in place:
  // `.content` would deep-clone them on first access, which is quadratic on templates nested in templates.
  // The worklist is bounded.
  const roots: Root[] = [doc];
  let templatesCut = 0;
  const found: Element[] = [];
  const forms = new Map<string, Element>();
  const images: Element[] = [];
  for (let i = 0; i < roots.length; i++) {
    for (const el of Array.from(roots[i]!.querySelectorAll(SCAN_SELECTOR))) {
      const tag = el.tagName.toLowerCase();
      if (tag === "template") {
        // A template with no element inside holds no control: it costs nothing and is not counted.
        if (el.children.length === 0) continue;
        if (roots.length <= MAX_TEMPLATES) roots.push(el);
        else templatesCut++;
        continue;
      }
      if (isControl(el)) found.push(el);
      if (tag === "form") {
        const id = getAttrCI(el, "id");
        if (id && !forms.has(id)) forms.set(id, el);
      } else if (tag === "img") images.push(el);
    }
  }
  // Only built when the page has logo images to place.
  const index = images.length > 0 ? new Set(found) : new Set<Element>();

  // Looking up an element's nearest control or form from below is memoised along the path, so a deep page costs
  // its number of nodes, not nodes times depth.
  const memoAbove = (found: (el: Element) => boolean) => {
    const memo = new Map<Element, Element | null>();
    return (start: Element | null): Element | null => {
      const path: Element[] = [];
      let at = start;
      let result: Element | null = null;
      while (at) {
        const known = memo.get(at);
        if (known !== undefined) {
          result = known;
          break;
        }
        if (found(at)) {
          result = at;
          memo.set(at, at);
          break;
        }
        path.push(at);
        at = at.parentElement;
      }
      for (const element of path) memo.set(element, result);
      return result;
    };
  };
  const controlAbove = memoAbove((el) => index.has(el));
  const formAbove = memoAbove((el) => el.tagName.toLowerCase() === "form");

  // A logo's `alt` belongs to the control it sits in.
  const imageAlts = new Map<Element, string[]>();
  const altsCut = new Set<Element>();
  for (const img of images) {
    const alt = getAttrCI(img, "alt");
    if (!alt) continue;
    const control = controlAbove(img.parentElement);
    if (control) {
      const list = imageAlts.get(control) ?? [];
      // A control holds a few logos: the first ones are read in full, the next only for their first characters, and
      // past MAX_ALTS_PER_CONTROL none (both counted), so a control wrapping 300,000 images costs a bounded amount.
      if (list.length < MAX_ALTS_PER_CONTROL) {
        const full = list.length < FULL_ALTS_PER_CONTROL;
        // A later alt longer than the cut loses its tail: the control is counted as not read in full.
        if (!full && alt.length > ATTR_CHARS) altsCut.add(control);
        list.push(full ? alt : alt.slice(0, ATTR_CHARS));
        imageAlts.set(control, list);
      } else altsCut.add(control);
    }
  }

  const enclosingForm = (el: Element): Element | null => {
    const owner = getAttrCI(el, "form");
    if (owner && forms.has(owner)) return forms.get(owner)!;
    return formAbove(el.parentElement);
  };
  // `aria-labelledby` targets by id, built once over every root (a lookup per control per root would be
  // controls x roots).
  let ids: Map<string, Element> | undefined;
  const byId = (id: string): Element | null => {
    if (!ids) {
      ids = new Map();
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll("[id]"))) {
          const value = getAttrCI(el, "id");
          if (value && !ids.has(value)) ids.set(value, el);
        }
      }
    }
    return ids.get(id) ?? null;
  };

  // An `aria-labelledby` target's text, read once per target with the bounded walker (a page can point
  // thousands of controls at one huge element).
  const targetTexts = new Map<Element, string>();
  // Visits the targets' reads cost: charged to the page's visits (TOTAL_VISITS) before the controls' own reads share what is left.
  let targetVisits = 0;
  // The most the targets' reads may cost, checked BEFORE each read: a page of thousands of distinct targets cannot spend more.
  const targetBudget = (TOTAL_VISITS * 3) / 4;
  /** A target's text, or null when the page's target budget is spent and the target is not read (the control is then counted cut). */
  const targetText = (target: Element): string | null => {
    const known = targetTexts.get(target);
    if (known !== undefined) return known;
    if (targetVisits >= targetBudget) return null;
    const read = readChunks(target, SHORT_VISITS, ATTR_CHARS, hiddenBy);
    targetVisits += read.visits;
    if (integrityCounters.enabled) integrityCounters.targetReads++;
    const text = read.chunks
      .map((c) => c.text)
      .join("")
      .slice(0, ATTR_CHARS);
    targetTexts.set(target, text);
    return text;
  };

  // A link's destination is its href; a button's is its formaction or its form's action, else none.
  const destinationOf = (el: Element): string | null => {
    if (el.tagName.toLowerCase() === "a") return getAttrCI(el, "href");
    const formaction = getAttrCI(el, "formaction");
    if (formaction !== null) return formaction;
    const form = enclosingForm(el);
    return form ? (getAttrCI(form, "action") ?? "") : null;
  };
  const localIsOwn = !baseMovesRelativeUrls(doc);
  const { chosen, cut: notPrepared } = shortlist(found, destinationOf, (el) => imageAlts.has(el), localIsOwn, { left: attributeLimits.shortlist });
  // Controls whose attribute text or `aria-labelledby` list was longer than what is read, or that a window cap cut: counted, not hidden.
  const cutControls = new Set<number>();
  // Phase 1: each control's attribute windows, and whether an attribute holds a sign-in or brand word as written (a
  // cheap test on the raw text; a look-alike spelling misses it and is served in the second tier, never skipped).
  const prepareBudget = { left: attributeLimits.prepare };
  const gathered = chosen.map(({ element, href, target, order, read }) => {
    const tag = element.tagName.toLowerCase();
    // The attributes were read once when the controls were listed; here only what they name is looked up. The page's budget is
    // charged per control and per `aria-labelledby` id; a control the budget no longer covers keeps its destination and is counted cut.
    const covered = prepareBudget.left > 0;
    const referenced = covered ? (read.labelledby ?? "").slice(0, ATTR_RAW_CHARS).split(/\s+/).filter(Boolean) : [];
    prepareBudget.left -= 1 + Math.min(referenced.length, MAX_LABELLEDBY);
    let cut = referenced.length > MAX_LABELLEDBY || altsCut.has(element) || read.overlong || !covered;
    const labelled: string[] = [];
    for (const id of referenced.slice(0, MAX_LABELLEDBY)) {
      const target = byId(id);
      if (target === null) continue;
      const text = targetText(target);
      if (text === null) cut = true;
      else labelled.push(text);
    }
    const raw = (covered
      ? [read.ariaLabel, read.title, tag === "input" ? read.value : null, tag === "input" ? read.alt : null, ...labelled, ...(imageAlts.get(element) ?? [])]
      : []
    ).filter((v): v is string => typeof v === "string" && v !== "");
    const rawCue = raw.some((v) => RAW_CUE.test(v.length > ATTR_RAW_CHARS ? v.slice(0, ATTR_RAW_CHARS) : v));
    const windows = raw.map((v) => {
      const bounded = boundedAttribute(v);
      cut ||= bounded.cut;
      return bounded.texts.filter((text) => text !== "");
    });
    return { element, tag, href, target, order, rawCue, windows, cut };
  });

  // Phase 2: windows past an attribute's first are read only where a cue word is in them (a window without one cannot
  // match), at most WINDOWS_PER_ATTRIBUTE per attribute (its first ones and its last). Two page budgets: the first is
  // spent in order (controls with a cue word as written first, then document order), so the first controls of the
  // page always get full reads however much padding follows them; the second is shared fairly over the controls
  // still cut, so padding in front cannot take everything either. What neither covers is counted, so the info note
  // is emitted even when nothing matched.
  const wanted = gathered.map((item) =>
    item.windows.flatMap((windows) => {
      const found = windows.slice(1).filter((window) => WINDOW_CUE.test(window));
      if (found.length <= WINDOWS_PER_ATTRIBUTE) return found;
      item.cut = true;
      // Over the cap, windows with a brand word come first, then the ones that only repeat a sign-in word.
      return [...found.filter((window) => BRAND_WINDOW.test(window)), ...found.filter((window) => !BRAND_WINDOW.test(window))].slice(
        0,
        WINDOWS_PER_ATTRIBUTE,
      );
    }),
  );
  // Every control with long attributes keeps a small floor outside the budgets, so no run of earlier controls can leave
  // a later one with only its first window.
  const served = wanted.map((want) => Math.min(want.length, FLOOR_WINDOWS_PER_CONTROL));
  const servingOrder = gathered
    .map((_, index) => index)
    .sort((a, b) => Number(!gathered[a]!.rawCue) - Number(!gathered[b]!.rawCue) || gathered[a]!.order - gathered[b]!.order);
  let sequential = integrityLimits.sequentialWindows;
  for (const index of servingOrder) {
    if (sequential <= 0) break;
    const take = Math.min(wanted[index]!.length - served[index]!, MAX_WINDOWS_PER_CONTROL - served[index]!, sequential);
    if (take <= 0) continue;
    served[index]! += take;
    sequential -= take;
  }
  let shared = integrityLimits.sharedWindows;
  // The shared half goes to controls without a cue word as written first: they are rare, and the cue-bearing ones
  // had the sequential half (#1459).
  const stillCut = [...servingOrder.filter((index) => !gathered[index]!.rawCue), ...servingOrder.filter((index) => gathered[index]!.rawCue)].filter(
    (index) => served[index]! < wanted[index]!.length,
  );
  for (const [turn, index] of stillCut.entries()) {
    if (shared <= 0) break;
    const share = Math.max(1, Math.floor(shared / (stillCut.length - turn)));
    const take = Math.min(wanted[index]!.length - served[index]!, MAX_WINDOWS_PER_CONTROL - served[index]!, share, shared);
    if (take <= 0) continue;
    served[index]! += take;
    shared -= take;
  }
  const prepared = gathered.map((item, index) => {
    const want = wanted[index]!;
    const count = served[index]!;
    // The first windows it was served and the last: padding is at the ends as often as in the middle.
    const taken = count >= want.length ? want : count === 0 ? [] : [...want.slice(0, count - 1), want[want.length - 1]!];
    if (count < want.length) item.cut = true;
    if (item.cut) cutControls.add(index);
    const extra = [...item.windows.flatMap((windows) => windows.slice(0, 1)), ...taken];
    return { element: item.element, href: item.href, extra, rank: rank(item.tag, item.target, extra, localIsOwn) };
  });
  // The window arrays are not needed past this point: free them before the reads below.
  gathered.length = 0;
  wanted.length = 0;
  served.length = 0;
  imageAlts.clear();

  // Reading order: most relevant first, document order within a rank. Controls with no destination (rank 0)
  // are not read at all. Each read is bounded by a fair share of the page's visits (see TOTAL_VISITS).
  const order = prepared
    .map((_, i) => i)
    .filter((i) => prepared[i]!.rank > 0)
    .sort((a, b) => prepared[b]!.rank - prepared[a]!.rank || a - b);
  const reads: Array<ReturnType<typeof readChunks> | undefined> = Array.from({ length: prepared.length });
  // What the `aria-labelledby` target reads cost comes off the page's visits; they stop at three quarters of them, so a control's own read stays possible.
  let spend = TOTAL_VISITS - Math.min(targetVisits, targetBudget);
  let longBudget = LONG_BUDGET_VISITS;
  for (const [position, i] of order.entries()) {
    const item = prepared[i]!;
    const allowance = Math.min(SHORT_VISITS, Math.max(MIN_ALLOWANCE, Math.floor(spend / (order.length - position))));
    let read = readChunks(item.element, allowance, SHORT_CHARS, hiddenBy);
    spend -= read.visits;
    if (read.cut && longBudget > 0 && item.rank >= 2) {
      read = readChunks(item.element, LONG_VISITS, LONG_CHARS, hiddenBy);
      longBudget -= read.visits;
    }
    reads[i] = read;
    // A control counts once, whichever of its bounds it hit: its attributes, its window caps and its text read share one entry.
    if (read.cut && item.rank >= 2) cutControls.add(i);
  }
  const unread = notPrepared + cutControls.size;

  const controls = prepared.map((item, i) => {
    const read = reads[i];
    // Deduplicated before the (costly) normalisation, not after.
    const raw = new Set([...(read ? formsOf(read.chunks) : []), ...item.extra]);
    const labels = [...new Set([...raw].flatMap((text) => digitForms(readable(text))).filter((f) => f.trim() !== ""))];
    return {
      element: item.element,
      href: item.href,
      labels,
      squashed: [...new Set(labels.map((l) => l.replace(/ /g, "")))],
    };
  });
  const scan = { controls, unread, templatesUnread: templatesCut, hiddenCssTruncated: hiddenBy.truncated };
  scanCache.set(doc, scan);
  return scan;
}

/** {@link scanControls}'s controls. */
export function collectControls(doc: Document): Control[] {
  return scanControls(doc).controls;
}
