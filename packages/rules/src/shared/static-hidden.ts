// Whether an element is out of the accessibility tree, as far as its markup
// and its own inline `style` attributes say (pub#664, pub#665). Shared by
// a11y/aria-hidden-focus and a11y/button-name, so both agree on what is hidden.
//
// Read: the `hidden` attribute (not `hidden="until-found"`), a closed
// `<dialog>` and an unopened `popover` (the user-agent stylesheet hides all
// three), a `<template>` ancestor, `aria-hidden="true"` when the caller asks,
// and an inline `style` that plainly sets `display:none` or `visibility:hidden`.
//
// Not read: `<style>` blocks and external stylesheets. A selector-based CSS
// reader kept finding new ways to call a visible control hidden, which
// silently drops a real failure, so hiding by class or selector is not
// evaluated here at all. An inline style the strict reader below cannot read
// exactly makes the answer "unknown", reported as unconfirmed, never "hidden".

import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

export type StaticVisibility = { state: "shown" } | { state: "hidden" } | { state: "unknown" };

/** Item label for a control reported as unconfirmed. */
export const UNCONFIRMED_LABEL =
  "an inline style on it or an ancestor sets display or visibility in a form squirrel does not read";

export interface StaticVisibilityOptions {
  /** Count `aria-hidden="true"` on the element or an ancestor as hidden. */
  ariaHidden: boolean;
}

export interface StaticVisibilityResolver {
  visibility(el: Element): StaticVisibility;
}

const SHOWN: StaticVisibility = { state: "shown" };
const HIDDEN: StaticVisibility = { state: "hidden" };
const UNKNOWN: StaticVisibility = { state: "unknown" };

/** What one inline `style` attribute says about `display` and `visibility`. */
interface InlineStyle {
  display?: "none" | "shown" | "unknown";
  visibility?: "hidden" | "visible" | "inherit" | "unknown";
}

/**
 * `display` values a browser accepts that show the element. Anything else,
 * the two-keyword syntax included, is left "unknown" rather than guessed.
 */
const SHOWN_DISPLAY = new Set(
  (
    "block inline inline-block flex inline-flex grid inline-grid contents flow-root list-item " +
    "table inline-table table-row table-cell table-caption table-column table-column-group " +
    "table-header-group table-footer-group table-row-group initial inherit unset"
  ).split(" "),
);

/** Anything but plain printable ASCII and CSS whitespace. */
const NOT_PLAIN_ASCII = /[^\x20-\x7e\t\n\r\f]/;
/**
 * Characters that start tokens the reader does not follow: escapes, comments,
 * strings, functions (`var()`, `url()`), blocks and at-rules.
 */
const NOT_PLAIN_CSS = /[\\"'(){}[\]/*@<>]/;
const MENTIONS_HIDING = /display|visibility|\ball\b/i;

function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** A declaration's value without a trailing `!important`, and whether it had one. */
function splitImportant(value: string): { value: string; important: boolean } {
  if (!value.endsWith("important")) return { value, important: false };
  const head = value.slice(0, -"important".length).trimEnd();
  if (!head.endsWith("!")) return { value, important: false };
  return { value: head.slice(0, -1).trimEnd(), important: true };
}

/**
 * Reads `display` and `visibility` from an inline `style`, strictly. Only
 * plainly written declarations count (`display: none`, `visibility:hidden
 * !important`); a style that mentions either property in any other form
 * (escapes, comments, functions, non-ASCII, `!` elsewhere, the `all`
 * shorthand, an unlisted keyword) reads as "unknown" for both.
 */
export function readInlineStyle(style: string | null): InlineStyle {
  if (!style || !MENTIONS_HIDING.test(style)) return {};
  const unknown: InlineStyle = { display: "unknown", visibility: "unknown" };
  if (NOT_PLAIN_ASCII.test(style) || NOT_PLAIN_CSS.test(style)) return unknown;

  const out: InlineStyle = {};
  const important = { display: false, visibility: false };
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) {
      if (MENTIONS_HIDING.test(part)) return unknown;
      continue;
    }
    const prop = asciiLower(part.slice(0, colon).trim());
    if (prop === "all") return unknown;
    if (prop !== "display" && prop !== "visibility") continue;
    const split = splitImportant(asciiLower(part.slice(colon + 1).trim()));
    if (split.value.includes("!") || split.value === "") return unknown;
    // Within one style attribute, !important beats normal, then the last wins.
    if (important[prop] && !split.important) continue;
    important[prop] = split.important;
    const v = split.value;
    if (prop === "display") {
      // `revert` is left out on purpose: Chromium shows a `hidden` element
      // with `display:revert`, where the specs suggest it stays hidden.
      if (v === "none") out.display = "none";
      else if (SHOWN_DISPLAY.has(v)) out.display = "shown";
      else return unknown;
    } else if (v === "hidden" || v === "collapse") out.visibility = "hidden";
    else if (v === "visible" || v === "initial") out.visibility = "visible";
    else if (v === "inherit" || v === "unset" || v === "revert" || v === "revert-layer") {
      out.visibility = "inherit";
    } else return unknown;
  }
  return out;
}

