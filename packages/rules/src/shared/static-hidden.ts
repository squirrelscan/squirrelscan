// Whether an element is out of the accessibility tree, as far as its markup,
// its inline `style` attributes and the page's own `<style>` blocks say
// (pub#664, pub#665, pub#671, pub#678). Shared by the a11y naming rules and
// a11y/aria-hidden-focus, so they agree on what is hidden.
//
// Read: the `hidden` attribute (not `hidden="until-found"`), a closed
// `<dialog>` and an unopened `popover` (the user-agent stylesheet hides all
// three), a `<template>` ancestor, `aria-hidden="true"` when the caller asks,
// an inline `style` that plainly sets `display` or `visibility`, and the
// narrow subset of `<style>` rules that shared/page-styles.ts can decide.
//
// Not read: external stylesheets. When a page has one, hiding that comes from
// a `<style>` block is "unknown", since an external rule could show the
// element again. Anything the readers cannot settle exactly makes the answer
// "unknown", reported as unconfirmed, never "hidden".

import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

import type { CheckResult } from "../types";

import {
  cascade,
  type Declared,
  type DisplayValue,
  pageStylesFor,
  readDeclarations,
  type VisibilityValue,
} from "./page-styles";

export type StaticVisibility = { state: "shown" } | { state: "hidden" } | { state: "unknown" };

/** Item label for a control reported as unconfirmed. */
export const UNCONFIRMED_LABEL =
  "a style on it or an ancestor sets display or visibility in a way squirrel cannot settle";

