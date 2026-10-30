// mobile/input-zoom - form fields under 16px make iOS Safari zoom in on focus (#708)
//
// On an iPhone, focusing a text field whose font size is under 16px zooms the
// page in: the layout jumps, the submit button leaves the screen, and the
// visitor has to pinch back out. The real fix is a 16px field; the common
// workaround, `maximum-scale=1`, stops everyone else from zooming.
//
// A static audit reads only inline `style` attributes and `<style>` blocks, so
// the rule judges a field only when it can read the field's size plainly from
// those. A size that an external stylesheet may override, or that comes from a
// media query, an unsupported selector or a relative unit, is not judged: the
// field is counted as not read instead. Its risk is missed fields, never
// wrong ones.

import type { Element } from "linkedom";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { parseRules } from "../content/hidden-text";
import { skipComment, skipString, stepBlocks } from "../shared/css-tokens";

/** iOS Safari zooms a focused field below this size. */
const MIN_FIELD_PX = 16;
/**
 * iOS Safari's own size for an unstyled field: WebKit's iOS stylesheet sets
 * `font: 11px system-ui` on `input`, `textarea` and `select`, so a field no
 * author rule sizes zooms too. Fields do not inherit the page's font size.
 * Source: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/css/html.css
 * (the zoom scale is `16 / fontSize`, `UIProcess/API/ios/WKWebViewIOS.mm`).
 */
const IOS_DEFAULT_FIELD_PX = 11;
/** The initial `medium` size, which `rem`, `em` and `%` on the root resolve against. */
const DEFAULT_ROOT_PX = 16;
const PT_TO_PX = 4 / 3;
/** Fields judged per page; a page with more is checked on the first ones. */
const MAX_FIELDS = 200;
/** Fields checked for focusability per page, so a page of 100,000 inputs stays cheap. */
const MAX_SCANNED_FIELDS = 2_000;
/**
 * A field nested deeper than this is not read: every selector test walks its
 * ancestors, so depth multiplies the cost of each one.
 */
const MAX_FIELD_DEPTH = 128;
/** Stylesheet text, rules and `<style>` blocks read per page. */
const MAX_STYLE_CHARS = 400_000;
const MAX_STYLE_RULES = 4_000;
const MAX_STYLE_BLOCKS = 256;
/**
 * The longest selector run. The engine compiles a selector on every test, so a
 * long one costs every field it is tried on; a sheet holding a longer one is
 * not read.
 */
const MAX_SELECTOR_CHARS = 256;
/** An inline `style` longer than this is not read (a field) or taken as hiding (a wrapper). */
const MAX_INLINE_STYLE_CHARS = 4_096;
/** A `font` shorthand longer than this is not parsed. */
const MAX_FONT_VALUE_CHARS = 1_000;
/**
 * Selector tests per page, and the time they may take, so a hostile sheet
 * cannot stall the audit. A test usually costs about 20 microseconds, but a
 * descendant selector on a deep field, or a `:has()`, can cost far more, so
 * the clock caps what the count cannot.
 */
const MAX_MATCH_CALLS = 10_000;
const MAX_MATCH_MS = 250;
const MAX_ITEMS = 20;
/** Attribute values and selectors quoted in an item are cut to this length. */
const MAX_LABEL_CHARS = 80;

/** Input types that do not open a keyboard or a picker, so never zoom. */
const NO_KEYBOARD_TYPES = new Set([
  "hidden",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "submit",
  "button",
  "reset",
  "image",
]);

/** CSS absolute-size keywords, as browsers map them against a 16px `medium`. */
const SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

/**
 * Pseudo-classes the selector engine cannot run, or (`:scope`) would run
 * against the wrong element. A selector using one is matched with it relaxed
 * to "any state", and a hit is not read: a focus-state size is exactly what
 * decides the zoom.
 */
const UNRUNNABLE_PSEUDO_SOURCE = String.raw`:(?:focus(?:-visible|-within)?|hover|active|visited|link|any-link|target|scope|autofill|-webkit-autofill|placeholder-shown|user-invalid|user-valid)(?![\w-])`;
const UNRUNNABLE_PSEUDO = new RegExp(UNRUNNABLE_PSEUDO_SOURCE, "gi");
const HAS_UNRUNNABLE_PSEUDO = new RegExp(UNRUNNABLE_PSEUDO_SOURCE, "i");

