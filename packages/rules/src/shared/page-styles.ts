// shared/page-styles - what a page's own `<style>` blocks say about `display`
// and `visibility` (pub#664, pub#665, pub#671, pub#678).
//
// Narrow on purpose. A rule is applied only when it is unconditional, every
// selector in its list is one compound of a tag, `.class`, `#id` and plain
// `[attr]` / `[attr=value]` parts, and its declarations are plainly written.
// Anything else that sets `display` or `visibility` (a combinator, a
// pseudo-class, `@media` or `@layer`, a `<style media>` or `title`, a value
// the strict reader cannot read, an animation that sets `visibility`) is kept
// as "uncertain" for the elements its subject could match, and makes their
// answer "unknown", never "hidden". A false "hidden" silently drops a real
// accessibility failure; an "unknown" only softens it to unconfirmed.
//
// One exception (pub#988): a plain `display: none` rule on plain selectors that
// sits only inside width-only `@media` queries (shared/media-widths.ts) is kept
// with the widths it covers, so the cascade can report "hidden only at some
// widths" and treat queries that cover every width as a hide.
//
// External stylesheets are not read. When a page has one (or an `@import`, or
// a `<style>` this reader skips), any external rule could show an element
// again, so hiding that comes from a `<style>` block is not taken as settled.

import { getAttrCI } from "@squirrelscan/utils";

import { parseRules } from "../content/hidden-text";
import { skipComment, stepBlocks, stripComments } from "./css-tokens";
import { readAtRuleWidths, unionWidths, type WidthSet } from "./media-widths";

/** One declared value and whether it was `!important`. */
export interface Declared<V extends string> {
  value: V;
  important: boolean;
  /**
   * A `display` that shows some elements and hides others (`contents` hides an
   * `<input>`, `<img>` or `<select>`; `inherit` and `unset` copy a parent's
   * value). Never taken as show-only (pub#940).
   */
  mixed?: true;
}

export type DisplayValue = "none" | "shown";
export type VisibilityValue = "hidden" | "visible" | "inherit";

/** What one declaration block says about the two properties, or "unknown". */
export type Declarations =
  | { display?: Declared<DisplayValue>; visibility?: Declared<VisibilityValue> }
  | "unknown";

/** A compound selector: a tag, an id, classes and plain attribute tests. */
export interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null; op?: AttrOperator }>;
}

/** An attribute match operator beyond plain `=`; only an uncertain rule's subject carries one. */
export type AttrOperator = "^=" | "$=" | "*=" | "~=" | "|=";

interface DecidableRule {
  compound: Compound;
  specificity: number;
  order: number;
  display?: Declared<DisplayValue>;
  visibility?: Declared<VisibilityValue>;
}

interface UncertainRule {
  /** The compound the selector styles, or null for one that could match any element. */
  subject: Compound | null;
  /** Whether its declaration may be `!important` (always, when it could not be read). */
  important: boolean;
  /** An animation that may run on the subject: it loses to any `!important` declaration. */
  animation?: true;
  /**
   * Its declaration for this property is plainly written and only shows
   * (`display` other than `none`, `visibility: visible`). It changes nothing
   * for an element that is shown anyway, so it matters only where something
   * else hides the element (pub#940).
   */
  shows?: true;
  /**
   * A plain `display: none` on a plain selector (pub#988), inside width-only
   * `@media` queries only: it hides the element at these widths and not at
   * the others. Read by the cascade, which collects the widths instead of
   * answering "unknown".
   */
  width?: {
    ranges: WidthSet;
    compound: Compound;
    specificity: number;
    order: number;
  };
}

type Prop = "display" | "visibility";

export interface PageStyles {
  /** Every stylesheet that applies to the page was read. */
  complete: boolean;
  /**
   * Decidable rules per property, by the lower-cased id, class, tag or
   * attribute name they need, or `*`.
   */
  decidable: Record<Prop, Map<string, DecidableRule[]>>;
  /** Uncertain rules the same way; a subject that could be anything is under `*`. */
  uncertain: Record<Prop, Map<string, UncertainRule[]>>;
  /** Rule checks left for the page. Past the bound every answer is "unknown". */
  steps: { left: number };
  /**
   * An `@keyframes` frame sets `visibility`, so a running animation may show
   * an element. (`display` is not followed: no animation runs on an element
   * with `display:none`, so one cannot show it.)
   */
  animatesVisibility: boolean;
}

const MENTIONS_HIDING = /display|visibility|\ball\b/i;
/** A rule body that may set either property or start an animation, read further. */
const MAY_SET = /display|visibility|\ball\b|animation|\\/i;
const LEADING_CSS_SPACE = /^[\t\n\f\r ]+/;
/** Style text that may matter here at all. */
const MAY_MATTER = /display|visibility|\ball\b|animation|@import|\\/i;
const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const KEYFRAME_SELECTOR = /^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/i;
/** Bounds on hostile input: style text read per page, and rules per page. */
const MAX_STYLE_CHARS = 256 * 1024;
const MAX_RULES = 5000;
const MAX_SELECTOR_CHARS = 1000;
/** Bound on the rules kept per page, so matching one element stays cheap. */
const MAX_ENTRIES = 20_000;
/** Bound on rule checks per page, across every element and rule that asks. */
const MAX_STEPS = 2_000_000;

function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

type ParsedSelector =
  | { kind: "simple"; compound: Compound; specificity: number }
  | { kind: "complex"; subject: Compound | null }
  | { kind: "pseudo-element" };