export interface StaticVisibilityOptions {
  /** Count `aria-hidden="true"` on the element or an ancestor as hidden. */
  ariaHidden: boolean;
  /**
   * Treat a closed `<dialog>` as shown (pub#671). For a check of the dialog
   * itself: a native dialog is served closed and opened by script, so its
   * name is checked as it will be once open. Hiding it any other way still
   * counts.
   */
  closedDialogsShown?: boolean;
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

function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Reads `display` and `visibility` from an inline `style`, strictly (see
 * readDeclarations in shared/page-styles.ts): anything but plainly written
 * declarations reads as "unknown" for both.
 */
export function readInlineStyle(style: string | null): InlineStyle {
  const decls = readDeclarations(style);
  if (decls === "unknown") return { display: "unknown", visibility: "unknown" };
  return {
    ...(decls.display ? { display: decls.display.value } : {}),
    ...(decls.visibility ? { visibility: decls.visibility.value } : {}),
  };
}

/**
 * The author `display` and `visibility` of `el`: its inline style and the
 * page's `<style>` rules, in cascade order. A value only a `<style>` rule
 * gives that hides the element is "unknown" when the page also loads an
 * external stylesheet, which could show it again.
 */
function authorStyle(el: Element): {
  display?: DisplayValue | "unknown";
  visibility?: VisibilityValue | "unknown";
  /** The page's stylesheets were all read, so inherited values are settled. */
  complete: boolean;
} {
  const decls = readDeclarations(getAttrCI(el, "style"));
  const styles = pageStylesFor(el.ownerDocument);
  if (decls === "unknown") {
    return { display: "unknown", visibility: "unknown", complete: styles?.complete ?? false };
  }
  if (!styles) {
    return {
      ...(decls.display ? { display: decls.display.value } : {}),
      ...(decls.visibility ? { visibility: decls.visibility.value } : {}),
      complete: false,
    };
  }
  const settle = <V extends string>(
    result: { value: V; source: "inline" | "sheet" } | "unknown" | undefined,
    hides: V,
  ): V | "unknown" | undefined => {
    if (result === undefined || result === "unknown") return result;
    if (result.source === "sheet" && result.value === hides && !styles.complete) return "unknown";
    return result.value;
  };
  return {
    display: settle(
      cascade(el, styles, "display", decls.display as Declared<DisplayValue> | undefined),
      "none" as DisplayValue,
    ),
    visibility: settle(
      cascade(el, styles, "visibility", decls.visibility as Declared<VisibilityValue> | undefined),
      "hidden" as VisibilityValue,
    ),
    complete: styles.complete,
  };
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
function uaHidden(el: Element, foreign: boolean, closedDialogsShown: boolean): boolean {
  const tag = tagOf(el);
  if (foreign || tag === "svg" || tag === "math" || tag === "embed" || tag === "marquee") {
    return false;
  }
  const hidden = getAttrCI(el, "hidden");
  // Keyword match without trimming: " until-found " is not the keyword.
  if (hidden !== null && asciiLower(hidden) !== "until-found") return true;
  if (tag === "dialog") return !closedDialogsShown && !hasAttrCI(el, "open");
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
   * An ancestor set `visibility:hidden` (or a form the reader cannot read)
   * and the page loads a stylesheet this module does not read, which can make
   * any descendant visible again, so the inherited hiding is not settled. A
   * plain `visibility:visible` clears it for that subtree.
   */
  visibilityUnknown: boolean;
  /**
   * An ancestor set `visibility:hidden` and every stylesheet on the page was
   * read: descendants inherit it, settled, unless they set `visible` again.
   */
  visibilityHidden: boolean;
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
  visibilityHidden: false,
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
    const author = authorStyle(el);
    // SVG and MathML presentation attributes (`<rect visibility="visible">`)
    // sit under author CSS but over inheritance; they are not read here.
    const inForeign = parent.foreign || tagOf(el) === "svg" || tagOf(el) === "math";
    if (inForeign) {
      if (author.display === undefined && hasAttrCI(el, "display")) author.display = "unknown";
      if (author.visibility === undefined && hasAttrCI(el, "visibility")) author.visibility = "unknown";
    }
    const ariaHidden =
      options.ariaHidden && asciiLower(getAttrCI(el, "aria-hidden") ?? "") === "true";
    // An author `display` beats the user-agent rule.
    const display = ariaHidden
      ? "none"
      : (author.display ??
        (uaHidden(el, parent.foreign, options.closedDialogsShown === true) ? "none" : "shown"));

    // This element's computed visibility: its own value, else its parent's.
    const own = author.visibility;
    const visibilityHidden =
      own === "hidden" || ((own === undefined || own === "inherit") && parent.visibilityHidden);
    const visibilityUnknown =
      own === "unknown" || ((own === undefined || own === "inherit") && parent.visibilityUnknown);

    const treeUnreliable = parent.treeUnreliable || treeMayDiffer(el);
    const foreign = parent.foreign || tagOf(el) === "svg" || tagOf(el) === "math";
    let children: Context;
    if (tagOf(el) === "template" && !foreign) {
      // A template's contents are never rendered, whatever its own display.
      children = { ...ROOT, removed: true };
    } else if (display === "none") {
      children = treeUnreliable
        ? {
            removed: false,
            displayUnknown: true,
            visibilityUnknown: true,
            visibilityHidden: false,
            treeUnreliable,
            foreign,
          }
        : { ...ROOT, removed: true };
    } else {
      // With every stylesheet read, a hidden ancestor's visibility is settled
      // for its descendants; otherwise an unread rule could show them again.
      children = {
        removed: false,
        displayUnknown: parent.displayUnknown || display === "unknown",
        visibilityUnknown: visibilityUnknown || (visibilityHidden && !author.complete),
        visibilityHidden: visibilityHidden && author.complete,
        treeUnreliable,
        foreign,
      };
    }

    let verdict: StaticVisibility;
    if (display === "none" || own === "hidden") verdict = HIDDEN;
    else if (display === "unknown" || parent.displayUnknown) verdict = UNKNOWN;
    else if (visibilityHidden) verdict = HIDDEN;
    else if (visibilityUnknown) verdict = UNKNOWN;
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

/**
 * A naming rule's unnamed controls, sorted by whether the rule applies to them
 * (pub#665, pub#671): out of the accessibility tree they are only counted,
 * possibly hidden by a style they are unconfirmed, and the rest fail.
 */
export interface UnnamedControls<T> {
  /** Files one unnamed control under the finding it belongs to. */
  add(el: Element, item: T): void;
  readonly failures: T[];
  readonly unconfirmed: T[];
  /** Unnamed, but out of the accessibility tree. They need a name if shown later. */
  readonly hidden: number;
}

export function sortUnnamedControls<T>(
  visibility: StaticVisibilityResolver = createStaticVisibility({ ariaHidden: true }),
): UnnamedControls<T> {
  const failures: T[] = [];
  const unconfirmed: T[] = [];
  let hidden = 0;
  return {
    add(el: Element, item: T): void {
      const seen = visibility.visibility(el);
      if (seen.state === "hidden") hidden++;
      else if (seen.state === "unknown") unconfirmed.push(item);
      else failures.push(item);
    },
    failures,
    unconfirmed,
    get hidden() {
      return hidden;
    },
  };
}

/**
 * The warn row for controls an inline style may hide, named `<check>-unconfirmed`.
 * `what` completes "N <what> may be hidden by a style (unconfirmed)".
 */
export function unconfirmedRow(
  check: string,
  what: string,
  items: Array<string | { id: string; snippet?: string }>,
): CheckResult {
  return {
    name: `${check}-unconfirmed`,
    status: "warn",
    message: `${items.length} ${what} may be hidden by a style (unconfirmed)`,
    items: items
      .slice(0, 10)
      .map((item) => ({ ...(typeof item === "string" ? { id: item } : item), label: UNCONFIRMED_LABEL })),
    ...(items.length > 10 ? { details: { additional: items.length - 10 } } : {}),
  };
}
