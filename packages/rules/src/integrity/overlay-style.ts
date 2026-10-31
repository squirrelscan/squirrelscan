// Geometry of an iframe as the page's own CSS gives it, for the fake-auth-overlay detector (#784).
//
// The injected overlay does not have to write its geometry inline: `position:fixed !important`, the
// `inset:0` shorthand, or a class defined in a `<style>` block all produce the same full-viewport cover.
// Only what is cheap and safe is resolved: inline `<style>` blocks, rules whose selector is a plain
// `iframe`, `.class` or `#id` combination (no combinators, no media queries), in source order with
// `!important` winning.
//
// Work is linear in the CSS and the iframes, and no cap is applied in document order (a page can pad
// the head of a stylesheet, or the first iframes, to push the real rule or frame past one):
//   - the stylesheet is scanned once by a hand-written tokenizer (no backtracking regex, `indexOf` only
//     moves forward), over up to MAX_CSS_CHARS characters in total;
//   - only rules that can match an iframe on the page are kept (indexed by their first token), so
//     padding with rules for other elements costs the scan and nothing more;
//   - per iframe, at most MAX_RULES_PER_FRAME candidate rules are applied, the LAST ones (later rules win).

import { getAttrCI } from "@squirrelscan/utils";

/** Total CSS read per page. Past it the rest of the stylesheet is not read. */
export const MAX_CSS_CHARS = 4_000_000;
const MAX_RULES_PER_FRAME = 200;
/** A frame's `class` attribute costs this many characters per unit of the page's rule-visit budget. */
const CLASS_CHARS_PER_VISIT = 16;
/** Properties that can make an iframe an overlay; a rule that sets none of them cannot change the verdict and is not kept. */
const GEOMETRY = /^(?:position|inset(?:-[a-z]+)*|top|right|bottom|left|width|height|z-index)$/;
/** Rule visits over ALL frames of a page: past it a frame is judged by its inline style alone and the CSS is reported truncated. */
const SHEET_WORK_BUDGET = 1_000_000;
const MAX_SELECTOR_CHARS = 300;
const MAX_BODY_CHARS = 4_000;

interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

/** One selector of a rule, parsed once: an optional `iframe` tag and the `.class` / `#id` tokens that must all match. */
interface ParsedSelector {
  tag: boolean;
  classes: string[];
  ids: string[];
}

interface Rule {
  selectors: ParsedSelector[];
  declarations: Declaration[];
  /** Position in the stylesheet: later rules win. */
  order: number;
}

function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const raw of text.split(";")) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const property = raw.slice(0, idx).trim().toLowerCase();
    let value = raw.slice(idx + 1).trim().toLowerCase();
    // Anchored on the literal `!` (no leading `\s*`), so a long run of spaces cannot backtrack.
    const important = /!\s*important$/.test(value);
    if (important) value = value.replace(/!\s*important$/, "").trim();
    if (property) out.push({ property, value, important });
  }
  return out;
}

/** What the page's iframes can be selected by: the only rules worth keeping. */
interface Wanted {
  ids: Set<string>;
  classes: Set<string>;
}