const HEX = /[0-9a-fA-F]/;
const WS = /[\t\n\f\r ]/;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && (/[-_a-zA-Z0-9]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && (/[_a-zA-Z]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

/** A backslash before a newline (or the end) escapes nothing. */
function isEscape(sel: string, i: number): boolean {
  return sel[i] === "\\" && i + 1 < sel.length && !/[\n\r\f]/.test(sel[i + 1] as string);
}

/** Whether an identifier starts at `i`: `.123`, `#1a` and `-2x` are not selectors. */
function identStartsAt(sel: string, i: number): boolean {
  if (isNameStart(sel[i]) || isEscape(sel, i)) return true;
  if (sel[i] !== "-") return false;
  return sel[i + 1] === "-" || isNameStart(sel[i + 1]) || isEscape(sel, i + 1);
}

/** Reads an identifier starting at `i`, decoding escapes. */
function readIdent(sel: string, i: number): { value: string; end: number } {
  let value = "";
  while (i < sel.length) {
    const ch = sel[i] as string;
    if (ch === "\\") {
      // A backslash before a newline ends the identifier.
      if (!isEscape(sel, i)) break;
      let j = i + 1;
      let hex = "";
      while (j < sel.length && hex.length < 6 && HEX.test(sel[j] as string)) hex += sel[j++];
      if (hex) {
        // One whitespace ends the escape; CRLF counts as one.
        if (sel[j] === "\r" && sel[j + 1] === "\n") j += 2;
        else if (j < sel.length && WS.test(sel[j] as string)) j++;
        const code = Number.parseInt(hex, 16);
        const bad = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
        value += bad ? "\ufffd" : String.fromCodePoint(code);
        i = j;
      } else {
        value += sel[j];
        i = j + 1;
      }
      continue;
    }
    if (!isIdentChar(ch)) break;
    value += ch;
    i++;
  }
  return { value, end: i };
}

/** Index just past the `(`…`)` or `[`…`]` block opening at `i`, strings respected. */
function skipBlock(sel: string, i: number): number {
  const closers: string[] = [];
  while (i < sel.length) {
    const ch = sel[i] as string;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < sel.length && sel[j] !== ch) j += sel[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === "(") closers.push(")");
    else if (ch === "[") closers.push("]");
    else if (ch === closers[closers.length - 1]) {
      closers.pop();
      if (closers.length === 0) return i + 1;
    }
    i++;
  }
  return sel.length;
}

/**
 * `[name]` or `[name=value]` with a plain value and no flag; null for anything
 * else. Names and unquoted values are identifiers (`-2` is a number, not one),
 * and a quoted value holds no newline.
 */
function readPlainAttr(inner: string): { name: string; value: string | null } | null {
  const m =
    /^[\t\n\f\r ]*((?:--|-?[_a-zA-Z])[-_a-zA-Z0-9]*)[\t\n\f\r ]*(?:=[\t\n\f\r ]*(?:"([^"\\\n\r\f]*)"|'([^'\\\n\r\f]*)'|((?:--|-?[_a-zA-Z])[-_a-zA-Z0-9]*))[\t\n\f\r ]*)?$/.exec(
      inner,
    );
  if (!m) return null;
  return { name: asciiLower(m[1] as string), value: m[2] ?? m[3] ?? m[4] ?? null };
}

/**
 * `[name op value]` with a quoted or identifier value and an optional `i` or
 * `s` flag. Case is not tracked: a value is compared case-insensitively, a
 * superset of what a browser matches. Null for anything else.
 */
function readOperatorAttr(
  inner: string,
): { name: string; value: string; op: AttrOperator } | null {
  const m =
    /^[\t\n\f\r ]*((?:--|-?[_a-zA-Z])[-_a-zA-Z0-9]*)[\t\n\f\r ]*([~|^$*]=)[\t\n\f\r ]*(?:"([^"\\\n\r\f]*)"|'([^'\\\n\r\f]*)'|((?:--|-?[_a-zA-Z])[-_a-zA-Z0-9]*))(?:[\t\n\f\r ]*[iIsS])?[\t\n\f\r ]*$/.exec(
      inner,
    );
  if (!m) return null;
  return {
    name: asciiLower(m[1] as string),
    op: m[2] as AttrOperator,
    value: (m[3] ?? m[4] ?? m[5]) as string,
  };
}

/**
 * The attribute name of any `[name…]` selector whose value part is not read.
 * Every attribute selector needs the attribute to be present, so that alone
 * still narrows the match. Null for a namespaced name (`[ns|a]`), an escape
 * or anything that is not plainly a name followed by `]` or an operator.
 */
function readAttrName(inner: string): string | null {
  const m = /^[\t\n\f\r ]*((?:--|-?[_a-zA-Z])[-_a-zA-Z0-9]*)(?:[\t\n\f\r ]*(?:[~|^$*]?=|$))/.exec(inner);
  return m ? asciiLower(m[1] as string) : null;
}

function emptyCompound(): Compound {
  return { tag: null, id: null, classes: [], attrs: [] };
}

/**
 * One selector, read the way a browser tokenizes it: escapes decoded, strings
 * and blocks kept whole. "simple" is a single compound this module can match
 * exactly; anything else is "complex", with the compound it styles kept so
 * the elements it could reach are known.
 */
