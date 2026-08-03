// content/hidden-text - Hidden text and link abuse (Google spam policy)
//
// There is no layout engine and no CSSOM here, so there is no getComputedStyle
// and no way to resolve the cascade. Everything below works from what is
// directly readable on the page: inline `style` attributes, `<style>` rules
// whose selector is a bare class or id, and the `hidden` / `aria-hidden`
// attributes. Every judgement call is biased toward precision — telling a site
// it is cloaking text when it is not is far more damaging than missing a page.

import { z } from "zod";

import type { Document, Element } from "linkedom";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { getTextExcludingScripts } from "./text-content";

export const optionsSchema = z.object({
  min_hidden_chars: z
    .number()
    .int()
    .min(1)
    .default(50)
    .describe("Characters of hidden text on one element before it is reported"),
  min_hidden_links: z
    .number()
    .int()
    .min(1)
    .default(10)
    // A collapsed submenu or a responsive footer copy routinely holds a handful
    // of links, so a low bar here turns ordinary chrome into a link-cloaking
    // accusation. A block hidden to feed a crawler carries many more.
    .describe("Hidden links before the finding escalates from a warning to a failure"),
  offscreen_px_threshold: z
    .number()
    .default(-999)
    .describe("Offsets at or below this many pixels count as pushed off-screen"),
  a11y_classes: z
    .array(z.string())
    .default([])
    .describe("Extra screen-reader-only class names to treat as legitimate"),
  safe_classes: z
    .array(z.string())
    .default([])
    .describe("Extra class names to exempt from hidden-text reporting"),
});

/**
 * The screen-reader-only idiom under its common names. Text hidden this way is
 * deliberate, Google handles it, and flagging it would libel every site using a
 * utility class — so these are exempt before any technique is even considered.
 */
const A11Y_CLASSES = new Set([
  "sr-only",
  "sronly",
  "sr-only-focusable",
  "visually-hidden",
  "visuallyhidden",
  "visually-hidden-focusable",
  "screen-reader-text",
  "screen-reader-only",
  "screenreader-only",
  "show-for-sr",
  "element-invisible",
  "a11y-hidden",
  "hidden-visually",
  "hiddenvisually",
  "assistive-text",
  "skip-link",
  "skip-to-content",
]);

/**
 * Class tokens that mark interactive or stateful UI which is *supposed* to start
 * hidden: tabs, accordions, dropdowns, modals, off-canvas nav, cookie banners.
 * Without a CSSOM we cannot see the `.is-open` rule that reveals them, so their
 * hidden state is treated as intentional rather than as spam.
 */
const INTERACTIVE_CLASS_TOKENS = new Set([
  "accordion",
  "accordions",
  "alert",
  "alertdialog",
  "backdrop",
  "banner",
  "carousel",
  "collapse",
  "collapsible",
  "combobox",
  "consent",
  "cookie",
  "cookies",
  "ccpa",
  "dialog",
  "disclosure",
  "drawer",
  "dropdown",
  "dropdowns",
  "expander",
  "flyout",
  "gdpr",
  "glide",
  "hamburger",
  "lightbox",
  "megamenu",
  "menu",
  "menus",
  "modal",
  "modals",
  "nav",
  "navbar",
  "navigation",
  "notification",
  "notifications",
  "offcanvas",
  "overlay",
  "panel",
  "panels",
  "popover",
  "popup",
  "slide",
  "slides",
  "slider",
  "snackbar",
  "splide",
  "submenu",
  "swiper",
  "tab",
  "tabs",
  "tabpanel",
  "toast",
  "tooltip",
  "tooltips",
  "typeahead",
]);

/**
 * Tokens that mark an element as visible only in some other medium or at some
 * other viewport (`.nomobile`, `.desktop-only`, `.noprint`). `@media` blocks are
 * stripped before indexing, so the rule that reveals these is one we can never
 * see — `display:none` on them means "not here", not "nowhere".
 */
const MEDIA_VARIANT_CLASS_TOKENS = new Set([
  "desktop",
  "handheld",
  "mobile",
  "nodesktop",
  "nomobile",
  "noprint",
  "notablet",
  "phone",
  "print",
  "printonly",
  "screen",
  "screenonly",
  "tablet",
]);

/**
 * Tokens a framework flips to reveal an element (`.is-open`, `.accordion.show`).
 * Their presence means the element's visibility is script-driven, and the rule
 * that reveals it is exactly the kind of compound selector we deliberately skip.
 */
const STATE_CLASS_TOKENS = new Set([
  "active",
  "closed",
  "collapsed",
  "current",
  "expanded",
  "hidden",
  "hide",
  "inactive",
  "invisible",
  "open",
  "opened",
  "selected",
  "show",
  "shown",
  "visible",
]);

/** Landmark/widget roles whose regions are routinely rendered hidden by default. */
const INTERACTIVE_ROLES = new Set([
  "alert",
  "alertdialog",
  "banner",
  "combobox",
  "dialog",
  "listbox",
  "log",
  "menu",
  "menubar",
  "navigation",
  "region",
  "status",
  "tablist",
  "tabpanel",
  "tooltip",
  "tree",
]);

/** Tags that are containers for interactive or stateful UI. */
const INTERACTIVE_TAGS = new Set(["dialog", "details", "summary", "nav", "menu"]);