const SIMPLE_SELECTOR = /^(iframe)?((?:[.#][\w-]+)*)$/;

/** The simple selectors in a list; others (combinators, attributes, pseudo-classes) are not modelled. */
function parseSelectors(selector: string): ParsedSelector[] {
  const out: ParsedSelector[] = [];
  for (const part of selector.split(",")) {
    const match = SIMPLE_SELECTOR.exec(part.trim());
    if (!match || (match[1] === undefined && match[2] === "")) continue;
    const tokens = match[2]!.match(/[.#][\w-]+/g) ?? [];
    out.push({
      tag: match[1] !== undefined,
      classes: tokens.filter((t) => t[0] === ".").map((t) => t.slice(1)),
      ids: tokens.filter((t) => t[0] === "#").map((t) => t.slice(1)),
    });
  }
  return out;
}

/** The index key (`iframe`, `.c`, `#i`) of a selector when every token could match an iframe on the page. */
function ruleKey(selector: ParsedSelector, wanted: Wanted): string | undefined {
  if (!selector.classes.every((c) => wanted.classes.has(c))) return undefined;
  if (!selector.ids.every((i) => wanted.ids.has(i))) return undefined;
  const first = selector.classes[0] ? `.${selector.classes[0]}` : selector.ids[0] ? `#${selector.ids[0]}` : undefined;
  return first ?? "iframe";
}

/**
 * One pass over a stylesheet: comments and at-rules (`@media`, `@supports`, `@keyframes`, `@import`) are
 * skipped, every other `selector { body }` is handed to `onRule`. `indexOf` only searches forward from
 * the cursor and the cursor then moves past what it found, so the scan is linear however the text is
 * built (unterminated comments, runs of openers, no braces at all).
 */
export function scanCss(css: string, onRule: (selector: string, body: string) => void): void {
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i]!;
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "}" || ch === ";") {
      i++;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    if (ch === "@") {
      // Skip to the end of the statement, or past the whole block, counting braces.
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        const c = css[j]!;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth <= 0) {
            j++;
            break;
          }
        } else if (c === ";" && depth === 0) {
          j++;
          break;
        }
      }
      i = j;
      continue;
    }
    const open = css.indexOf("{", i);
    if (open === -1) return;
    const close = css.indexOf("}", open + 1);
    if (close === -1) return;
    // A rule whose selector or body is absurdly long is not one a page needs; it is skipped, not the rest.
    if (open - i <= MAX_SELECTOR_CHARS && close - open - 1 <= MAX_BODY_CHARS) {
      onRule(css.slice(i, open).trim().toLowerCase(), css.slice(open + 1, close));
    }
    i = close + 1;
  }
}

interface Sheet {
  byKey: Map<string, Rule[]>;
  /** The stylesheet text was longer than {@link MAX_CSS_CHARS}: the rest was not read. */
  truncated: boolean;
  /** Rule visits left for frames (see {@link SHEET_WORK_BUDGET}). */
  work: number;
}

const sheetCache = new WeakMap<object, Sheet>();

function sheetFor(doc: Document, wanted: Wanted): Sheet {
  const cached = sheetCache.get(doc);
  if (cached) return cached;
  const byKey = new Map<string, Rule[]>();
  let chars = 0;
  let truncated = false;
  const position = { next: 0 };
  const cut = { dropped: false };
  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    const room = MAX_CSS_CHARS - chars;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const css = text.length > room ? text.slice(0, room) : text;
    if (text.length > room) truncated = true;
    chars += css.length;
    scanCss(css, (selector, body) => {
      const selectors = parseSelectors(selector);
      const keys = new Set<string>();
      for (const parsed of selectors) {
        const key = ruleKey(parsed, wanted);
        if (key) keys.add(key);
      }
      if (keys.size === 0) return;
      const declarations = parseDeclarations(body);
      if (!declarations.some((d) => GEOMETRY.test(d.property))) return;
      const rule: Rule = { selectors, declarations, order: position.next++ };
      for (const key of keys) {
        const list = byKey.get(key) ?? [];
        list.push(rule);
        // Later rules win, so when a key has more rules than a frame can use, the earliest are dropped AS THEY
        // ARRIVE: the per-frame work is bounded by this, not by how many rules the page carries.
        if (list.length > MAX_RULES_PER_FRAME) {
          list.shift();
          cut.dropped = true;
        }
        byKey.set(key, list);
      }
    });
  }
  const sheet: Sheet = { byKey, truncated: truncated || cut.dropped, work: SHEET_WORK_BUDGET };
  sheetCache.set(doc, sheet);
  return sheet;
}

function ruleMatches(rule: Rule, id: string, classes: Set<string>): boolean {
  return rule.selectors.some(
    (selector) => selector.classes.every((c) => classes.has(c)) && selector.ids.every((i) => i === id),
  );
}