export function parseSelector(sel: string): ParsedSelector {
  // An empty selector (`.a,,.b`, a trailing comma) is invalid, and voids the list.
  if (sel === "") return { kind: "complex", subject: null };
  // A selector a browser rejects voids the rule. Not proving that here, it is
  // read as "could match anything": safe, only less exact.
  const invalid = { kind: "complex", subject: null } as const;
  let compound = emptyCompound();
  let complex = false;
  let pseudoElement = false;
  // `:root` in the subject compound: only the document element, `<html>`, matches it.
  let root = false;
  // A type selector (`div` or `*`) may only open a compound.
  let typed = false;
  let i = 0;
  const atCompoundStart = () =>
    !typed && compound.id === null && compound.classes.length === 0 && compound.attrs.length === 0;

  while (i < sel.length) {
    const ch = sel[i] as string;
    if (WS.test(ch) || ch === ">" || ch === "+" || ch === "~") {
      // A combinator: what follows is the compound the selector styles.
      let j = i;
      let explicit = 0;
      while (j < sel.length && (WS.test(sel[j] as string) || ">+~".includes(sel[j] as string))) {
        if (!WS.test(sel[j] as string)) explicit++;
        j++;
      }
      // A selector cannot start or end with a combinator, nor hold two in a
      // row: a browser drops such a rule, so it can hide nothing.
      if (i === 0 || explicit > 1 || (j >= sel.length && explicit > 0)) return invalid;
      if (j >= sel.length) break;
      complex = true;
      compound = emptyCompound();
      pseudoElement = false;
      root = false;
      typed = false;
      i = j;
      continue;
    }
    if (ch === ".") {
      if (!identStartsAt(sel, i + 1)) return invalid;
      const { value, end } = readIdent(sel, i + 1);
      compound.classes.push(value);
      i = end;
      continue;
    }
    if (ch === "#") {
      if (!identStartsAt(sel, i + 1)) return invalid;
      const { value, end } = readIdent(sel, i + 1);
      // `#a#b` never matches, `#a#a` counts its id twice: neither is read.
      if (compound.id !== null) complex = true;
      else compound.id = value;
      i = end;
      continue;
    }
    if (ch === "[") {
      const end = skipBlock(sel, i);
      if (sel[end - 1] !== "]") return invalid;
      const inner = sel.slice(i + 1, end - 1);
      const attr = readPlainAttr(inner);
      if (attr) compound.attrs.push(attr);
      else {
        // An operator or an unread form: not matched exactly, but the
        // attribute still has to be there (pub#984).
        complex = true;
        const operator = readOperatorAttr(inner);
        const name = operator ? operator.name : readAttrName(inner);
        if (operator) compound.attrs.push(operator);
        else if (name !== null) compound.attrs.push({ name, value: null });
      }
      i = end;
      continue;
    }
    if (ch === ":") {
      complex = true;
      const doubled = sel[i + 1] === ":";
      if (doubled) pseudoElement = true;
      const { value, end } = readIdent(sel, i + (doubled ? 2 : 1));
      // `:is()`, `:where()`, `:has()`, `:nth-child()` and friends only narrow
      // the compound (pub#951): the plain parts beside them still must match,
      // so the subject stays those parts. With none, it could be any element.
      if (!doubled && asciiLower(value) === "root" && sel[end] !== "(") root = true;
      i = sel[end] === "(" ? skipBlock(sel, end) : end;
      continue;
    }
    if (ch === "*") {
      if (!atCompoundStart()) return invalid;
      typed = true;
      i++;
      continue;
    }
    if (atCompoundStart() && identStartsAt(sel, i)) {
      const { value, end } = readIdent(sel, i);
      // Kept as written: only an HTML element matches it case-blind.
      compound.tag = value;
      typed = true;
      i = end;
      continue;
    }
    // `&`, `|`, a stray character: nothing this module reads.
    return invalid;
  }

  if (pseudoElement) return { kind: "pseudo-element" };
  // pub#938: `:root` reaches `<html>` alone, not every element (a design-token
  // block is usually `:root { … }`). A type selector already in the compound
  // stays: `div:root` matches nothing in HTML, and is kept as written.
  if (root && compound.tag === null) compound.tag = "html";
  if (complex) return { kind: "complex", subject: compound };
  const specificity =
    (compound.id ? 1 : 0) * 1_000_000 +
    (compound.classes.length + compound.attrs.length) * 1_000 +
    (compound.tag ? 1 : 0);
  return { kind: "simple", compound, specificity };
}

/** A selector list split at its top-level commas. */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < prelude.length) {
    const ch = prelude[i] as string;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === '"' || ch === "'") {
      i = ch === '"' || ch === "'" ? skipQuoted(prelude, i) : skipBlock(prelude, i);
      continue;
    }
    if (ch === ",") {
      parts.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  parts.push(prelude.slice(start).trim());
  return parts;
}

function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** Anything but plain printable ASCII and CSS whitespace. */
const NOT_PLAIN_ASCII = /[^\x20-\x7e\t\n\r\f]/;
/**
 * Characters that start tokens the reader does not follow: escapes, comments,
 * strings, functions (`var()`, `url()`), blocks and at-rules.
 */