/** Never walked into: not indexable content, or handled by other rules. */
const SKIPPED_TAGS = new Set(["script", "style", "noscript", "template", "iframe", "svg", "canvas"]);

/** Attribute prefixes used by toggle libraries (Bootstrap, Radix, Headless UI, Alpine). */
const TOGGLE_ATTR_RE =
  /^(?:data-(?:bs-)?(?:toggle|target|dismiss|state|open|collapse|accordion|dropdown|modal|drawer|menu|popover|tooltip|carousel|slide|tab|cookie|consent)|x-show|x-cloak|v-show|data-headlessui-state|data-radix-[a-z-]+)$/;

const MAX_ANCESTOR_DEPTH = 15;
const MAX_ELEMENTS = 20_000;
const MAX_STYLE_CHARS = 400_000;
const MAX_STYLE_RULES = 4_000;
const MAX_ITEMS = 10;
const MAX_SCRIPT_CHARS = 2_000_000;
/** Below this, a class/id token collides with ordinary script text by chance. */
const MIN_SCRIPT_TOKEN_LENGTH = 5;
/** Channel distance below which two opaque colours read as the same paint. */
const COLOR_MATCH_DISTANCE = 16;
const EM_TO_PX = 16;
const EX_TO_PX = 8;
const PT_TO_PX = 4 / 3;

type Declarations = Map<string, string>;

interface StyleIndex {
  /** Declarations keyed by class token, merged in stylesheet order (later wins). */
  byClass: Map<string, Declarations>;
  /** Declarations keyed by id. */
  byId: Map<string, Declarations>;
  /**
   * Class tokens and ids that also appear in a selector we refused to parse
   * (descendant, compound, pseudo, attribute). Such an element may well be
   * revealed by a rule we cannot see, so a stylesheet-only hidden verdict on it
   * is not trustworthy and is dropped.
   */
  ambiguousClasses: Set<string>;
  ambiguousIds: Set<string>;
  /**
   * Class tokens and ids named anywhere in a block that declares a transition or
   * animation. The fade-in idiom puts the resting `opacity:0` on the element's
   * own class and the transition on a compound selector (`.card.is-visible`), so
   * an element-local check alone reads a scroll reveal as hidden text.
   */
  animatedClasses: Set<string>;
  animatedIds: Set<string>;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  green: [0, 128, 0],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  navy: [0, 0, 128],
  whitesmoke: [245, 245, 245],
  snow: [255, 250, 250],
  ivory: [255, 255, 240],
  linen: [250, 240, 230],
};

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#fff`, `#ffffffff`, `rgb()/rgba()` (legacy and space-separated), or a named colour. */
export function parseColor(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const named = NAMED_COLORS[value];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expand = (c: string) => Number.parseInt(c + c, 16);
    if (/^[0-9a-f]{3,4}$/.test(hex)) {
      return {
        r: expand(hex[0]),
        g: expand(hex[1]),
        b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
      };
    }
    if (/^[0-9a-f]{6}$/.test(hex) || /^[0-9a-f]{8}$/.test(hex)) {
      const byte = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
      return { r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) / 255 : 1 };
    }
    return null;
  }

  const fn = value.match(/^rgba?\(([^)]+)\)$/);
  if (!fn) return null;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (part: string): number | null => {
    if (part.endsWith("%")) {
      const pct = Number.parseFloat(part);
      return Number.isNaN(pct) ? null : Math.round((pct / 100) * 255);
    }
    const n = Number.parseFloat(part);
    return Number.isNaN(n) ? null : Math.round(n);
  };
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  if (r === null || g === null || b === null) return null;
  let a = 1;
  if (parts[3] !== undefined) {
    a = parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
    if (Number.isNaN(a)) a = 1;
  }
  return { r, g, b, a };
}

/** `background-color`, or the colour inside a `background` shorthand. */
function backgroundColorOf(decls: Declarations): Rgba | null {
  const explicit = decls.get("background-color");
  if (explicit) return parseColor(explicit);
  const shorthand = decls.get("background");
  if (!shorthand || shorthand.includes("url(") || shorthand.includes("gradient")) return null;
  for (const token of shorthand.split(/\s+/)) {
    const color = parseColor(token);
    if (color) return color;
  }
  return null;
}

function colorDistance(a: Rgba, b: Rgba): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * A CSS length in pixels, or null when it cannot be resolved. Unitless non-zero
 * values return null on purpose: browsers reject them, so `left:-9999` does not
 * actually hide anything and must not be reported as if it did.
 */