/** A font family: a quoted name, or one or more identifiers (`Helvetica Neue`, `sans-serif`). */
const FONT_FAMILY = String.raw`(?:"[^"]*"|'[^']*'|-?[a-z_][\w-]*(?:\s+-?[a-z_][\w-]*)*)`;
/**
 * The whole `font` shorthand grammar this rule reads: optional style, variant,
 * weight and stretch keywords, a size, an optional line height, then a family
 * list. Anything else (a `var()`, a system font, a typo a browser would
 * reject) is not read.
 */
const FONT_SHORTHAND = new RegExp(
  String.raw`^((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]\d{0,3}|(?:ultra-|extra-|semi-)?(?:condensed|expanded))\s+)*)` +
    String.raw`((?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|rem|em|%)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)` +
    String.raw`(?:\s*\/\s*(?:normal|(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|rem|em|%)?))?` +
    String.raw`\s+${FONT_FAMILY}(?:\s*,\s*${FONT_FAMILY})*$`,
  "i",
);

interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

/** A selector prepared once per page: its text and the form the engine runs. */
interface Prepared {
  text: string;
  /** What the engine runs: unrunnable states relaxed to "any state". */
  run: string;
  /** A state was relaxed or widened, so a hit is only "might match". */
  relaxed: boolean;
  /** A state the widening cannot reach (a nested `:not()`): never run. */
  unrunnable: boolean;
}

interface SizeRule {
  selectors: Prepared[];
  /** What the block sets the size to. */
  size: string;
  important: boolean;
  /** Inside `@media`, `@supports`, `@layer` or a `<style media>` block. */
  conditional: boolean;
}

/** A field whose size could not be read, and why. */
type Unread =
  | "unseen-css"
  | "conditional"
  | "conflict"
  | "unsupported-selector"
  | "relative-unit"
  | "hidden"
  | "budget";

/** Splits a selector list on its top-level commas (`:is(a, b)` stays whole). */
export function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const ch = list[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(list, i);
      continue;
    }
    if (ch === "/" && list[i + 1] === "*") {
      i = skipComment(list, i);
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** The keyword group each `font` shorthand prefix belongs to; a group may appear once. */
function fontPrefixGroup(token: string): string {
  if (token === "normal") return "";
  if (token === "italic" || token === "oblique") return "style";
  if (token === "small-caps") return "variant";
  if (/condensed$|expanded$/.test(token)) return "stretch";
  return "weight";
}

/** The font size a valid `font` shorthand sets (`font: 14px/1.4 sans-serif`), or null. */
export function fontShorthandSize(value: string): string | null {
  if (value.length > MAX_FONT_VALUE_CHARS) return null;
  const match = value.trim().toLowerCase().match(FONT_SHORTHAND);
  if (!match) return null;
  const prefix = match[1]!.split(/\s+/).filter(Boolean);
  if (prefix.length > 4) return null;
  const groups = prefix.map(fontPrefixGroup).filter(Boolean);
  if (new Set(groups).size !== groups.length) return null;
  if (prefix.some((t) => /^\d+$/.test(t) && Number(t) > 1000)) return null;
  return match[2]!;
}

/**
 * A declaration block's declarations in source order, each with its own
 * `!important`, and whether the block nests rules (`&:focus { … }`), which
 * this read does not follow. A comment reads as a space, as it separates
 * tokens in a browser: `1`, a comment, then `2px` is not `12px`.
 */
function readDeclarations(css: string): { decls: Declaration[]; nested: boolean } {
  const decls: Declaration[] = [];
  let nested = false;
  let chunk = "";
  const flush = (): void => {
    const colon = chunk.indexOf(":");
    if (colon > 0) {
      const prop = chunk.slice(0, colon).trim().toLowerCase();
      let value = chunk
        .slice(colon + 1)
        .trim()
        .toLowerCase();
      const important = /!\s*important$/.test(value);
      if (important) value = value.replace(/!\s*important$/, "").trim();
      if (prop && value) decls.push({ prop, value, important });
    }
    chunk = "";
  };
  const closers: string[] = [];
  let start = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      chunk += `${css.slice(start, i)} `;
      i = skipComment(css, i);
      start = i;
      continue;
    }
    if (ch === ";" && closers.length === 0) {
      chunk += css.slice(start, i);
      flush();
      i++;
      start = i;
      continue;
    }
    if (ch === "{" && closers.length === 0) nested = true;
    i = stepBlocks(css, i, closers);
  }
  chunk += css.slice(start);
  flush();
  return { decls, nested };
}