function expandInset(value: string): Array<[string, string]> {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return [];
  const [top, right = top, bottom = top, left = right] = parts as [string, ...string[]];
  return [
    ["top", top],
    ["right", right!],
    ["bottom", bottom!],
    ["left", left!],
  ];
}

/** The stylesheet's contribution to one iframe, memoised per (id, classes): pages repeat them. */
function sheetLayers(sheet: Sheet, id: string, classes: Set<string>, memo: Map<string, Declaration[][]>): Declaration[][] {
  const key = `${id}\u0000${[...classes].sort().join(" ")}`;
  const cached = memo.get(key);
  if (cached) return cached;
  // The frame's candidate rules: the lists of its tag, id and (at most a few) classes that have any, merged and
  // cut to the LAST rules by source order, so one frame costs a bounded amount however many classes it carries.
  const lists: Rule[][] = [];
  const own = sheet.byKey.get("iframe");
  if (own) lists.push(own);
  const byId = id ? sheet.byKey.get(`#${id}`) : undefined;
  if (byId) lists.push(byId);
  for (const c of classes) {
    const list = sheet.byKey.get(`.${c}`);
    if (list) lists.push(list);
  }
  let cost = 0;
  for (const list of lists) cost += list.length;
  if (cost > sheet.work) {
    // Out of work for frames: this one is judged on its inline style alone, and the report says the CSS was not fully used.
    sheet.truncated = true;
    const empty: Declaration[][] = [[], []];
    memo.set(key, empty);
    return empty;
  }
  sheet.work -= cost;
  const unique = new Set<Rule>();
  for (const list of lists) for (const rule of list) unique.add(rule);
  let candidates = [...unique];
  if (candidates.length > MAX_RULES_PER_FRAME) {
    sheet.truncated = true;
    candidates = candidates.sort((a, b) => a.order - b.order).slice(-MAX_RULES_PER_FRAME);
  }
  // Applied in source order, so a later rule wins whichever key found it.
  candidates.sort((a, b) => a.order - b.order);
  const layers: Declaration[][] = [[], []]; // normal, !important
  for (const rule of candidates) {
    if (!ruleMatches(rule, id, classes)) continue;
    for (const d of rule.declarations) layers[d.important ? 1 : 0]!.push(d);
  }
  memo.set(key, layers);
  return layers;
}

const memoCache = new WeakMap<object, Map<string, Declaration[][]>>();

/** The iframe's resolved style properties, lower-cased: stylesheet, then inline, `!important` over either. */
function resolvedStyle(doc: Document, sheet: Sheet, frame: Element): Map<string, string> {
  const id = (getAttrCI(frame, "id") ?? "").toLowerCase();
  // The class attribute is charged to the page's budget by length, so padding it costs the page, not the scan.
  const classAttr = getAttrCI(frame, "class") ?? "";
  sheet.work -= Math.ceil(classAttr.length / CLASS_CHARS_PER_VISIT);
  const classes = new Set<string>();
  if (sheet.work > 0) {
    for (const c of classAttr.toLowerCase().split(/\s+/)) if (c) classes.add(c);
  } else sheet.truncated = true;
  let memo = memoCache.get(doc);
  if (!memo) {
    memo = new Map();
    memoCache.set(doc, memo);
  }
  const [normal, important] = sheetLayers(sheet, id, classes, memo) as [Declaration[], Declaration[]];
  const inline = parseDeclarations(getAttrCI(frame, "style") ?? "");
  const layers: Declaration[][] = [
    normal,
    inline.filter((d) => !d.important),
    important,
    inline.filter((d) => d.important),
  ];
  const out = new Map<string, string>();
  for (const layer of layers) {
    for (const d of layer) {
      if (d.property === "inset") for (const [side, value] of expandInset(d.value)) out.set(side, value);
      else out.set(d.property, d.value);
    }
  }
  return out;
}

const ZERO = /^0(?:px|%|em|rem|vh|vw)?$/;

export interface OverlayGeometry {
  fixed: boolean;
  zIndex: number;
  fillsViewport: boolean;
  pinned: boolean;
}