const NOT_PLAIN_CSS = /[\\"'(){}[\]/*@<>]/;

/**
 * `display` values a browser accepts that show the element. Anything else,
 * the two-keyword syntax included, is left "unknown" rather than guessed.
 */
const SHOWN_DISPLAY = new Set(
  (
    "block inline inline-block flex inline-flex grid inline-grid contents flow-root list-item " +
    "table inline-table table-row table-cell table-caption table-column table-column-group " +
    "table-header-group table-footer-group table-row-group initial inherit unset " +
    // Vendor-prefixed box types (pub#978): old flexbox fallback chains. Each
    // one only shows an element; an engine that does not know one drops it.
    "-webkit-box -webkit-inline-box -webkit-flex -webkit-inline-flex " +
    "-ms-flexbox -ms-inline-flexbox -ms-grid -ms-inline-grid -moz-box -moz-inline-box"
  ).split(" "),
);

/**
 * Prefixed values some engines drop: Chromium knows `-webkit-*` but not
 * `-ms-*` or `-moz-*`, Firefox knows `-moz-box`. Such a value is read as shown
 * only when a later standard declaration overrides it in every engine
 * (`display:-ms-flexbox;display:flex`); as the last word it is "unknown".
 */
const ENGINE_DEPENDENT_DISPLAY = /^-(?:ms|moz)-/;

/** `display` values that show some elements and hide others, so never show-only (pub#940). */
const MIXED_DISPLAY = new Set(["contents", "inherit", "unset"]);

/** A declaration's value without a trailing `!important`, and whether it had one. */
function splitImportant(value: string): { value: string; important: boolean } {
  if (!value.endsWith("important")) return { value, important: false };
  const head = value.slice(0, -"important".length).trimEnd();
  if (!head.endsWith("!")) return { value, important: false };
  return { value: head.slice(0, -1).trimEnd(), important: true };
}

/** A property name a browser reads as one plain identifier. */
const PLAIN_PROPERTY = /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/;

/** Index just past the string opening at `start`; -1 when a raw newline or the end cuts it. */
function skipWholeString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n" || ch === "\r" || ch === "\f") return -1;
    i++;
  }
  return -1;
}

/**
 * A declaration block cut into its declarations the way a browser's tokenizer
 * cuts it: a `;` inside a string, a comment, a `(`, `[` or `{` block or an
 * unquoted `url(…)` is part of a value. null when a string runs past a
 * newline or the end, where a browser recovers differently, and for an escape
 * outside a string: it can spell a property name (`d\69splay`) or a `url(`
 * (`u\72l(`), whose token ends at its first `)` whatever opened inside it.
 */