function tagOf(el: Element): string {
  return (el.localName || el.tagName || "").toLowerCase();
}

/**
 * The user-agent stylesheet hides these HTML elements: `[hidden]`,
 * `dialog:not([open])`, `[popover]` (but not an open dialog), `template`.
 * An author `display` overrides it. `<embed hidden>` and `<marquee hidden>`
 * stay rendered in Chromium, and none of these rules reach SVG or MathML
 * elements (pub#675 review, checked in Chromium).
 */
function uaHidden(el: Element, foreign: boolean): boolean {
  const tag = tagOf(el);
  if (foreign || tag === "svg" || tag === "math" || tag === "embed" || tag === "marquee") {
    return false;
  }
  const hidden = getAttrCI(el, "hidden");
  // Keyword match without trimming: " until-found " is not the keyword.
  if (hidden !== null && asciiLower(hidden) !== "until-found") return true;
  if (tag === "dialog") return !hasAttrCI(el, "open");
  return tag === "template" || hasAttrCI(el, "popover");
}

/** Start tags that close an open `<p>` in a browser, popping whatever is inside it. */
const P_CLOSERS =
  "address, article, aside, blockquote, center, details, dialog, dir, div, dl, dd, dt, " +
  "fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, hr, " +
  "li, listing, main, menu, nav, ol, p, plaintext, pre, search, section, summary, table, ul, xmp";

/** Elements a misnested end tag or foreign-content rule can split in a browser, invisibly in the DOM. */
const ALWAYS_UNRELIABLE = new Set(
  (
    "a b big code em font i nobr s small strike strong tt u " +
    "svg math select option optgroup caption colgroup ruby rb rt rp rtc"
  ).split(" "),
);

/** What may stay inside a table part rather than be moved out ahead of the table. */
const TABLE_CHILDREN = new Map<string, Set<string>>([
  ["table", new Set("caption colgroup col thead tbody tfoot tr script template style".split(" "))],
  ["tbody", new Set("tr script template style".split(" "))],
  ["thead", new Set("tr script template style".split(" "))],
  ["tfoot", new Set("tr script template style".split(" "))],
  ["tr", new Set("td th script template style".split(" "))],
]);

/** Where a table part must sit for a browser to keep it; anywhere else its tag is ignored. */
const TABLE_PART_PARENTS = new Map<string, Set<string>>([
  ["td", new Set(["tr"])],
  ["th", new Set(["tr"])],
  ["tr", new Set(["table", "tbody", "thead", "tfoot"])],
  ["tbody", new Set(["table"])],
  ["thead", new Set(["table"])],
  ["tfoot", new Set(["table"])],
  ["caption", new Set(["table"])],
  ["colgroup", new Set(["table"])],
  ["col", new Set(["table", "colgroup"])],
]);

/**
 * Document wrappers a browser ignores or closes when they turn up around
 * content, and void elements (`<image>` becomes `<img>`), which never hold any.
 */
const IGNORED_WRAPPERS = new Set(
  (
    "head frameset frame noframes area base basefont bgsound br col embed hr img image " +
    "input keygen link meta param source track wbr"
  ).split(" "),
);

/**
 * Whether this parser's tree may keep, inside `el`, content a browser's tree
 * builder moves out of it. htmlparser2 only closes an element implied by a
 * start tag when it is the innermost open one; a browser also closes it from
 * deeper inside (`<p><span><dialog>` closes the `<p>` and the `<span>`),
 * runs the adoption agency on misnested formatting elements, moves stray
 * table content ahead of the table and breaks HTML out of `<svg>` (pub#675
 * review, checked in Chromium).
 */
function treeMayDiffer(el: Element): boolean {
  const tag = tagOf(el);
  if (ALWAYS_UNRELIABLE.has(tag) || IGNORED_WRAPPERS.has(tag)) return true;
  // A second <html> or <body> start tag only lends the real one its attributes.
  if (tag === "html") return el !== el.ownerDocument?.documentElement;
  if (tag === "body") return el !== el.ownerDocument?.body;
  const parents = TABLE_PART_PARENTS.get(tag);
  if (parents && !parents.has(tagOf(el.parentElement ?? el))) return true;
  if (tag === "p") return el.querySelector(P_CLOSERS) !== null;
  if (tag === "li") return el.querySelector("li") !== null;
  if (tag === "dd" || tag === "dt") return el.querySelector("dd, dt") !== null;
  if (/^h[1-6]$/.test(tag)) return el.querySelector("h1, h2, h3, h4, h5, h6") !== null;
  if (tag === "button") return el.querySelector("button") !== null;
  if (tag === "td" || tag === "th") {
    return el.querySelector("td, th, tr, tbody, thead, tfoot, caption, col, colgroup") !== null;
  }
  // A nested <form> start tag is ignored, so the first </form> closes the outer one.
  if (tag === "form") return el.querySelector("form") !== null;
  if (TABLE_CHILDREN.has(tag)) {
    // Stray content anywhere in the table's structure is moved out ahead of
    // the whole table, so every table part inside counts, not only this one.
    const parts = [el, ...el.querySelectorAll("table, tbody, thead, tfoot, tr")];
    for (const part of parts) {
      const allowed = TABLE_CHILDREN.get(tagOf(part)) as Set<string>;
      for (const child of part.children) if (!allowed.has(tagOf(child))) return true;
    }
  }
  return false;
}

