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

import { hiddenSelectors } from "./overlay-style";

/** Text with nothing outside ASCII (a linear test, with no backtracking). */
const ASCII_ONLY = /^\p{ASCII}*$/u;

/** Characters that render as nothing: soft hyphens, zero-width spaces and joiners, variation selectors. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Latin letters other scripts draw the same: the Cyrillic and Greek look-alikes a kit swaps in so a
 * word-bounded cue does not match, plus the dotless i. Applied after NFKC (which folds fullwidth and
 * styled letters) and lower-casing, so these are lower-case forms.
 */
const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ...Object.entries({ а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w", ӏ: "l", ѵ: "v", ѡ: "w", ԍ: "g", к: "k", т: "t", н: "h", м: "m", ү: "y", ь: "b", в: "b" }),
  // Greek
  ...Object.entries({ ο: "o", α: "a", ι: "i", ν: "v", ρ: "p", υ: "u", χ: "x", ε: "e", κ: "k", τ: "t", β: "b", η: "n", ω: "w", μ: "u", γ: "y" }),
  // Armenian
  ...Object.entries({ օ: "o", ս: "u", ո: "n", հ: "h", ց: "g", ք: "p", ա: "a" }),
  // Latin look-alikes and small capitals
  ...Object.entries({ ɡ: "g", ı: "i", ɑ: "a", ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z", ǝ: "e", ȷ: "j" }),
]);
const CONFUSABLE_RUN = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

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
}

const ATTR_CHARS = 300;
/** An attribute is normalised (padding removed) over this many characters before it is cut to {@link ATTR_CHARS}. */
const ATTR_RAW_CHARS = 16_000;
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
/** A style attribute is read up to this many characters: hiding is a union of readings, so more is never needed. */
const STYLE_ATTR_CHARS = 8_192;
const SCAN_SELECTOR = "a[href], button, input, [role='button'], form[id], img[alt], template";
const AUTH_CUE = /\b(sign in|log in|login|continue with|verify)\b/;
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
        const style = getAttrCI(child, "style")?.slice(0, STYLE_ATTR_CHARS) ?? null;
        const cls = getAttrCI(child, "class");
        const id = getAttrCI(child, "id");
        nowHidden =
          getAttrCI(child, "hidden") !== null ||
          getAttrCI(child, "aria-hidden")?.toLowerCase() === "true" ||
          (style !== null && HIDDEN_STYLE.test(style)) ||
          (cls !== null && cls.toLowerCase().split(/\s+/).some((c) => hiddenBy.classes.has(c))) ||
          (id !== null && hiddenBy.ids.has(id.toLowerCase()));
      }
      push(child, nowHidden);
    }
  }
  return { chunks, visits, cut: false };
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
function rank(tag: string, href: string | null, extra: string[]): number {
  // No destination (a script-driven button with no form): there is nothing to judge, so nothing to read.
  if (href === null) return 0;
  if (extra.some((text) => AUTH_CUE.test(readable(text.slice(0, ATTR_CHARS))))) return 3;
  if (tag !== "a") return 2;
  if (href && (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(href) || AUTH_PATH.test(href.slice(0, 300)))) return 2;
  return 1;
}

/**
 * A URL as the parser sees it: leading control characters and spaces and every tab and newline are removed
 * (WHATWG URL parsing), so `/<TAB>/host/path` is the protocol-relative `//host/path`, not a root-relative path.
 */
function urlText(href: string): string {
  // oxlint-disable-next-line no-control-regex
  return href.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
}

/** A destination that is plainly on the page's own site: a root-relative path, a fragment, a query or a bare relative path. */
const PLAIN_LOCAL_HREF = /^(?:\/(?![/\\])|#|\?|[\w.~-]+(?:[/?#][^:\\]*)?$)/;

/**
 * The controls worth a full prepare, in the order they get it. A link whose destination is plainly the
 * page's own site cannot be off-brand, so one with no attribute that could carry a sign-in cue (`aria-label`,
 * `title`, `aria-labelledby`, a logo `alt`) needs no read at all; this is what keeps a page of hundreds of
 * thousands of ordinary links inside the time budget. Links to other hosts or sign-in paths come after buttons.
 * More than {@link MAX_PREPARED} are cut, the least relevant first, and counted unread.
 */
function shortlist(
  found: Element[],
  destinationOf: (el: Element) => string | null,
  hasLogo: (el: Element) => boolean,
): { chosen: Array<{ element: Element; href: string }>; cut: number } {
  const first: Array<{ element: Element; href: string }> = [];
  const second: Array<{ element: Element; href: string }> = [];
  for (const el of found) {
    const isLink = el.tagName.toLowerCase() === "a";
    let href: string | null = null;
    let cue = false;
    // One pass over the attributes: a link's first `href` (what a browser keeps) and whether any attribute could carry a cue.
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (isLink && name === "href") href ??= attr.value;
      else if (name === "aria-label" || name === "title" || name === "aria-labelledby") cue = true;
    }
    if (!isLink) href = destinationOf(el);
    // No destination (a script-driven button with no form): nothing to judge, nothing to read.
    if (href === null) continue;
    const normalised = urlText(href);
    if (normalised === "" || PLAIN_LOCAL_HREF.test(normalised)) {
      if (cue || hasLogo(el)) first.push({ element: el, href });
      continue;
    }
    (!isLink || AUTH_PATH.test(href.slice(0, 300)) ? first : second).push({ element: el, href });
  }
  const all = first.concat(second);
  return { chosen: all.slice(0, MAX_PREPARED), cut: Math.max(0, all.length - MAX_PREPARED) };
}