function splitDeclarationBlock(block: string): Array<{ text: string; colon: number }> | null {
  const out: Array<{ text: string; colon: number }> = [];
  const closers: string[] = [];
  let start = 0;
  let colon = -1;
  let i = 0;
  while (i < block.length) {
    const ch = block[i] as string;
    if (ch === "\\") return null;
    if (ch === '"' || ch === "'") {
      const end = skipWholeString(block, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === "/" && block[i + 1] === "*") {
      i = skipComment(block, i);
      continue;
    }
    if (closers.length === 0 && ch === ":" && colon === -1) colon = i - start;
    if (closers.length === 0 && ch === ";") {
      out.push({ text: block.slice(start, i), colon });
      start = i + 1;
      colon = -1;
      i++;
      continue;
    }
    i = stepBlocks(block, i, closers);
  }
  out.push({ text: block.slice(start), colon });
  return out;
}

/**
 * Reads `display` and `visibility` from a declaration block (an inline
 * `style` or a rule's body), strictly, and whether the block may start an
 * animation. The block is cut into declarations first (pub#938): a custom
 * property (`--font-display: swap`) and any other property cannot set either
 * one, so what their values hold does not matter. A `display` or
 * `visibility` declaration counts only when plainly written (`display: none`,
 * `visibility:hidden !important`); one in any other form (escapes, comments,
 * functions, non-ASCII, `!` elsewhere, an unlisted keyword), the `all`
 * shorthand, a property name that is not a plain identifier and could be
 * either one, or an escape outside a string makes the block "unknown" for both.
 */
export function scanDeclarations(style: string | null): {
  decls: Declarations;
  mayAnimate: boolean;
} {
  if (!style || !MAY_SET.test(style)) return { decls: {}, mayAnimate: false };
  const parts = splitDeclarationBlock(style);
  if (!parts) return { decls: "unknown", mayAnimate: true };

  let unknown = false;
  let mayAnimate = false;
  const engines = { pending: false };
  const out: { display?: Declared<DisplayValue>; visibility?: Declared<VisibilityValue> } = {};
  for (const { text, colon } of parts) {
    if (colon === -1) {
      // No property at all: a browser drops it. Without its comments it may still name one.
      const bare = stripComments(text);
      if (MENTIONS_HIDING.test(bare)) unknown = true;
      if (/animation/i.test(bare)) mayAnimate = true;
      continue;
    }
    const name = stripComments(text.slice(0, colon)).trim();
    // A custom property sets nothing but itself, whatever its value holds.
    if (name.startsWith("--")) continue;
    if (/animation/i.test(name)) mayAnimate = true;
    if (!PLAIN_PROPERTY.test(name)) {
      if (MENTIONS_HIDING.test(name)) unknown = true;
      continue;
    }
    const prop = asciiLower(name);
    if (prop === "all") unknown = true;
    if (unknown || (prop !== "display" && prop !== "visibility")) continue;
    // The declaration as written, name and value, is read strictly.
    if (NOT_PLAIN_ASCII.test(text) || NOT_PLAIN_CSS.test(text)) {
      unknown = true;
      continue;
    }
    const read = readHidingDeclaration(out, prop, text.slice(colon + 1), engines);
    if (!read) unknown = true;
  }
  // An engine-dependent `display` nothing later overrode: the engines differ.
  if (engines.pending) unknown = true;
  return { decls: unknown ? "unknown" : out, mayAnimate };
}

/** {@link scanDeclarations} for what a block sets alone. */
export function readDeclarations(style: string | null): Declarations {
  return scanDeclarations(style).decls;
}

/**
 * Reads one plainly written `display` or `visibility` value into `out`; false
 * when it is not a value this module reads.
 */
function readHidingDeclaration(
  out: { display?: Declared<DisplayValue>; visibility?: Declared<VisibilityValue> },
  prop: "display" | "visibility",
  raw: string,
  engines: { pending: boolean },
): boolean {
  const split = splitImportant(asciiLower(raw.trim()));
  if (split.value.includes("!") || split.value === "") return false;
  // Within one block, !important beats normal, then the last wins.
  if (out[prop]?.important && !split.important) return true;
  const v = split.value;
  // This declaration applies, so it replaces what an earlier one left open.
  if (prop === "display") engines.pending = ENGINE_DEPENDENT_DISPLAY.test(v);
  let value: DisplayValue | VisibilityValue;
  if (prop === "display") {
    // `revert` is left out on purpose: Chromium shows a `hidden` element
    // with `display:revert`, where the specs suggest it stays hidden.
    if (v === "none") value = "none";
    else if (SHOWN_DISPLAY.has(v)) value = "shown";
    else return false;
  } else if (v === "hidden" || v === "collapse") {
    value = "hidden";
  } else if (v === "visible" || v === "initial") {
    value = "visible";
  } else if (v === "inherit" || v === "unset" || v === "revert") {
    // `revert-layer` is left out: it falls back to the page's own rules.
    value = "inherit";
  } else return false;
  if (prop === "display") {
    out.display = {
      value: value as DisplayValue,
      important: split.important,
      ...(MIXED_DISPLAY.has(v) ? { mixed: true as const } : {}),
    };
  }
  else out.visibility = { value: value as VisibilityValue, important: split.important };
  return true;
}

// ---------------------------------------------------------------------------
// Stylesheets
// ---------------------------------------------------------------------------

/**
 * The reader gave up (a cap, or markup it cannot follow): the rules it dropped
 * could hide, or show, any element. So every element is "unknown" for both
 * properties (pub#1015), never "shown": one rule that may apply to anything,
 * and no step budget left to look for a better answer. A fresh object per call:
 * the step budget is spent as the page is read.
 */
const incomplete = (): PageStyles => ({
  complete: false,
  decidable: { display: new Map(), visibility: new Map() },
  uncertain: {
    display: new Map([["*", [{ subject: null, important: true }]]]),
    visibility: new Map([["*", [{ subject: null, important: true }]]]),
  },
  steps: { left: 0 },
  animatesVisibility: false,
});

/**
 * The index key of a compound: its id, else its first class, else its tag,
 * else its first attribute name, else `*`.
 */
function indexKey(compound: Compound | null): string {
  if (!compound) return "*";
  if (compound.id !== null) return `#${asciiLower(compound.id)}`;
  if (compound.classes.length > 0) return `.${asciiLower(compound.classes[0] as string)}`;
  if (compound.tag !== null) return asciiLower(compound.tag);
  const attr = compound.attrs[0];
  return attr ? `[${attr.name}` : "*";
}

function addTo<T>(index: Map<string, T[]>, key: string, entry: T): void {
  const list = index.get(key);
  if (list) list.push(entry);
  else index.set(key, [entry]);
}

/**
 * A prelude without the `<!--` and `-->` tokens a browser drops at the top
 * level of a sheet (old pages wrap a `<style>` body in them).
 */
function dropCdoCdc(prelude: string): string {
  let rest = prelude.replace(LEADING_CSS_SPACE, "");
  for (;;) {
    if (rest.startsWith("<!--")) rest = rest.slice(4).replace(LEADING_CSS_SPACE, "");
    else if (rest.startsWith("-->")) rest = rest.slice(3).replace(LEADING_CSS_SPACE, "");
    else return rest;
  }
}

/** Whether a browser applies this `<style>`: no type, or exactly `text/css`. */
function styleTypeApplies(type: string | null): boolean {
  return type === null || type === "" || asciiLower(type) === "text/css";
}

/** Whether this `<style>` applies on a screen: always, never (`print`), or maybe. */
function styleMedia(media: string | null): "always" | "never" | "maybe" {
  if (media === null) return "always";
  const m = asciiLower(media.trim());
  if (m === "" || m === "all" || m === "screen") return "always";
  return m === "print" ? "never" : "maybe";
}

/** Reads the page's stylesheets. */
export function readPageStyles(doc: Document): PageStyles {
  let complete = true;
  for (const link of doc.querySelectorAll("link")) {
    const rel = asciiLower(getAttrCI(link, "rel") ?? "").split(/[\t\n\f\r ]+/);
    const as = asciiLower(getAttrCI(link, "as") ?? "");
    if (rel.includes("stylesheet") || as === "style") complete = false;
  }

  const decidable: PageStyles["decidable"] = { display: new Map(), visibility: new Map() };
  const uncertain: PageStyles["uncertain"] = { display: new Map(), visibility: new Map() };
  let entries = 0;
  let chars = 0;
  let ruleCount = 0;
  let order = 0;
  let animatesVisibility = false;
  /** The subjects of rules that may start an animation. */
  const animated: Array<Compound | null> = [];

  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    if (!MAY_MATTER.test(text)) continue;
    if (!styleTypeApplies(getAttrCI(style, "type"))) continue;
    const media = styleMedia(getAttrCI(style, "media"));
    if (media === "never") continue;
    // Inert or scripting-off markup: never applied, and not read here.
    if (style.closest("template, noscript") !== null) {
      complete = false;
      continue;
    }
    chars += text.length;
    if (chars > MAX_STYLE_CHARS) return incomplete();
    // A no-break or other non-ASCII space is part of a CSS name, but the rule
    // reader trims it away (`.x` + U+00A0 would read as `.x`): not read.
    if (UNICODE_SPACE.test(text)) return incomplete();
    const css = stripComments(text);
    // An at-keyword with an escape anywhere in it (`@\69mport`, `@n\61mespace`)
    // could be any at-rule.
    const escapedAt = /@[-_a-zA-Z0-9]*\\/.test(css);
    if (escapedAt || /@import/i.test(css)) complete = false;
    // Which rules sit in `@keyframes` is not tracked, so with one in the sheet
    // any conditional rule may be a frame.
    const hasKeyframes = escapedAt || /keyframes/i.test(css);
    // Applied only sometimes, or not as written: a `media` query, a named
    // stylesheet (`title`, which an inactive set leaves off), a sheet inside
    // SVG, or an `@namespace` that changes what its type selectors match.
    // Every rule in it is uncertain.
    const sometimes =
      media === "maybe" ||
      (getAttrCI(style, "title") ?? "") !== "" ||
      style.closest("svg, math") !== null ||
      escapedAt ||
      /@namespace/i.test(css);

    const budget = MAX_RULES - ruleCount;
    const rules = parseRules(text, budget);
    ruleCount += rules.length;
    if (rules.length >= budget) return incomplete();

    for (const rule of rules) {
      if (!MAY_SET.test(rule.body)) continue;
      if (rule.selector.length > MAX_SELECTOR_CHARS) return incomplete();
      // A nested rule (`& .x { … }`) could style any descendant.
      if (rule.body.includes("{")) return incomplete();
      const { decls, mayAnimate: animates } = scanDeclarations(rule.body);
      if (!animates && decls !== "unknown" && !decls.display && !decls.visibility) continue;
      const display = decls === "unknown" || decls.display !== undefined;
      const visibility = decls === "unknown" || decls.visibility !== undefined;
      // An `@keyframes` frame styles an animation step, not an element. What
      // it sets reaches whatever element runs the animation.
      if (rule.conditional && hasKeyframes) animatesVisibility ||= visibility;
      if (rule.conditional && KEYFRAME_SELECTOR.test(rule.selector)) continue;
      const selector = rule.conditional ? rule.selector : dropCdoCdc(rule.selector);
      const selectors = splitSelectorList(selector).map(parseSelector);
      if (animates) {
        for (const s of selectors) {
          if (s.kind === "pseudo-element") continue;
          if (++entries > MAX_ENTRIES) return incomplete();
          animated.push(s.kind === "simple" ? s.compound : s.subject);
        }
      }
      if (!display && !visibility) continue;

      const allSimple = selectors.every((s) => s.kind === "simple");
      if (!sometimes && !rule.conditional && decls !== "unknown" && allSimple) {
        for (const s of selectors) {
          if (s.kind !== "simple") continue;
          if (++entries > MAX_ENTRIES) return incomplete();
          const entry: DecidableRule = {
            compound: s.compound,
            specificity: s.specificity,
            order: order++,
            ...(decls.display ? { display: decls.display } : {}),
            ...(decls.visibility ? { visibility: decls.visibility } : {}),
          };
          if (entry.display) addTo(decidable.display, indexKey(s.compound), entry);
          if (entry.visibility) addTo(decidable.visibility, indexKey(s.compound), entry);
        }
        continue;
      }
      // pub#988: a plain `display: none` that only width-only `@media` queries
      // apply is kept with the widths it covers, so the cascade can tell
      // "hidden at some widths" from "may be hidden".
      const widths =
        rule.conditional && !sometimes && rule.at && decls !== "unknown" && !animates && allSimple
          ? readAtRuleWidths(rule.at)
          : null;
      const widthHide =
        widths !== null &&
        decls !== "unknown" &&
        decls.display?.value === "none" &&
        decls.display.mixed !== true;
      // One invalid selector voids the whole list in a browser, so a mixed
      // list is uncertain for every element any of its selectors names.
      for (const s of selectors) {
        if (s.kind === "pseudo-element") continue;
        if (++entries > MAX_ENTRIES) return incomplete();
        const subject = s.kind === "simple" ? s.compound : s.subject;
        const key = indexKey(subject);
        const important = (prop: Prop) => decls === "unknown" || decls[prop]?.important === true;
        // An animation on the same rule may hide what it shows, so it is not show-only.
        const shows = (prop: Prop): { shows?: true } => {
          if (animates || decls === "unknown") return {};
          const decl = decls[prop];
          if (!decl || ("mixed" in decl && decl.mixed)) return {};
          return decl.value === "shown" || decl.value === "visible" ? { shows: true } : {};
        };
        if (display && widthHide && widths && s.kind === "simple") {
          addTo(uncertain.display, key, {
            subject,
            important: important("display"),
            width: { ranges: widths, compound: s.compound, specificity: s.specificity, order: order++ },
          });
        } else if (display) {
          addTo(uncertain.display, key, {
            subject,
            important: important("display"),
            ...shows("display"),
          });
        }
        if (visibility) {
          addTo(uncertain.visibility, key, {
            subject,
            important: important("visibility"),
            ...shows("visibility"),
          });
        }
      }
    }
  }

  // A running animation outranks every declaration but an `!important` one,
  // so an element it may run on is uncertain for what the frames set.
  if (animatesVisibility) {
    for (const subject of animated) {
      addTo(uncertain.visibility, indexKey(subject), {
        subject,
        important: false,
        animation: true,
      });
    }
  }

  return { complete, decidable, uncertain, steps: { left: MAX_STEPS }, animatesVisibility };
}