/** What an element passes down to its descendants. */
interface Context {
  /** A hidden ancestor-or-self removes the subtree, and the tree is reliable there. */
  removed: boolean;
  /** An ancestor-or-self may hide the subtree, but that is not settled. */
  displayUnknown: boolean;
  /**
   * An ancestor set `visibility:hidden` (or a form the reader cannot read).
   * A stylesheet rule can make any descendant visible again, so inherited
   * hiding is never taken as settled; a plain inline `visibility:visible`
   * clears it for that subtree.
   */
  visibilityUnknown: boolean;
  /**
   * An ancestor-or-self is a container whose descendants a browser may move
   * out (treeMayDiffer). A hidden element at or below it hides its own
   * subtree only "unknown"-ly, since the subtree may not stay inside it.
   */
  treeUnreliable: boolean;
  /**
   * Inside `<svg>` or `<math>`. This parser cannot tell where HTML resumes
   * (`<foreignObject>`), so the HTML-only user-agent rules are not applied
   * anywhere below one: a miss, never a false "hidden".
   */
  foreign: boolean;
}

const ROOT: Context = {
  removed: false,
  displayUnknown: false,
  visibilityUnknown: false,
  treeUnreliable: false,
  foreign: false,
};

/** The verdict for one element, and the context it passes to its children. */
interface Resolved {
  verdict: StaticVisibility;
  children: Context;
}

/** A per-page resolver, memoised per element so shared ancestors are read once. */
export function createStaticVisibility(options: StaticVisibilityOptions): StaticVisibilityResolver {
  const resolved = new Map<Element, Resolved>();

  const resolve = (el: Element, parent: Context): Resolved => {
    if (parent.removed) return { verdict: HIDDEN, children: parent };
    const inline = readInlineStyle(getAttrCI(el, "style"));
    const ariaHidden =
      options.ariaHidden && asciiLower(getAttrCI(el, "aria-hidden") ?? "") === "true";
    // An author `display` beats the user-agent rule.
    const display = ariaHidden
      ? "none"
      : (inline.display ?? (uaHidden(el, parent.foreign) ? "none" : "shown"));

    const treeUnreliable = parent.treeUnreliable || treeMayDiffer(el);
    const foreign = parent.foreign || tagOf(el) === "svg" || tagOf(el) === "math";
    let children: Context;
    if (tagOf(el) === "template" && !foreign) {
      // A template's contents are never rendered, whatever its own display.
      children = { ...ROOT, removed: true };
    } else if (display === "none") {
      children = treeUnreliable
        ? { removed: false, displayUnknown: true, visibilityUnknown: true, treeUnreliable, foreign }
        : { ...ROOT, removed: true };
    } else {
      children = {
        removed: false,
        displayUnknown: parent.displayUnknown || display === "unknown",
        visibilityUnknown:
          inline.visibility === "visible"
            ? false
            : parent.visibilityUnknown ||
              inline.visibility === "hidden" ||
              inline.visibility === "unknown",
        treeUnreliable,
        foreign,
      };
    }

    let verdict: StaticVisibility;
    if (display === "none" || inline.visibility === "hidden") verdict = HIDDEN;
    else if (display === "unknown" || parent.displayUnknown) verdict = UNKNOWN;
    else if (inline.visibility === "unknown") verdict = UNKNOWN;
    else if (inline.visibility !== "visible" && parent.visibilityUnknown) verdict = UNKNOWN;
    else verdict = SHOWN;
    return { verdict, children };
  };

  return {
    visibility(el: Element): StaticVisibility {
      // Walk up to the nearest resolved ancestor, then resolve back down.
      const chain: Element[] = [];
      let node: Element | null = el;
      while (node && !resolved.has(node)) {
        chain.push(node);
        node = node.parentElement;
      }
      let context = node ? (resolved.get(node) as Resolved).children : ROOT;
      let last: Resolved | undefined = node ? resolved.get(node) : undefined;
      for (let i = chain.length - 1; i >= 0; i--) {
        last = resolve(chain[i], context);
        resolved.set(chain[i], last);
        context = last.children;
      }
      return (last as Resolved).verdict;
    },
  };
}