export function parseLengthPx(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  const match = value.match(/^(-?\d*\.?\d+)(px|em|rem|pt|ex|ch)?$/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  if (Number.isNaN(n)) return null;
  const unit = match[2];
  if (!unit) return n === 0 ? 0 : null;
  if (unit === "px") return n;
  if (unit === "pt") return n * PT_TO_PX;
  // Font-relative units are approximated against a default 16px font. `ex` and
  // `ch` are roughly half an em; using the em factor for them would read
  // `-100ch` as twice as far off-screen as it is and flag ordinary indentation.
  if (unit === "ex" || unit === "ch") return n * EX_TO_PX;
  return n * EM_TO_PX; // em / rem
}

function isZeroLength(raw: string): boolean {
  return /^-?0*(?:\.0+)?(?:px|em|rem|pt|%|vh|vw|ex|ch)?$/.test(raw.trim().toLowerCase());
}

/**
 * Index just past a quoted string that starts at `start`. Used by every scanner
 * below so that punctuation inside a quoted value or a `data:` URL cannot be
 * mistaken for structure.
 */
function skipString(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return css.length;
}

/** Index just past a CSS comment starting at `start`, or end of input. */
function skipComment(css: string, start: number): number {
  const end = css.indexOf("*/", start + 2);
  return end === -1 ? css.length : end + 2;
}

/**
 * Parses a declaration block (`color:red;display:none`) into a property map.
 * Splits on the structural `;` and `:` only: `background:url("data:…;base64,…")`
 * carries both inside a quoted string and a `url()`, and naive splitting there
 * manufactures declarations that were never written.
 */
export function parseDeclarations(css: string): Declarations {
  const decls: Declarations = new Map();
  let i = 0;
  let chunkStart = 0;
  let depth = 0;

  const flush = (end: number): void => {
    const chunk = css.slice(chunkStart, end);
    let colon = -1;
    let d = 0;
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk[k];
      if (c === "(") d++;
      else if (c === ")") d--;
      else if (c === ":" && d === 0) {
        colon = k;
        break;
      }
    }
    if (colon === -1) return;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    if (!prop) return;
    const value = chunk
      .slice(colon + 1)
      .replace(/!\s*important/gi, "")
      .trim()
      .toLowerCase();
    if (!value) return;
    decls.set(prop, value);
  };

  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      flush(i);
      chunkStart = i + 1;
    }
    i++;
  }
  flush(css.length);
  return decls;
}

/** One style rule lifted out of a sheet, with whether an at-rule encloses it. */
interface RawRule {
  selector: string;
  body: string;
  /**
   * The rule sits inside `@media`/`@supports`/`@layer`/`@keyframes`. Such a rule
   * is never applied — `@media print { .no-print { display:none } }` hides
   * nothing on screen — but it is not forgotten either: the selectors it names
   * are the ones that would reveal an element again, so they are marked
   * untrustworthy instead.
   */
  conditional: boolean;
}

/**
 * A single linear pass over a stylesheet. Deliberately hand-written: the regex
 * form (`/([^{}]+)\{([^{}]*)\}/g` over comment-stripped text) backtracks
 * quadratically, and a page carrying 200KB of brace-less or unterminated-comment
 * CSS took 26 seconds to index — a crawler-wide stall on attacker-supplied
 * input. This scanner is O(n) and allocates only the rules it yields.
 */
function parseRules(css: string, maxRules: number): RawRule[] {
  const rules: RawRule[] = [];
  let i = 0;
  let preludeStart = 0;
  let atDepth = 0;

  while (i < css.length && rules.length < maxRules) {
    const ch = css[i];

    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    // A statement at-rule (`@import url(…);`) or a stray semicolon: whatever
    // came before it was not a selector.
    if (ch === ";") {
      i++;
      preludeStart = i;
      continue;
    }
    if (ch === "}") {
      if (atDepth > 0) atDepth--;
      i++;
      preludeStart = i;
      continue;
    }
    if (ch !== "{") {
      i++;
      continue;
    }

    const prelude = css.slice(preludeStart, i).trim();
    // `@media`, `@supports`, `@layer`, `@keyframes`: descend, marking everything
    // inside as conditional rather than skipping past it.
    if (prelude.startsWith("@")) {
      atDepth++;
      i++;
      preludeStart = i;
      continue;
    }

    // A style rule. Consume its whole block, including any nested braces, so a
    // malformed sheet cannot desynchronise the scan.
    const bodyStart = i + 1;
    let depth = 1;
    let j = bodyStart;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === "/" && css[j + 1] === "*") {
        j = skipComment(css, j);
        continue;
      }
      if (c === '"' || c === "'") {
        j = skipString(css, j);
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    rules.push({
      selector: prelude,
      body: css.slice(bodyStart, depth === 0 ? j - 1 : css.length),
      conditional: atDepth > 0,
    });
    i = j;
    preludeStart = i;
  }

  return rules;
}