const pageStylesCache = new WeakMap<Document, PageStyles>();

/** The page's stylesheets, read once per document. */
export function pageStylesFor(doc: Document | null | undefined): PageStyles | null {
  if (!doc) return null;
  let styles = pageStylesCache.get(doc);
  if (!styles) {
    styles = readPageStyles(doc);
    pageStylesCache.set(doc, styles);
  }
  return styles;
}

// ---------------------------------------------------------------------------
// Matching and the cascade
// ---------------------------------------------------------------------------

type Match = "yes" | "no" | "case";

/** What matching reads off one element, read once per cascade. */
interface ElementView {
  el: Element;
  tag: string;
  id: string | null;
  classes: string[];
  lowerClasses: Set<string>;
  /** Lower-cased attribute names. */
  attrNames: string[];
  /** In SVG or MathML, where names are case-sensitive (and linkedom lower-cases them). */
  foreign: () => boolean;
}

function classTokens(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/[\t\n\f\r ]+/).filter(Boolean);
}

const foreignCache = new WeakMap<Element, boolean>();

/** Whether `el` is SVG or MathML, or inside either; cached, so a whole page costs one walk. */
function isForeign(el: Element): boolean {
  const chain: Element[] = [];
  let result = false;
  for (let at: Element | null = el; at; at = at.parentElement) {
    const cached = foreignCache.get(at);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    const ns = at.namespaceURI;
    const tag = asciiLower(at.localName || "");
    if ((ns !== null && ns !== "http://www.w3.org/1999/xhtml") || tag === "svg" || tag === "math") {
      result = true;
      break;
    }
    chain.push(at);
  }
  // Every element walked past sits under the same answer.
  for (const at of chain) foreignCache.set(at, result);
  if (result) foreignCache.set(el, true);
  return result;
}