/**
 * The size a block sets, from its last `font-size`, `font` or `all`, an
 * `!important` one first; null when it sets none. A shorthand outside the
 * grammar this rule reads, and `all`, come back as values that read as not
 * plain.
 */
function blockSize(decls: Declaration[]): { size: string; important: boolean } | null {
  let plain: string | null = null;
  let important: string | null = null;
  for (const d of decls) {
    let size: string;
    if (d.prop === "font-size") size = d.value;
    else if (d.prop === "font") size = fontShorthandSize(d.value) ?? "unparsed";
    else if (d.prop === "all") size = d.value;
    else continue;
    if (d.important) important = size;
    else plain = size;
  }
  if (important !== null) return { size: important, important: true };
  return plain === null ? null : { size: plain, important: false };
}

/**
 * Whether a block may hide what it styles: any `display: none` or
 * `visibility: hidden` in it counts, even one a later declaration seems to
 * undo, since that one may be invalid. A field wrongly taken as hidden is
 * only missed.
 */
function hidesElement(decls: Declaration[]): boolean {
  return decls.some(
    (d) =>
      (d.prop === "display" && d.value === "none") ||
      (d.prop === "visibility" && (d.value === "hidden" || d.value === "collapse")),
  );
}

/**
 * A size in px, or a reason it cannot be read: `em` and `%` depend on the
 * field's parent, `rem` on a root size that may be unknown (null), and
 * `var()`, `calc()`, `inherit` and the like on things a static read does not
 * know.
 */
export function sizeToPx(value: string, rootPx: number | null): number | "relative-unit" {
  const v = value.trim().toLowerCase();
  if (Object.hasOwn(SIZE_KEYWORDS, v)) return SIZE_KEYWORDS[v]!;
  const match = v.match(/^((?:\d+(?:\.\d+)?|\.\d+))(px|pt|rem)$/);
  if (!match) return "relative-unit";
  const n = Number.parseFloat(match[1]!);
  if (match[2] === "px") return n;
  if (match[2] === "pt") return n * PT_TO_PX;
  return rootPx === null ? "relative-unit" : n * rootPx;
}

/** Whether a selector can style the field itself (pseudo-elements style a part of it). */
function stylesTheElement(selector: string): boolean {
  return !/::|:(?:before|after|first-line|first-letter|-ms-input-placeholder|-moz-placeholder)\b/i.test(
    selector,
  );
}

/**
 * Whether a selector the engine cannot run at all could still be aimed at the
 * field. Generous on purpose: a yes only turns the field into "not read", so an
 * attribute or universal selector is always a yes.
 */