/** Adds every class / id token a selector chunk mentions to the given sets. */
function harvestSelectorTokens(text: string, classes: Set<string>, ids: Set<string>): void {
  for (const cls of text.matchAll(/\.([-_a-zA-Z0-9]+)/g)) classes.add(cls[1]);
  for (const id of text.matchAll(/#([-_a-zA-Z0-9]+)/g)) ids.add(id[1]);
}

/**
 * Merges a rule's declarations into the index. Two bare selectors setting the
 * same property to different values cannot be ordered without tracking
 * specificity and source order, so the property is recorded as contested and
 * later dropped rather than guessed at.
 */
function mergeInto(
  target: Map<string, Declarations>,
  contested: Set<string>,
  key: string,
  decls: Declarations,
): void {
  const existing = target.get(key);
  if (!existing) {
    target.set(key, new Map(decls));
    return;
  }
  for (const [prop, value] of decls) {
    const previous = existing.get(prop);
    if (previous !== undefined && previous !== value) contested.add(key);
    existing.set(prop, value);
  }
}

/** Indexes every `<style>` block by bare class / id selector. Complex selectors are skipped. */
export function buildStyleIndex(styleTexts: string[]): StyleIndex {
  const index: StyleIndex = {
    byClass: new Map(),
    byId: new Map(),
    ambiguousClasses: new Set(),
    ambiguousIds: new Set(),
    animatedClasses: new Set(),
    animatedIds: new Set(),
  };

  let budget = MAX_STYLE_CHARS;
  let ruleBudget = MAX_STYLE_RULES;

  for (const raw of styleTexts) {
    if (budget <= 0 || ruleBudget <= 0) break;
    const text = raw.slice(0, budget);
    budget -= text.length;

    for (const rule of parseRules(text, ruleBudget)) {
      ruleBudget--;

      if (rule.conditional) {
        harvestSelectorTokens(rule.selector, index.ambiguousClasses, index.ambiguousIds);
        continue;
      }

      const decls = parseDeclarations(rule.body);
      if (decls.size === 0) continue;

      // A block that animates marks its subjects as animated wherever they were
      // named, so `.card { opacity:0 }` + `.card.in { transition:opacity .3s }`
      // reads as a scroll reveal rather than as concealed text.
      if (hasAnimation(decls)) {
        harvestSelectorTokens(rule.selector, index.animatedClasses, index.animatedIds);
      }

      for (const rawSelector of rule.selector.split(",")) {
        const selector = rawSelector.trim();
        if (/^\.[-_a-zA-Z0-9]+$/.test(selector)) {
          mergeInto(index.byClass, index.ambiguousClasses, selector.slice(1), decls);
          continue;
        }
        if (/^#[-_a-zA-Z0-9]+$/.test(selector)) {
          mergeInto(index.byId, index.ambiguousIds, selector.slice(1), decls);
          continue;
        }
        // Anything else (descendant, compound, pseudo, attribute) is not
        // resolved; it only marks the tokens it mentions as untrustworthy.
        harvestSelectorTokens(selector, index.ambiguousClasses, index.ambiguousIds);
      }
    }
  }

  return index;
}

/**
 * The element's class attribute as written. Class names are case-sensitive in
 * standards-mode HTML, so these are matched against the style index verbatim;
 * only the allowlist comparisons lower-case them.
 */
function classTokens(el: Element): string[] {
  const cls = el.getAttribute("class");
  if (!cls) return [];
  return cls.split(/\s+/).filter(Boolean);
}

/** Class tokens split further on `-` and `_` and lower-cased, for allowlists. */
function classNameParts(el: Element): string[] {
  const parts: string[] = [];
  for (const token of classTokens(el)) {
    const lower = token.toLowerCase();
    parts.push(lower);
    // Hyphenated and underscored compounds count part-by-part:
    // `cookie-banner`, `tab_panel`.
    for (const part of lower.split(/[-_]+/)) {
      if (part && part !== lower) parts.push(part);
    }
  }
  return parts;
}

function tagOf(el: Element): string {
  return (el.tagName || "").toLowerCase();
}

/**
 * Resolved declarations for one element, applied in ascending specificity:
 * class rules, then the id rule, then inline. Two class rules that disagree on
 * a property cannot be ordered without source order, so `mergeInto` has already
 * marked such a class contested and `ambiguous` drops the verdict entirely.
 */
function resolveDeclarations(
  el: Element,
  index: StyleIndex,
): { resolved: Declarations; inline: Declarations; ambiguous: boolean; animated: boolean } {
  const resolved: Declarations = new Map();
  let ambiguous = false;
  let animated = false;

  for (const token of classTokens(el)) {
    const byClass = index.byClass.get(token);
    if (byClass) for (const [prop, value] of byClass) resolved.set(prop, value);
    if (index.ambiguousClasses.has(token)) ambiguous = true;
    if (index.animatedClasses.has(token)) animated = true;
  }

  const id = el.getAttribute("id") || "";
  if (id) {
    const byId = index.byId.get(id);
    if (byId) for (const [prop, value] of byId) resolved.set(prop, value);
    if (index.ambiguousIds.has(id)) ambiguous = true;
    if (index.animatedIds.has(id)) animated = true;
  }

  const inline = parseDeclarations(el.getAttribute("style") || "");
  for (const [prop, value] of inline) resolved.set(prop, value);

  return { resolved, inline, ambiguous, animated };
}

const NO_DECLARATIONS: Declarations = new Map();

/** True when this element declares itself legitimate hidden UI. */
function hasLegitimateMarker(el: Element, decls: Declarations, opts: ResolvedOptions): boolean {
  // The platform's own toggle markers. Without a CSSOM we cannot distinguish a
  // JS-toggled region from a permanently hidden one, and these attributes are
  // an explicit statement of intent, so they exempt rather than incriminate.
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("aria-expanded")) return true;
  if (el.hasAttribute("aria-controls")) return true;
  if (el.hasAttribute("aria-modal")) return true;
  if (el.hasAttribute("aria-haspopup")) return true;
  if (el.hasAttribute("aria-live")) return true;

  if (INTERACTIVE_TAGS.has(tagOf(el))) return true;

  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  for (const name of el.getAttributeNames()) {
    if (TOGGLE_ATTR_RE.test(name.toLowerCase())) return true;
  }

  for (const part of classNameParts(el)) {
    if (A11Y_CLASSES.has(part) || opts.a11yClasses.has(part)) return true;
    if (opts.safeClasses.has(part)) return true;
    if (INTERACTIVE_CLASS_TOKENS.has(part)) return true;
    if (MEDIA_VARIANT_CLASS_TOKENS.has(part)) return true;
    if (STATE_CLASS_TOKENS.has(part)) return true;
  }

  // The clip / clip-path screen-reader idiom, in any of its spellings.
  if (decls.has("clip") || decls.has("clip-path")) return true;

  // The other half of that idiom: a 1x1 box parked off-screen.
  const w = decls.get("width");
  const h = decls.get("height");
  if (w && h) {
    const wpx = parseLengthPx(w);
    const hpx = parseLengthPx(h);
    if (wpx !== null && hpx !== null && wpx <= 1 && hpx <= 1) return true;
  }

  return false;
}

/**
 * The same test applied to the ancestor chain, on markup signals only. A tab
 * panel usually carries no marker of its own — its `role="tablist"` wrapper or
 * `.cookie-banner` container does — so a hidden element nested inside declared
 * interactive UI is treated as part of that UI.
 */
function ancestorHasLegitimateMarker(el: Element, opts: ResolvedOptions): boolean {
  let current = el.parentElement as Element | null;
  let depth = 0;
  while (current && depth < MAX_ANCESTOR_DEPTH) {
    if (tagOf(current) === "body") return false;
    if (hasLegitimateMarker(current, NO_DECLARATIONS, opts)) return true;
    current = current.parentElement as Element | null;
    depth++;
  }
  return false;
}

/** A declared transition or animation. Used both per-element and to index selectors. */
function hasAnimation(decls: Declarations): boolean {
  for (const prop of decls.keys()) {
    if (prop.startsWith("transition") || prop.startsWith("animation")) return true;
  }
  return false;
}

/**
 * The entrance-animation resting state every reveal library writes:
 * `opacity:0;transform:translateY(25px)`. Text being concealed has no reason to
 * also be displaced, so a transform alongside the fade is evidence of motion.
 * A transform that is itself an off-screen shove does not count — that is the
 * hiding technique, not a guard against it. Element-local only: indexing
 * `transform` as animation would exempt every `.icon { transform: rotate(45deg) }`.
 */
function hasEntranceTransform(decls: Declarations): boolean {
  const transform = decls.get("transform");
  if (!transform || transform === "none") return false;
  return !/-\d{3,}(?:px|em|rem|%)/.test(transform);
}

/**
 * Anything painted behind the text that is not a flat colour. Gradients count:
 * `background:linear-gradient(...)` under white text is a hero banner, and
 * treating the page's own background colour as what shows through would accuse
 * it of hiding the caption.
 */
function hasBackgroundImage(decls: Declarations): boolean {
  const bgImage = decls.get("background-image");
  if (bgImage && bgImage !== "none") return true;
  const bg = decls.get("background");
  return Boolean(bg && (bg.includes("url(") || bg.includes("gradient")));
}

/**
 * A hiding technique found on one element. `kind` drives how much of the
 * subtree the technique actually hides; `label` is what the report shows.
 */
export interface Technique {
  kind: "display" | "visibility" | "opacity" | "font-size" | "offscreen" | "zero-size" | "color";
  label: string;
}

/**
 * Techniques a toggle library also writes, so they carry no weight on an element
 * the page's own scripts address. The rest have no legitimate scripted use.
 */
const WEAK_TECHNIQUES = new Set<Technique["kind"]>(["display", "visibility", "opacity"]);

/**
 * The hiding techniques declared on one element. `decls` is what we trust for
 * detection; `guards` is the widest view we have and is only ever used to
 * suppress, so a suppressing declaration is never missed.
 */
export function detectTechniques(
  decls: Declarations,
  guards: Declarations,
  offscreenThreshold: number,
  /** The element is animated by a rule elsewhere in the sheet (scroll reveal). */
  animatedElsewhere = false,
): Technique[] {
  const techniques: Technique[] = [];
  const animated = animatedElsewhere || hasAnimation(guards) || hasEntranceTransform(guards);

  if (decls.get("display") === "none") techniques.push({ kind: "display", label: "display:none" });

  // `visibility:hidden` and `opacity:0` alongside a transition or animation are
  // the universal fade-in / crossfade idiom, not concealment.
  const visibility = decls.get("visibility");
  if ((visibility === "hidden" || visibility === "collapse") && !animated) {
    techniques.push({ kind: "visibility", label: "visibility:hidden" });
  }

  const opacity = decls.get("opacity");
  if (opacity !== undefined && Number.parseFloat(opacity) === 0 && !animated) {
    techniques.push({ kind: "opacity", label: "opacity:0" });
  }

  const fontSize = decls.get("font-size");
  if (fontSize !== undefined && isZeroLength(fontSize)) {
    techniques.push({ kind: "font-size", label: "font-size:0" });
  }

  // Off-screen positioning. A background image means image replacement (a logo
  // whose alt text is pushed off-screen), which is a design idiom, not spam.
  if (!hasBackgroundImage(guards)) {
    const textIndent = decls.get("text-indent");
    if (textIndent !== undefined) {
      const px = parseLengthPx(textIndent);
      const pct = textIndent.endsWith("%") ? Number.parseFloat(textIndent) : null;
      if ((px !== null && px <= offscreenThreshold) || (pct !== null && pct <= -100)) {
        techniques.push({ kind: "offscreen", label: "text-indent off-screen" });
      }
    }

    const position = decls.get("position");
    if (position === "absolute" || position === "fixed") {
      for (const prop of ["left", "top"] as const) {
        const px = parseLengthPx(decls.get(prop) ?? "");
        if (px !== null && px <= offscreenThreshold) {
          techniques.push({
            kind: "offscreen",
            label: `position:${position} ${prop}:${decls.get(prop)}`,
          });
          break;
        }
      }
    }

    for (const prop of ["margin-left", "margin-top"] as const) {
      const px = parseLengthPx(decls.get(prop) ?? "");
      if (px !== null && px <= offscreenThreshold) {
        techniques.push({ kind: "offscreen", label: `${prop} off-screen` });
        break;
      }
    }
  }

  // Zero-size clipping. An animated collapse (`max-height:0` + transition) is an
  // accordion mid-flight, so the animation guard applies here too.
  const overflow = guards.get("overflow") ?? guards.get("overflow-y") ?? guards.get("overflow-x");
  if (overflow === "hidden" && !animated) {
    const collapsed = (["height", "width", "max-height", "max-width"] as const).find((prop) => {
      const value = decls.get(prop);
      return value !== undefined && isZeroLength(value);
    });
    if (collapsed) {
      techniques.push({ kind: "zero-size", label: `${collapsed}:0 with overflow:hidden` });
    }
  }

  return techniques;
}

/**
 * Text painted in (or as) its own backdrop. Only same-element declarations, or
 * the nearest ancestor that actually paints a background, are compared — the
 * cascade is never guessed at.
 */
function detectColorOnColor(
  decls: Declarations,
  guards: Declarations,
  backdrop: Rgba | null,
): Technique | null {
  // A gradient/clipped fill legitimately sets a transparent colour.
  if (guards.has("-webkit-text-fill-color")) return null;
  const clip = guards.get("background-clip") ?? guards.get("-webkit-background-clip");
  if (clip === "text") return null;

  const rawColor = decls.get("color");
  if (!rawColor) return null;
  const color = parseColor(rawColor);
  if (!color) return null;

  if (color.a === 0) return { kind: "color", label: "color:transparent" };

  const rawBg = decls.get("background-color") ?? decls.get("background");
  const ownBg = backgroundColorOf(decls);
  const against = ownBg && ownBg.a === 1 ? ownBg : backdrop;
  if (!against || against.a !== 1 || color.a !== 1) return null;
  if (colorDistance(color, against) > COLOR_MATCH_DISTANCE) return null;

  return { kind: "color", label: `color ${rawColor} on background ${rawBg ?? "inherited"}` };
}

/**
 * Whether any descendant escapes an inherited technique. `color`, `font-size`
 * and `visibility` are inherited, so a descendant re-declaring one of them
 * escapes the ancestor's value and its text is still visible. A colour finding
 * has a second escape: a descendant that paints its own opaque background is no
 * longer the colour-on-colour the ancestor set up, whatever it inherited.
 */
function descendantDeclares(el: Element, index: StyleIndex, prop: string): boolean {
  const stack: Element[] = [...el.children] as Element[];
  let budget = 400;
  while (stack.length > 0) {
    if (budget-- <= 0) return true; // too large to be sure — assume an override
    const current = stack.pop() as Element;
    if (SKIPPED_TAGS.has(tagOf(current))) continue;
    const { resolved } = resolveDeclarations(current, index);
    if (resolved.has(prop)) return true;
    if (prop === "color" && (backgroundColorOf(resolved) || hasBackgroundImage(resolved))) {
      return true;
    }
    for (const child of current.children) stack.push(child as Element);
  }
  return false;
}

/** Whitespace-collapsed length of an element's indexable text. */
function textLength(el: Element): number {
  return getTextExcludingScripts(el).replace(/\s+/g, " ").trim().length;
}

/** Text in this element's own text nodes only (children may reset an inherited font-size). */
function directTextLength(el: Element): number {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.textContent || "";
  }
  return text.replace(/\s+/g, " ").trim().length;
}