/** What the page's iframes can be selected by, read once per document. */
const wantedCache = new WeakMap<object, Wanted>();

function wantedFor(doc: Document): Wanted {
  const cached = wantedCache.get(doc);
  if (cached) return cached;
  const wanted: Wanted = { ids: new Set(), classes: new Set() };
  for (const frame of doc.querySelectorAll("iframe")) {
    const id = (getAttrCI(frame, "id") ?? "").toLowerCase();
    if (id) wanted.ids.add(id);
    for (const c of (getAttrCI(frame, "class") ?? "").toLowerCase().split(/\s+/)) if (c) wanted.classes.add(c);
  }
  wantedCache.set(doc, wanted);
  return wanted;
}

/** Whether an iframe, as the page styles it, is a fixed, high-z-index, viewport-filling cover. */
export function overlayGeometry(doc: Document, frame: Element): OverlayGeometry {
  const style = resolvedStyle(doc, sheetFor(doc, wantedFor(doc)), frame);
  const position = style.get("position");
  const zIndex = Number.parseInt(style.get("z-index") ?? "0", 10);
  const width = style.get("width") ?? "";
  const height = style.get("height") ?? "";
  const zero = (side: string): boolean => ZERO.test(style.get(side) ?? "");
  // `inset: 0` stretches an element over its containing block only when it has no size of its own.
  const autoSize = (value: string): boolean => value === "" || value === "auto";
  const stretched =
    zero("top") && zero("right") && zero("bottom") && zero("left") && autoSize(width) && autoSize(height);
  return {
    fixed: position === "fixed" || position === "absolute",
    zIndex: Number.isFinite(zIndex) ? zIndex : 0,
    fillsViewport:
      ((width.includes("100%") || width.includes("100vw")) && (height.includes("100%") || height.includes("100vh"))) ||
      stretched,
    pinned: zero("top") || zero("left"),
  };
}

/** Whether the page's CSS was longer than the amount read (the overlay rule may be in the part that was not). */
export function cssScanTruncated(doc: Document): boolean {
  return sheetFor(doc, wantedFor(doc)).truncated;
}

const hiddenCache = new WeakMap<object, { classes: Set<string>; ids: Set<string> }>();

const ZERO_SIZE = /^0(?:\.0+)?(?:px|em|rem|%|pt)?$/;

function declaresHidden(declarations: Declaration[]): boolean {
  return declarations.some(
    (d) =>
      (d.property === "display" && d.value === "none") ||
      (d.property === "visibility" && d.value === "hidden") ||
      (d.property === "font-size" && ZERO_SIZE.test(d.value)) ||
      (d.property === "opacity" && /^0(?:\.0+)?$/.test(d.value)),
  );
}

/**
 * The classes and ids a page's `<style>` blocks hide (`.x { display: none }`, zero font size, zero opacity),
 * for reading a label as a visitor sees it (#784). Simple `.class` and `#id` selectors only, over the same
 * one-pass scan and the same CSS bound as the overlay geometry.
 */
export function hiddenSelectors(doc: Document): { classes: Set<string>; ids: Set<string> } {
  const cached = hiddenCache.get(doc);
  if (cached) return cached;
  const classes = new Set<string>();
  const ids = new Set<string>();
  let chars = 0;
  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    const room = MAX_CSS_CHARS - chars;
    if (room <= 0) break;
    const css = text.length > room ? text.slice(0, room) : text;
    chars += css.length;
    scanCss(css, (selector, body) => {
      const parsed = parseSelectors(selector);
      if (parsed.length === 0) return;
      const declarations = parseDeclarations(body);
      if (!declaresHidden(declarations)) return;
      for (const sel of parsed) {
        if (sel.tag) continue;
        for (const c of sel.classes) classes.add(c);
        for (const i of sel.ids) ids.add(i);
      }
    });
  }
  const result = { classes, ids };
  hiddenCache.set(doc, result);
  return result;
}