const scanCache = new WeakMap<object, ControlScan>();

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
  for (const img of images) {
    const alt = getAttrCI(img, "alt");
    if (!alt) continue;
    const control = controlAbove(img.parentElement);
    if (control) {
      const list = imageAlts.get(control) ?? [];
      list.push(alt.slice(0, ATTR_CHARS));
      imageAlts.set(control, list);
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
  const targetText = (target: Element): string => {
    const known = targetTexts.get(target);
    if (known !== undefined) return known;
    const read = readChunks(target, SHORT_VISITS, ATTR_CHARS, hiddenBy);
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
  const { chosen, cut: notPrepared } = shortlist(found, destinationOf, (el) => imageAlts.has(el));
  // Controls whose attribute text or `aria-labelledby` list was longer than what is read: counted, not hidden.
  let paddedAttributes = 0;
  const prepared = chosen.map(({ element, href }) => {
    const tag = element.tagName.toLowerCase();
    const referenced = (getAttrCI(element, "aria-labelledby") ?? "").slice(0, ATTR_RAW_CHARS).split(/\s+/).filter(Boolean);
    if (referenced.length > MAX_LABELLEDBY) paddedAttributes++;
    const labelled = referenced
      .slice(0, MAX_LABELLEDBY)
      .map((id) => byId(id))
      .filter((target): target is Element => target !== null)
      .map((target) => targetText(target));
    const extra = [
      getAttrCI(element, "aria-label"),
      getAttrCI(element, "title"),
      tag === "input" ? getAttrCI(element, "value") : null,
      tag === "input" ? getAttrCI(element, "alt") : null,
      ...labelled,
      ...(imageAlts.get(element) ?? []),
    ]
      .filter((v): v is string => typeof v === "string" && v !== "")
      .map((v) => {
        // Padding (spaces, zero-width characters) is dropped BEFORE the cut; a value too long even for that is counted.
        if (v.length > ATTR_RAW_CHARS) paddedAttributes++;
        return readable(v.slice(0, ATTR_RAW_CHARS)).trim().slice(0, ATTR_CHARS);
      })
      .filter((v) => v !== "");
    return { element, href, extra, rank: rank(tag, href, extra) };
  });

  // Reading order: most relevant first, document order within a rank. Controls with no destination (rank 0)
  // are not read at all. Each read is bounded by a fair share of the page's visits (see TOTAL_VISITS).
  const order = prepared
    .map((_, i) => i)
    .filter((i) => prepared[i]!.rank > 0)
    .sort((a, b) => prepared[b]!.rank - prepared[a]!.rank || a - b);
  const reads: Array<ReturnType<typeof readChunks> | undefined> = Array.from({ length: prepared.length });
  let spend = TOTAL_VISITS;
  let longBudget = LONG_BUDGET_VISITS;
  let unread = notPrepared + templatesCut + paddedAttributes;
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
    if (read.cut && item.rank >= 2) unread++;
  }

  const controls = prepared.map((item, i) => {
    const read = reads[i];
    // Deduplicated before the (costly) normalisation, not after.
    const raw = new Set([...(read ? formsOf(read.chunks) : []), ...item.extra]);
    const labels = [...new Set([...raw].map(readable).filter((f) => f.trim() !== ""))];
    return {
      element: item.element,
      href: item.href,
      labels,
      squashed: [...new Set(labels.map((l) => l.replace(/ /g, "")))],
    };
  });
  const scan = { controls, unread };
  scanCache.set(doc, scan);
  return scan;
}

/** {@link scanControls}'s controls. */
export function collectControls(doc: Document): Control[] {
  return scanControls(doc).controls;
}