/** Leading `scheme:` of a URL, if it has one. */
const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Links a crawler would actually follow. An allow-list, not a deny-list: only
 * http(s) and scheme-relative or relative hrefs are links a search engine
 * indexes. `mailto:`, `tel:`, `data:`, `javascript:` and the rest carry no link
 * equity, and counting them would inflate the tally that escalates this check
 * from a warning to a failure.
 */
function countIndexableLinks(el: Element): number {
  let count = 0;
  for (const a of el.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#")) continue;
    const scheme = href.match(URL_SCHEME_RE)?.[1].toLowerCase();
    if (scheme && scheme !== "http" && scheme !== "https") continue;
    count++;
  }
  return count;
}

/**
 * The page's own inline scripts, lowercased, for the script-reference guard.
 * Capped: hydration payloads run to megabytes and this is only ever a hint.
 */
function collectScriptText(doc: Document): string {
  let out = "";
  for (const script of doc.querySelectorAll("script")) {
    if (out.length >= MAX_SCRIPT_CHARS) break;
    out += (script.textContent || "").toLowerCase();
  }
  return out.slice(0, MAX_SCRIPT_CHARS);
}

/**
 * True when the page's own JavaScript names this element by id or class. Such an
 * element's hidden state is script-controlled — a tab, a form's success message,
 * a footer revealed after hydration — and we cannot run the script that reveals
 * it. Text placed to deceive a crawler has no reason to be addressed by the
 * page's own code. Short tokens are ignored: `cta` or `row` would collide with
 * ordinary script text and exempt half the page.
 */