function mentions(selector: string, field: Element): boolean {
  if (/[[*]/.test(selector)) return true;
  const lower = selector.toLowerCase();
  if (lower.includes(field.tagName.toLowerCase())) return true;
  const id = field.getAttribute("id");
  if (id && selector.includes(`#${id}`)) return true;
  for (const cls of (field.getAttribute("class") || "")
    .slice(0, MAX_INLINE_STYLE_CHARS)
    .split(/\s+/)) {
    if (cls && selector.includes(`.${cls}`)) return true;
  }
  return false;
}

/** Prepares a selector for {@link matchSelector}, once per page. */
function prepareSelector(text: string): Prepared {
  // Relaxing a state inside `:not()` would invert it, so such a `:not()` is
  // dropped instead, which only widens the selector.
  const widened = text.replace(/:not\(([^()]*)\)/gi, (whole, inner: string) =>
    HAS_UNRUNNABLE_PSEUDO.test(inner) ? ":is(*)" : whole,
  );
  const unrunnable = /:not\(/i.test(widened) && HAS_UNRUNNABLE_PSEUDO.test(widened);
  const run = widened.replace(UNRUNNABLE_PSEUDO, ":is(*)");
  return { text, run, relaxed: run !== text, unrunnable };
}

/**
 * Whether a selector matches the element: "unsupported" when it might, but
 * only in a state or through a selector the engine cannot run.
 */
function matchSelector(el: Element, selector: Prepared): boolean | "unsupported" {
  if (selector.unrunnable) return "unsupported";
  let hit: boolean;
  try {
    hit = el.matches(selector.run);
  } catch {
    return mentions(selector.text, el) ? "unsupported" : false;
  }
  if (!hit) return false;
  return selector.relaxed ? "unsupported" : true;
}

/** The selector-test budget a page shares: a count and a deadline. */
interface Budget {
  calls: number;
  deadline: number;
}

/** Spends one selector test, or answers false when the budget is gone. */
function spend(budget: Budget): boolean {
  if (budget.calls <= 0 || performance.now() > budget.deadline) return false;
  budget.calls--;
  return true;
}

/** How many ancestors the element has, counting up to `cap + 1` at most. */
function depthOf(el: Element, cap: number): number {
  let depth = 0;
  for (let n = el.parentElement; n && depth <= cap; n = n.parentElement) depth++;
  return depth;
}

function isTextEntry(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "select" || tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = (el.getAttribute("type") || "text").trim().toLowerCase();
  return !NO_KEYBOARD_TYPES.has(type);
}

/**
 * Whether a visitor can focus the field: not disabled, and neither it nor an
 * ancestor is `hidden`, `inert`, `aria-hidden` (usually a spam trap), hidden
 * by an inline style, a closed `<dialog>` or `<details>`, or a `<template>`
 * or `<noscript>`.
 */
function canFocus(
  field: Element,
  styleHides: Map<Element, boolean | "unknown">,
): boolean | "unknown" {
  if (field.hasAttribute("disabled")) return false;
  let inSummary = false;
  for (let n: Element | null = field; n; n = n.parentElement) {
    if (
      n.hasAttribute("hidden") ||
      n.hasAttribute("inert") ||
      n.getAttribute("aria-hidden") === "true"
    )
      return false;
    const tag = n.tagName.toLowerCase();
    if (n !== field && tag === "fieldset" && n.hasAttribute("disabled")) return false;
    if (tag === "template" || tag === "noscript") return false;
    if (tag === "dialog" && !n.hasAttribute("open")) return false;
    if (tag === "summary") inSummary = true;
    else if (tag === "details") {
      if (!inSummary && !n.hasAttribute("open")) return false;
      inSummary = false;
    }
    let hides = styleHides.get(n);
    if (hides === undefined) {
      const style = n.getAttribute("style") || "";
      // Too long to read cheaply: the field is not read. Its own style is
      // left to the cascade, which does the same.
      if (style.length > MAX_INLINE_STYLE_CHARS) hides = n === field ? false : "unknown";
      else hides = /display|visibility/i.test(style) && hidesElement(readDeclarations(style).decls);
      styleHides.set(n, hides);
    }
    if (hides === "unknown") return "unknown";
    if (hides) return false;
  }
  return true;
}

/** How the report names a field: its tag, type and name or id. */
function describeField(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parts = [tag];
  const type = el.getAttribute("type");
  if (tag === "input") parts.push(`type="${(type || "text").toLowerCase()}"`);
  const name = el.getAttribute("name");
  const id = el.getAttribute("id");
  if (name) parts.push(`name="${clip(name)}"`);
  else if (id) parts.push(`id="${clip(id)}"`);
  return parts.join(" ");
}

/** Cuts page-controlled text quoted in an item to {@link MAX_LABEL_CHARS}. */
function clip(text: string): string {
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS)}…` : text;
}

function formatPx(px: number): string {
  return `${Math.round(px * 100) / 100}px`;
}

/** One `<style>` block: its text, and whether its `media` attribute makes it conditional. */
interface StyleBlock {
  text: string;
  conditional: boolean;
}

/**
 * Every `<style>` block's font-size rules and hiding selectors, and whether a
 * rule nests others (CSS nesting), whose selectors this read does not see.
 */
function readStyleRules(blocks: StyleBlock[]): {
  sizeRules: SizeRule[];
  hideSelectors: Prepared[];
  nested: boolean;
  truncated: boolean;
} {
  const sizeRules: SizeRule[] = [];
  const hideSelectors: Prepared[] = [];
  let anyNested = false;
  let tooLong = false;
  let chars = MAX_STYLE_CHARS;
  let ruleBudget = MAX_STYLE_RULES;
  for (const block of blocks) {
    if (chars <= 0 || ruleBudget <= 0) break;
    const text = block.text.slice(0, chars);
    chars -= text.length;
    for (const rule of parseRules(text, ruleBudget)) {
      ruleBudget--;
      const { decls, nested } = readDeclarations(rule.body);
      if (nested) anyNested = true;
      const size = blockSize(decls);
      const hides = hidesElement(decls);
      if (size === null && !hides) continue;
      // A pseudo-element selector styles a part of the field, never the field
      // itself: `input::-webkit-search-cancel-button { display: none }`.
      const selectors: Prepared[] = [];
      for (const text of splitSelectorList(rule.selector)) {
        if (!stylesTheElement(text)) continue;
        if (text.length > MAX_SELECTOR_CHARS) tooLong = true;
        else selectors.push(prepareSelector(text));
      }
      if (tooLong) break;
      if (hides) hideSelectors.push(...selectors);
      if (size !== null && selectors.length > 0) {
        sizeRules.push({
          selectors,
          size: size.size,
          important: size.important,
          conditional: block.conditional || rule.conditional,
        });
      }
    }
    if (tooLong) break;
  }
  // Conservative at the boundary: a budget spent exactly to zero reads as cut.
  const truncated = tooLong || chars <= 0 || ruleBudget <= 0;
  return { sizeRules, hideSelectors, nested: anyNested, truncated };
}

type Cascaded = { value: string; source: string } | { unread: Unread } | null;

/**
 * The size the cascade gives an element from what the page shows: an
 * `!important` inline size, then `!important` rules, then the inline size,
 * then plain rules. Null when nothing sizes it.
 */
function cascade(el: Element, rules: SizeRule[], unseenCss: boolean, budget: Budget): Cascaded {
  const matched: Array<{ rule: SizeRule; selector: Prepared }> = [];
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (!spend(budget)) return { unread: "budget" };
      const hit = matchSelector(el, selector);
      if (hit === "unsupported") return { unread: "unsupported-selector" };
      if (hit) {
        matched.push({ rule, selector });
        break;
      }
    }
  }

  const styleAttr = el.getAttribute("style") || "";
  if (styleAttr.length > MAX_INLINE_STYLE_CHARS) return { unread: "budget" };
  const inline = blockSize(readDeclarations(styleAttr).decls);
  if (inline?.important) return { value: inline.size, source: "inline style" };
  const important = matched.filter((m) => m.rule.important);
  const winners = important.length > 0 ? important : inline !== null ? [] : matched;
  if (winners.length === 0)
    return inline === null ? null : { value: inline.size, source: "inline style" };
  // A rule the audit cannot see may come later in the cascade.
  if (unseenCss) return { unread: "unseen-css" };
  // A media query can set the phone-width size, which is the one that matters.
  if (winners.some((m) => m.rule.conditional)) return { unread: "conditional" };
  // Without specificity, rules that disagree cannot be ordered.
  if (new Set(winners.map((m) => m.rule.size)).size > 1) return { unread: "conflict" };
  return { value: winners[0]!.rule.size, source: `<style>: ${clip(winners[0]!.selector.text)}` };
}

/** The root size `rem` resolves against, or null when the page does not pin it down. */
function resolveRoot(
  root: Element | null,
  rules: SizeRule[],
  unseenCss: boolean,
  budget: Budget,
): number | null {
  // An external stylesheet may set the root (`html { font-size: 62.5% }`).
  if (unseenCss) return null;
  if (!root) return DEFAULT_ROOT_PX;
  const c = cascade(root, rules, false, budget);
  if (c === null) return DEFAULT_ROOT_PX;
  if ("unread" in c) return null;
  const relative = c.value.trim().match(/^((?:\d+(?:\.\d+)?|\.\d+))(rem|em|%)$/);
  if (relative)
    return (
      Number.parseFloat(relative[1]!) *
      (relative[2] === "%" ? DEFAULT_ROOT_PX / 100 : DEFAULT_ROOT_PX)
    );
  const px = sizeToPx(c.value, DEFAULT_ROOT_PX);
  return px === "relative-unit" ? null : px;
}

interface FieldVerdict {
  px?: number;
  source?: string;
  unread?: Unread;
}

/**
 * Whether a `<style>` rule may hide the element or a wrapper around it. Each
 * element is tested once per page, however many fields share it, and a test
 * past the budget answers yes, which only makes the field not read.
 */
function underHideRule(
  el: Element,
  hideSelectors: Prepared[],
  memo: Map<Element, boolean>,
  budget: Budget,
): boolean {
  const chain: Element[] = [];
  let n: Element | null = el;
  while (n && !memo.has(n)) {
    chain.push(n);
    n = n.parentElement;
  }
  let hidden = n ? memo.get(n)! : false;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    if (!hidden) {
      for (const selector of hideSelectors) {
        if (!spend(budget) || matchSelector(node, selector) !== false) {
          hidden = true;
          break;
        }
      }
    }
    memo.set(node, hidden);
  }
  return hidden;
}

function judgeField(
  field: Element,
  styles: { sizeRules: SizeRule[]; hideSelectors: Prepared[] },
  rootPx: number | null,
  unseenCss: boolean,
  work: Budget & { hidden: Map<Element, boolean> },
): FieldVerdict {
  const budget = work;
  // A `<style>` rule may hide the field, or a wrapper around it, so it is
  // never focused; whether it applies at phone width is not this rule's call.
  if (
    styles.hideSelectors.length > 0 &&
    underHideRule(field, styles.hideSelectors, work.hidden, budget)
  ) {
    return { unread: "hidden" };
  }

  const c = cascade(field, styles.sizeRules, unseenCss, budget);
  if (c === null) {
    // Nothing the audit read sizes the field: a rule it cannot see may, and
    // with none, iOS's own field size applies.
    if (unseenCss) return { unread: "unseen-css" };
    return { px: IOS_DEFAULT_FIELD_PX, source: "iOS default" };
  }
  if ("unread" in c) return c;
  const px = sizeToPx(c.value, rootPx);
  if (px === "relative-unit") return { unread: "relative-unit" };
  return { px, source: c.source };
}

/** Whether the viewport tag blocks zoom, the usual workaround for this zoom. */
function viewportBlocksZoom(ctx: RuleContext): boolean {
  const content =
    ctx.parsed.document?.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  return (
    /user-scalable\s*=\s*(?:no|0)\b/i.test(content) ||
    /maximum-scale\s*=\s*1(?:\.0+)?(?![0-9])/i.test(content)
  );
}

export const inputZoomRule: Rule = {
  meta: {
    id: "mobile/input-zoom",
    name: "Form Field Zoom",
    description:
      "Checks that form fields are at least 16px so iOS Safari does not zoom in when one is focused",
    solution:
      "Give text fields, selects and textareas a font size of at least 16px at phone widths (1rem on a 16px root), for example Tailwind's `text-base md:text-sm` instead of `text-sm`. iOS Safari zooms the page in when a field under 16px is focused, which shifts the layout and pushes the submit button off screen. Do not stop the zoom with `maximum-scale=1` or `user-scalable=no` in the viewport tag: that also stops everyone who needs to zoom from doing so.",
    category: "mobile",
    scope: "page",
    // Reads each page's own fields and style blocks: pages of one template can differ.
    verdictScope: "page",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // The fields a visitor can focus, up to the cap; the focusable rest are
    // counted as not read. Past the scan cap, fields are counted unchecked.
    // A field nested past the depth cap is counted as not read.
    const fields: Element[] = [];
    let overCap = 0;
    let scanned = 0;
    const styleHides = new Map<Element, boolean | "unknown">();
    for (const el of doc.querySelectorAll("input, select, textarea")) {
      if (!isTextEntry(el)) continue;
      scanned++;
      const unchecked = scanned > MAX_SCANNED_FIELDS;
      const tooDeep = !unchecked && depthOf(el, MAX_FIELD_DEPTH) > MAX_FIELD_DEPTH;
      const focus = unchecked || tooDeep ? "unknown" : canFocus(el, styleHides);
      if (focus === false) continue;
      if (focus === "unknown" || fields.length >= MAX_FIELDS) overCap++;
      else fields.push(el);
    }
    // A page with no text field has nothing to zoom into.
    if (fields.length + overCap === 0) return { checks: [] };

    const blocks: StyleBlock[] = [];
    // Past the block cap, or a block nested past the depth cap: not read.
    let tooManyBlocks = false;
    for (const el of doc.querySelectorAll("style")) {
      if (blocks.length >= MAX_STYLE_BLOCKS) {
        tooManyBlocks = true;
        break;
      }
      // A print sheet never styles the screen, and a `<noscript>` or
      // `<template>` sheet is not live in a browser running scripts.
      // A block nested past the depth cap is not read, so its sheet is not either.
      if (depthOf(el, MAX_FIELD_DEPTH) > MAX_FIELD_DEPTH) {
        tooManyBlocks = true;
        break;
      }
      const media = (el.getAttribute("media") || "").trim().toLowerCase();
      if (media === "print" || el.closest("noscript, template") !== null) continue;
      blocks.push({
        text: el.textContent || "",
        conditional: media !== "" && media !== "all" && media !== "screen",
      });
    }
    const styles = readStyleRules(blocks);
    if (tooManyBlocks) styles.truncated = true;
    // A stylesheet linked (or preloaded as a style and switched on by script)
    // or imported may size the fields or the root, and outrank `<style>` rules.
    const hasExternalCss =
      doc.querySelector('link[rel~="stylesheet" i], link[rel~="preload" i][as="style" i]') !==
        null || blocks.some((b) => /@import\b/i.test(b.text));
    const unseenCss = hasExternalCss || styles.nested;

    const budget = {
      calls: MAX_MATCH_CALLS,
      deadline: performance.now() + MAX_MATCH_MS,
      hidden: new Map<Element, boolean>(),
    };
    const rootPx = styles.truncated
      ? null
      : resolveRoot(doc.documentElement, styles.sizeRules, unseenCss, budget);
    const small: Array<{ field: Element; px: number; source: string }> = [];
    let unread = overCap;
    for (const field of fields) {
      // Past the stylesheet budget, a rule the audit never read may size any field.
      const verdict: FieldVerdict = styles.truncated
        ? { unread: "budget" }
        : judgeField(field, styles, rootPx, unseenCss, budget);
      if (verdict.unread) unread++;
      else if (verdict.px !== undefined && verdict.px < MIN_FIELD_PX) {
        small.push({ field, px: verdict.px, source: verdict.source! });
      }
    }
    const total = fields.length + overCap;

    const checks: CheckResult[] = [];
    const notRead =
      unread > 0
        ? ` ${unread} more field(s) were not read: their size comes from a stylesheet or rule a static audit cannot resolve.`
        : "";
    if (small.length > 0) {
      const viewport = viewportBlocksZoom(ctx)
        ? " The viewport's maximum-scale=1 or user-scalable=no hides the zoom on iOS but blocks zoom for everyone; a 16px field size fixes both."
        : "";
      checks.push({
        name: "input-zoom",
        status: "warn",
        message: `${small.length} form field(s) under 16px make iOS Safari zoom in on focus.${viewport}${notRead}`,
        items: small.slice(0, MAX_ITEMS).map(({ field, px, source }) => ({
          id: describeField(field),
          label: `${formatPx(px)} (${source})`,
        })),
        details: {
          fields: total,
          under16px: small.length,
          notRead: unread,
          ...(small.length > MAX_ITEMS ? { additional: small.length - MAX_ITEMS } : {}),
        },
      });
    } else if (unread > 0) {
      checks.push({
        name: "input-zoom",
        status: "info",
        message: `No form field read is under 16px.${notRead}`,
        details: { fields: total, under16px: 0, notRead: unread, inconclusive: true },
      });
    } else {
      checks.push({
        name: "input-zoom",
        status: "pass",
        message: "No form field is under 16px",
        details: { fields: total, under16px: 0, notRead: 0 },
      });
    }
    return { checks };
  },
};