/** An element's attributes, names lower-cased, read from the DOM once per element. */
const attributesCache = new WeakMap<Element, Array<{ name: string; value: string }>>();

function attributesOf(el: Element): Array<{ name: string; value: string }> {
  let list = attributesCache.get(el);
  if (!list) {
    list = Array.from(el.attributes ?? [], (attr) => ({
      name: asciiLower(attr.name),
      value: attr.value,
    }));
    attributesCache.set(el, list);
  }
  return list;
}

function viewOf(el: Element): ElementView {
  const classes = classTokens(el);
  let foreign: boolean | undefined;
  return {
    el,
    tag: asciiLower(el.localName || el.tagName || ""),
    id: el.getAttribute("id"),
    classes,
    lowerClasses: new Set(classes.map(asciiLower)),
    attrNames: attributesOf(el).map((attr) => attr.name),
    foreign: () => (foreign ??= isForeign(el)),
  };
}

/** The index keys an element's rules can sit under, each once. */
function elementKeys(view: ElementView): Set<string> {
  const keys = new Set(["*", view.tag]);
  if (view.id) keys.add(`#${asciiLower(view.id)}`);
  for (const cls of view.lowerClasses) keys.add(`.${cls}`);
  for (const name of view.attrNames) keys.add(`[${name}`);
  return keys;
}

/** Whether `compound` matches the element exactly; "case" when only a case-blind reading matches. */
function compoundMatches(compound: Compound, view: ElementView): Match {
  let result: Match = "yes";
  if (compound.tag !== null) {
    if (view.tag !== asciiLower(compound.tag)) return "no";
    // An SVG name (`clipPath`) matches only as written, and linkedom has
    // lower-cased it: not settled.
    if (view.foreign()) result = "case";
  }
  if (compound.id !== null) {
    if (view.id === null) return "no";
    if (view.id !== compound.id) {
      if (asciiLower(view.id) !== asciiLower(compound.id)) return "no";
      result = "case";
    }
  }
  for (const cls of compound.classes) {
    if (view.classes.includes(cls)) continue;
    if (!view.lowerClasses.has(asciiLower(cls))) return "no";
    result = "case";
  }
  for (const attr of compound.attrs) {
    const value = getAttrCI(view.el, attr.name);
    if (value === null) return "no";
    // SVG and MathML attribute names are case-sensitive (`viewBox`).
    if (view.foreign()) result = "case";
    if (attr.value !== null && value !== attr.value) {
      // HTML matches some attribute values case-blind (`type`, `dir`, …).
      if (asciiLower(value) !== asciiLower(attr.value)) return "no";
      result = "case";
    }
  }
  return result;
}

/** Whether `subject` could match the element on a case-blind reading of its tag, id and classes. */
function couldMatch(subject: Compound | null, view: ElementView): boolean {
  if (subject === null) return true;
  if (subject.tag !== null && view.tag !== asciiLower(subject.tag)) return false;
  if (subject.id !== null && asciiLower(view.id ?? "") !== asciiLower(subject.id)) return false;
  if (!subject.classes.every((cls) => view.lowerClasses.has(asciiLower(cls)))) return false;
  return subject.attrs.every((attr) => {
    // HTML keeps `aK` and `ak` apart while a selector matches names ASCII
    // case-blind, so any attribute of that name may satisfy the test.
    // A presence test needs no value; the list is read once per element.
    const own = attributesOf(view.el).filter((a) => a.name === attr.name);
    if (own.length > 0) {
      return attr.value === null || own.some((a) => attrValueCouldMatch(attr, a.value));
    }
    // linkedom lists no attribute: fall back to the case-blind read.
    if (attributesOf(view.el).length > 0) return false;
    const value = getAttrCI(view.el, attr.name);
    return value !== null && attrValueCouldMatch(attr, value);
  });
}