function isScriptReferenced(el: Element, scriptText: string): boolean {
  if (!scriptText) return false;
  const id = (el.getAttribute("id") || "").toLowerCase();
  if (id.length >= MIN_SCRIPT_TOKEN_LENGTH && scriptText.includes(id)) return true;
  for (const token of classTokens(el)) {
    const lower = token.toLowerCase();
    if (lower.length >= MIN_SCRIPT_TOKEN_LENGTH && scriptText.includes(lower)) return true;
  }
  return false;
}

/** A short, human-readable handle for the offending node. */
function describeElement(el: Element): string {
  let label = tagOf(el) || "element";
  const id = el.getAttribute("id");
  if (id) label += `#${id}`;
  const classes = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
  for (const cls of classes.slice(0, 2)) label += `.${cls}`;
  return label;
}

/** The colour the page paints behind everything: `<body>`'s background, else `<html>`'s. */
function pageBackdrop(root: Element | null, body: Element, index: StyleIndex): Rgba | null {
  for (const el of [body, root]) {
    if (!el) continue;
    const decls = resolveDeclarations(el, index).resolved;
    // A page-wide image or gradient makes the backdrop unknowable, and a
    // `background-color` declared beside it is only the fallback beneath it.
    if (hasBackgroundImage(decls)) return null;
    const color = backgroundColorOf(decls);
    if (color && color.a === 1) return color;
  }
  return null;
}

interface ResolvedOptions {
  minHiddenChars: number;
  minHiddenLinks: number;
  offscreenThreshold: number;
  a11yClasses: Set<string>;
  safeClasses: Set<string>;
}

interface HiddenFinding {
  selector: string;
  techniques: string[];
  chars: number;
  links: number;
  snippet: string;
}

export const hiddenTextRule: Rule = {
  meta: {
    id: "content/hidden-text",
    name: "Hidden Text & Links",
    description: "Detects text and links hidden from users but left visible to search engines",
    solution:
      "Google's spam policies treat text or links that are visible to crawlers but hidden from visitors as deceptive, and pages doing it can lose rankings or be removed from search entirely. Delete the hidden block, or make it genuinely visible to users. If the content is only meant for screen readers, use the standard visually-hidden pattern (a 1x1 clipped box, or a class named sr-only / visually-hidden) so it is recognisable as an accessibility affordance. If it is interactive UI that starts collapsed, mark it up as such with aria-hidden, the hidden attribute or a role like tabpanel or dialog, so its hidden state reads as intentional. Never place keywords or links behind display:none, opacity:0, a zero font size, an off-screen offset or same-on-same colour in order to reach a crawler.",
    category: "content",
    scope: "page",
    // Warning by default: the check escalates itself to a failure once hidden
    // LINKS are involved, which is the stronger spam signal.
    severity: "warning",
    weight: 6,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const parsed = optionsSchema.parse(ctx.options);
    const opts: ResolvedOptions = {
      minHiddenChars: parsed.min_hidden_chars,
      minHiddenLinks: parsed.min_hidden_links,
      offscreenThreshold: parsed.offscreen_px_threshold,
      a11yClasses: new Set(parsed.a11y_classes.map((c) => c.toLowerCase())),
      safeClasses: new Set(parsed.safe_classes.map((c) => c.toLowerCase())),
    };

    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "hidden-text",
        status: "skipped",
        message: "No body content to analyze",
        skipReason: "no-body",
      });
      return { checks };
    }

    // Built on first use: most pages never reach a weak-technique candidate.
    let scriptText: string | undefined;

    const styleTexts = [...doc.querySelectorAll("style")].map((el) => el.textContent || "");
    const index = buildStyleIndex(styleTexts);

    const findings: HiddenFinding[] = [];
    let visited = 0;
    // Depth-first over elements, outermost first: once a subtree is hidden (or
    // allowlisted) nothing inside it is inspected, so one hidden block yields
    // one finding instead of one per descendant.
    const stack: Element[] = [...body.children].reverse() as Element[];
    const backdrops = new Map<Element, Rgba | null>();
    backdrops.set(body as Element, pageBackdrop(doc.documentElement as Element, body as Element, index));

    while (stack.length > 0) {
      const el = stack.pop() as Element;
      if (visited++ > MAX_ELEMENTS) break;
      const tag = tagOf(el);
      if (SKIPPED_TAGS.has(tag)) continue;

      const { resolved, inline, ambiguous, animated } = resolveDeclarations(el, index);

      // Track the painted backdrop for descendants: background is not inherited,
      // but what shows behind an element is its nearest painting ancestor.
      const ownBgColor = backgroundColorOf(resolved);
      const parentBackdrop = backdrops.get(el.parentElement as Element) ?? null;
      // An image or gradient makes the backdrop unknowable, and unknown must not
      // decay into "the page background" — that is how white-on-photo captions
      // get accused of hiding text.
      const backdrop = hasBackgroundImage(resolved)
        ? null
        : ownBgColor && ownBgColor.a === 1
          ? ownBgColor
          : parentBackdrop;
      backdrops.set(el, backdrop);

      // A stylesheet-only verdict on an element whose class/id also appears in a
      // selector we could not parse is dropped: the unparsed rule may be the one
      // that reveals it. Inline styles are unambiguous and always count.
      const detectFrom = ambiguous ? inline : resolved;
      const techniques = detectTechniques(detectFrom, resolved, opts.offscreenThreshold, animated);
      // The inherited backdrop is only trusted for elements that sit in normal
      // flow and whose own rules we fully resolved. Positioned elements float
      // over content we cannot see, and a text-shadow is an author telling us
      // the text is meant to be legible against something unknown.
      const position = resolved.get("position");
      const backdropTrusted =
        !ambiguous &&
        !resolved.has("text-shadow") &&
        position !== "absolute" &&
        position !== "fixed" &&
        position !== "sticky";
      const colorFinding = detectColorOnColor(
        detectFrom,
        resolved,
        backdropTrusted ? backdrop : null,
      );
      if (colorFinding) techniques.push(colorFinding);

      // `visibility` is inherited but a descendant can set `visibility:visible`
      // and come back into view, so that claim is dropped when one does.
      const visibilityIndex = techniques.findIndex((t) => t.kind === "visibility");
      if (visibilityIndex !== -1 && descendantDeclares(el, index, "visibility")) {
        techniques.splice(visibilityIndex, 1);
      }

      // `display:none`, `visibility:hidden` and `opacity:0` are what every
      // toggle library writes, so on an element the page's own scripts address
      // they say nothing. The unambiguous techniques below them are kept: no
      // toggle library has ever shipped `text-indent:-9999px`.
      if (techniques.length > 0 && techniques.some((t) => WEAK_TECHNIQUES.has(t.kind))) {
        scriptText ??= collectScriptText(doc);
        if (isScriptReferenced(el, scriptText)) {
          for (let i = techniques.length - 1; i >= 0; i--) {
            if (WEAK_TECHNIQUES.has(techniques[i].kind)) techniques.splice(i, 1);
          }
        }
      }

      if (techniques.length === 0) {
        // Visible (as far as we can tell) — its children are judged on their own.
        for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i] as Element);
        continue;
      }

      // Hidden, but declared as an accessibility affordance or as interactive UI.
      if (hasLegitimateMarker(el, resolved, opts) || ancestorHasLegitimateMarker(el, opts)) {
        continue;
      }

      // How much of the subtree the techniques actually hide. `display`,
      // `opacity`, off-screen offsets and zero-size clipping take every
      // descendant with them; `font-size` and `color` are inherited, so a
      // descendant that re-declares them stays visible. When only inherited
      // techniques apply and something below re-declares them, the payload
      // shrinks to this element's own text nodes — which is also why the
      // `.grid { font-size: 0 }` whitespace hack (no direct text) never reports.
      const hidesSubtree = techniques.some(
        (t) => t.kind !== "font-size" && t.kind !== "color",
      )
        ? true
        : !techniques.some((t) => descendantDeclares(el, index, t.kind));
      const chars = hidesSubtree ? textLength(el) : directTextLength(el);
      const links = hidesSubtree ? countIndexableLinks(el) : 0;

      if (chars >= opts.minHiddenChars || links >= opts.minHiddenLinks) {
        const text = getTextExcludingScripts(el).replace(/\s+/g, " ").trim();
        findings.push({
          selector: describeElement(el),
          techniques: techniques.map((t) => t.label),
          chars,
          links,
          snippet: text.slice(0, 120),
        });
      }
      // Hidden or not reportable, the subtree inherits this element's state —
      // descending would only re-report the same text.
    }

    if (findings.length === 0) {
      checks.push({
        name: "hidden-text",
        status: "pass",
        message: "No hidden text or links detected",
      });
      return { checks };
    }

    const totalLinks = findings.reduce((sum, f) => sum + f.links, 0);
    const totalChars = findings.reduce((sum, f) => sum + f.chars, 0);
    // Hidden links are the stronger spam signal and escalate the check to a
    // failure.
    const escalated = totalLinks >= opts.minHiddenLinks;

    findings.sort((a, b) => b.links - a.links || b.chars - a.chars);

    checks.push({
      name: "hidden-text",
      status: escalated ? "fail" : "warn",
      message: escalated
        ? `${findings.length} hidden element(s) containing ${totalLinks} link(s) and ${totalChars} characters of text`
        : `${findings.length} hidden element(s) containing ${totalChars} characters of text`,
      items: findings.slice(0, MAX_ITEMS).map((f) => ({
        id: f.selector,
        label: `${f.selector} — ${f.techniques.join(", ")}`,
        meta: {
          techniques: f.techniques,
          chars: f.chars,
          links: f.links,
          snippet: f.snippet,
        },
      })),
      details: {
        hiddenElements: findings.length,
        hiddenLinks: totalLinks,
        hiddenChars: totalChars,
        ...(findings.length > MAX_ITEMS ? { additional: findings.length - MAX_ITEMS } : {}),
      },
    });

    return { checks };
  },
};