/** Whether an attribute's value could satisfy the test, compared case-insensitively. */
function attrValueCouldMatch(
  attr: { value: string | null; op?: AttrOperator },
  actual: string,
): boolean {
  if (attr.value === null) return true;
  // A browser turns a literal NUL into U+FFFD while parsing; this DOM keeps it.
  const both = attr.value + actual;
  if (both.includes("\u0000") || both.includes("\ufffd")) return true;
  const want = asciiLower(attr.value);
  const have = asciiLower(actual);
  switch (attr.op) {
    case undefined:
      return have === want;
    case "^=":
      return want !== "" && have.startsWith(want);
    case "$=":
      return want !== "" && have.endsWith(want);
    case "*=":
      return want !== "" && have.includes(want);
    case "~=":
      return want !== "" && !/[\t\n\f\r ]/.test(want) && have.split(/[\t\n\f\r ]+/).includes(want);
    case "|=":
      return have === want || have.startsWith(`${want}-`);
  }
}

/** Where the winning declaration came from. */
export type Source = "inline" | "sheet";

export type CascadeResult<V extends string> = { value: V; source: Source } | "unknown" | undefined;

/**
 * The author value of one property for `el`: the inline declaration and the
 * page's decidable rules, ordered as a browser orders them (an `!important`
 * declaration first, then inline over a rule, then specificity, then source
 * order). "unknown" when an uncertain rule or an animation could reach the
 * element, or a decidable rule matches only case-blind; undefined when
 * nothing sets it. A rule that could only show the element does not make the
 * answer "unknown" (pub#940): `reach.shows` says one could reach it, so the
 * caller can tell whether something else hiding the element still holds.
 * A plain `display: none` inside width-only `@media` queries (pub#988) does
 * not make the answer "unknown" either: the widths where it wins over the
 * decidable rules are collected in `reach.hideWidths`, and the element is
 * not hidden by it at any other width.
 */
export function cascade<P extends "display" | "visibility">(
  el: Element,
  styles: PageStyles,
  prop: P,
  inline: Declared<P extends "display" ? DisplayValue : VisibilityValue> | undefined,
  reach?: { shows: boolean; hideWidths?: WidthSet },
): CascadeResult<P extends "display" ? DisplayValue : VisibilityValue> {
  type V = P extends "display" ? DisplayValue : VisibilityValue;
  const view = viewOf(el);
  const keys = elementKeys(view);
  let best: { decl: Declared<V>; inline: boolean; specificity: number; order: number } | null =
    inline ? { decl: inline, inline: true, specificity: 0, order: Number.MAX_SAFE_INTEGER } : null;
  const beats = (
    a: { decl: Declared<V>; inline: boolean; specificity: number; order: number },
    b: typeof a,
  ): boolean => {
    if (a.decl.important !== b.decl.important) return a.decl.important;
    if (a.inline !== b.inline) return a.inline;
    if (a.specificity !== b.specificity) return a.specificity > b.specificity;
    return a.order > b.order;
  };
  const steps = styles.steps;
  // Each rule sits under one key, and each key is visited once.
  for (const key of keys) {
    for (const rule of styles.decidable[prop].get(key) ?? []) {
      if (--steps.left < 0) return "unknown";
      const decl = rule[prop] as Declared<V> | undefined;
      if (!decl) continue;
      const match = compoundMatches(rule.compound, view);
      if (match === "no") continue;
      if (match === "case") return "unknown";
      const candidate = { decl, inline: false, specificity: rule.specificity, order: rule.order };
      if (!best || beats(candidate, best)) best = candidate;
    }
  }
  // A rule this module could not decide may still apply. It loses only to an
  // inline declaration it cannot outrank: any inline `!important`, or an
  // ordinary inline one when it is not `!important` itself. An animation
  // beats every ordinary declaration, inline too, and loses to `!important`.
  const winner = best;
  const outranked = (important: boolean, animation: boolean) =>
    animation
      ? winner?.decl.important === true
      : winner?.inline === true && (winner.decl.important || !important);
  const animated = /animation/i.test(getAttrCI(el, "style") ?? "");
  if (prop === "visibility" && styles.animatesVisibility && animated && !outranked(false, true)) {
    return "unknown";
  }
  for (const key of keys) {
    for (const rule of styles.uncertain[prop].get(key) ?? []) {
      if (--steps.left < 0) return "unknown";
      if (outranked(rule.important, rule.animation === true)) continue;
      if (rule.width) {
        // Only `display` carries these, and only the caller that reads the widths can use them.
        if (!reach) return "unknown";
        const match = compoundMatches(rule.width.compound, view);
        if (match === "no") continue;
        if (match === "case") return "unknown";
        // A decided hide, or a value that hides some elements, beside it: not settled by widths.
        if (best && (best.decl.value === "none" || best.decl.mixed)) return "unknown";
        const candidate = {
          decl: { value: "none", important: rule.important } as Declared<V>,
          inline: false,
          specificity: rule.width.specificity,
          order: rule.width.order,
        };
        // A decidable `display` that outranks it keeps the element shown at these widths.
        if (!best || beats(candidate, best)) {
          reach.hideWidths = unionWidths(reach.hideWidths ?? [], rule.width.ranges);
        }
        continue;
      }
      if (!couldMatch(rule.subject, view)) continue;
      if (rule.shows && reach) {
        reach.shows = true;
        continue;
      }
      return "unknown";
    }
  }
  if (!best) return undefined;
  return { value: best.decl.value, source: best.inline ? "inline" : "sheet" };
}
