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
/**
 * A rule is read up to these sizes: each selector of a list 2,048 characters, the whole selector list and the body 256 KB, which no
 * real overlay rule comes near and padding cannot cheaply pass. Past them the rule is not read, and the CSS is reported truncated
 * (`cssTruncated`) when it could be an overlay's: a selector longer than the bound, or a list longer than it, could match any
 * iframe on the page and is reported whenever the page has one; a body past the bound is reported when its selector could match
 * (#1423). A rule is never skipped in silence while it could matter.
 */
const MAX_SELECTOR_CHARS = 2_048;
const MAX_PRELUDE_CHARS = 262_144;
const MAX_BODY_CHARS = 262_144;

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

/**
 * Three readings of the same CSS text, and a frame is a cover when ANY of them says so (the union, #1496). `tokens`
 * follows CSS Syntax 3 (strings, comments, `url()` and blocks are units); `naive` drops complete comments, splits on every
 * `;` and reads an unterminated comment or string as ordinary text (it keeps reading); `plain` is the old split on `;` and
 * nothing else. A page can hide an overlay from whichever one a parser differs from a browser on, so no single reading
 * is trusted to see it; the cost of the union is a few more reads of a frame that already carries auth intent.
 */
export type Reading = "tokens" | "naive" | "plain";
const READINGS: readonly Reading[] = ["tokens", "naive", "plain"];

const isIdentChar = (c: string): boolean => /[\w-]/.test(c) || c >= "\u0080";

/** CSS preprocessing: a CRLF, a lone CR and a form feed are each one newline (a string ends at one). */
function preprocess(text: string): string {
  return /[\r\f]/.test(text) ? text.replace(/\r\n?|\f/g, "\n") : text;
}

/** The index of the last character of the escape that starts with the backslash at `at`: 1-6 hex digits and one optional space, or one character. */
function escapeEnd(text: string, at: number): number {
  const n = text.length;
  let j = at + 1;
  if (j >= n) return n - 1;
  if (/[0-9a-f]/i.test(text[j]!)) {
    let digits = 1;
    while (digits < 6 && j + 1 < n && /[0-9a-f]/i.test(text[j + 1]!)) {
      j++;
      digits++;
    }
    if (j + 1 < n && /[ \t\n]/.test(text[j + 1]!)) j++;
  }
  return j;
}

/**
 * One forward pass over CSS the way CSS Syntax 3 tokenises it, calling `onChar` for each structural character outside a
 * string, comment and unquoted `url(...)`, AFTER the stack of expected closers was updated (`(` waits for `)`, `[` for `]`,
 * `{` for `}`; a closer pops only when it matches the top, any other closer is an ordinary token, a block left open ends at
 * EOF). `onComment(from, to)` is told of each comment (an unterminated one runs to the end). A backslash escapes (a hex
 * escape takes up to six digits and a space); a string ends at its quote or an unescaped newline; `url(` is recognised on the
 * identifier with its escapes decoded (`u\72 l(`, `URL(`) and, unquoted, is one token to its `)`. Linear: every index is
 * visited once and `indexOf` only moves forward.
 */
function walk(
  text: string,
  start: number,
  closers: string[],
  onChar: (index: number, char: string, closers: string[]) => boolean,
  onComment: (from: number, to: number) => void,
): void {
  const n = text.length;
  let quote = "";
  let identStart = -1;
  for (let i = start; i < n; i++) {
    const c = text[i]!;
    if (c === "\\") {
      // Outside a string a backslash before a newline is not an escape (a stray `\` token); inside one it continues the string.
      if (!quote && text[i + 1] === "\n") {
        identStart = -1;
        continue;
      }
      if (!quote && identStart < 0) identStart = i;
      i = escapeEnd(text, i);
      continue;
    }
    if (quote) {
      if (c === quote || c === "\n") quote = "";
      continue;
    }
    if (isIdentChar(c)) {
      if (identStart < 0) identStart = i;
      continue;
    }
    const ident = identStart >= 0 ? text.slice(identStart, i) : "";
    identStart = -1;
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" && ident !== "" && unescapeCss(ident).toLowerCase() === "url" && !opensQuoted(text, i + 1)) {
      let j = i + 1;
      for (; j < n && text[j] !== ")"; j++) if (text[j] === "\\") j = escapeEnd(text, j);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      onComment(i, close === -1 ? n : close + 2);
      if (close === -1) return;
      i = close + 1;
      continue;
    }
    if (c === "(") closers.push(")");
    else if (c === "[") closers.push("]");
    else if (c === "{") closers.push("}");
    else if ((c === ")" || c === "]" || c === "}") && closers.at(-1) === c) closers.pop();
    if (onChar(i, c, closers)) return;
  }
}

/**
 * The declarations of a style declaration list (a `style` attribute, or a rule body cut out of its braces) as CSS Syntax 3
 * consumes them: a declaration runs to the next `;` outside every block and string, a comment is dropped, and a block
 * left open runs to the end. See {@link walk}.
 */
export function splitDeclarations(input: string): string[] {
  const text = preprocess(input);
  const out: string[] = [];
  let start = 0;
  let current = "";
  walk(
    text,
    0,
    [],
    (i, c, closers) => {
      if (c === ";" && closers.length === 0) {
        out.push(current + text.slice(start, i));
        current = "";
        start = i + 1;
      }
      return false;
    },
    (from, to) => {
      current += `${text.slice(start, from)} `;
      start = to;
    },
  );
  out.push(current + text.slice(start));
  return out;
}

/** Complete comments dropped; an unterminated `/*` is just its two characters removed, the rest is read on. */
function stripCommentsTolerant(text: string): string {
  if (!text.includes("/*")) return text;
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("/*", at);
    if (open === -1) return out + text.slice(at);
    const close = text.indexOf("*/", open + 2);
    if (close === -1) return `${out}${text.slice(at, open)} ${text.slice(open + 2)}`;
    out += `${text.slice(at, open)} `;
    at = close + 2;
  }
}

/** Whether the first thing after `url(` (past whitespace) is a quote, which makes it an ordinary function. */
function opensQuoted(text: string, from: number): boolean {
  let j = from;
  while (j < text.length && /[ \t\n]/.test(text[j]!)) j++;
  return text[j] === '"' || text[j] === "'";
}

/** CSS escapes undone: `\30 0` is `00`, `\76` is `v`, `\w` is `w`. Linear, one regex pass. */
function unescapeCss(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\n]))/gi, (_m, hex?: string, char?: string) => {
    if (char !== undefined) return char;
    const code = Number.parseInt(hex!, 16);
    return code === 0 || code > 0x10_ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
  });
}

function parseDeclarations(text: string, reading: Reading = "tokens"): Declaration[] {
  const out: Declaration[] = [];
  const raws = reading === "tokens" ? splitDeclarations(text) : reading === "naive" ? stripCommentsTolerant(text).split(";") : text.split(";");
  const decode = reading === "plain" ? (t: string): string => t : unescapeCss;
  for (const raw of raws) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const property = decode(raw.slice(0, idx)).trim().toLowerCase();
    let value = decode(raw.slice(idx + 1)).trim().toLowerCase();
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
  /** Iframes on the page: with none, no rule can be an overlay's. */
  frames: number;
}

const SIMPLE_SELECTOR = /^(iframe)?((?:[.#][\w-]+)*)$/;

/** The simple selectors in a list; others (combinators, attributes, pseudo-classes) are not modelled. */
function parseSelectors(selector: string): ParsedSelector[] {
  return parseSelectorList(selector).selectors;
}

/** The simple selectors of a list, and whether one of its parts is longer than {@link MAX_SELECTOR_CHARS} (it is not read: it could match anything). */
function parseSelectorList(selector: string): { selectors: ParsedSelector[]; oversized: boolean } {
  const out: ParsedSelector[] = [];
  let oversized = false;
  for (const part of selector.split(",")) {
    if (part.length > MAX_SELECTOR_CHARS + 64) {
      oversized = true;
      continue;
    }
    const match = SIMPLE_SELECTOR.exec(part.trim());
    if (!match || (match[1] === undefined && match[2] === "")) continue;
    const tokens = match[2]!.match(/[.#][\w-]+/g) ?? [];
    out.push({
      tag: match[1] !== undefined,
      classes: tokens.filter((t) => t[0] === ".").map((t) => t.slice(1)),
      ids: tokens.filter((t) => t[0] === "#").map((t) => t.slice(1)),
    });
  }
  return { selectors: out, oversized };
}

/** The index key (`iframe`, `.c`, `#i`) of a selector when every token could match an iframe on the page. */
function ruleKey(selector: ParsedSelector, wanted: Wanted): string | undefined {
  if (!selector.classes.every((c) => wanted.classes.has(c))) return undefined;
  if (!selector.ids.every((i) => wanted.ids.has(i))) return undefined;
  const first = selector.classes[0] ? `.${selector.classes[0]}` : selector.ids[0] ? `#${selector.ids[0]}` : undefined;
  return first ?? "iframe";
}

/** The `}` that closes the rule whose `{` is at `open`, or -1 (see {@link walk}). */
function findRuleEnd(css: string, open: number): number {
  let end = -1;
  walk(
    css,
    open + 1,
    ["}"],
    (i, c, closers) => {
      if (c === "}" && closers.length === 0) {
        end = i;
        return true;
      }
      return false;
    },
    () => {},
  );
  return end;
}

/**
 * One pass over a stylesheet: comments and at-rules (`@media`, `@supports`, `@keyframes`, `@import`) are
 * skipped, every other `selector { body }` is handed to `onRule`. `indexOf` only searches forward from
 * the cursor and the cursor then moves past what it found, so the scan is linear however the text is
 * built (unterminated comments, runs of openers, no braces at all).
 */
export function scanCss(
  css: string,
  onRule: (selector: string, body: string) => void,
  reading: Reading = "tokens",
  onOversized?: (selector: string, reason: "prelude" | "body") => void,
): void {
  if (reading === "tokens") return scanCssTokens(css, onRule, onOversized);
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
    // The `plain` and `naive` readings cut at the first `}` (the `tokens` reading has its own scan, see `scanCssTokens`).
    const close = css.indexOf("}", open + 1);
    if (close === -1) return;
    // A rule whose selector or body is past the bounds is not read, and the caller is told which selector, so a rule that could
    // be an overlay's is reported rather than skipped in silence; the rest of the sheet is still read.
    if (open - i > MAX_PRELUDE_CHARS) onOversized?.("", "prelude");
    else if (close - open - 1 > MAX_BODY_CHARS) onOversized?.(css.slice(i, open).trim().toLowerCase(), "body");
    else onRule(css.slice(i, open).trim().toLowerCase(), css.slice(open + 1, close));
    i = close + 1;
  }
}

/**
 * The `tokens` reading of a stylesheet: every prelude (a rule's selector or an at-rule's) runs to the `{` that opens its block,
 * a `;` outside every block, or the end, past strings, comments, escapes and brackets (`@import "a;b";`, `@import url(a;b);`,
 * `@media print{.x{content:"{"}}`, `[a="{"]`); a block ends at its own `}`. At-rules and anything but a plain selector are
 * skipped whole, so only a rule's own body is handed on. See {@link walk}.
 */
function scanCssTokens(
  source: string,
  onRule: (selector: string, body: string) => void,
  onOversized?: (selector: string, reason: "prelude" | "body") => void,
): void {
  const css = preprocess(source);
  const n = css.length;
  let i = 0;
  while (i < n) {
    const ch = css[i]!;
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "}" || ch === ";") {
      i++;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    let open = -1;
    let stop = -1;
    let selector = "";
    let from = i;
    walk(
      css,
      i,
      [],
      (j, c, closers) => {
        if (c === "{" && closers.length === 1) {
          open = j;
          return true;
        }
        if (c === ";" && closers.length === 0) {
          stop = j;
          return true;
        }
        return false;
      },
      (commentFrom, commentTo) => {
        selector += `${css.slice(from, commentFrom)} `;
        from = commentTo;
      },
    );
    if (open === -1) {
      if (stop === -1) return;
      i = stop + 1;
      continue;
    }
    selector += css.slice(from, open);
    const close = findRuleEnd(css, open);
    if (close === -1) return;
    // A rule whose selector or body is past the bounds is not read, and the caller is told which selector (see the plain scan).
    if (ch !== "@") {
      if (open - i > MAX_PRELUDE_CHARS) onOversized?.("", "prelude");
      else if (close - open - 1 > MAX_BODY_CHARS) onOversized?.(selector.trim().toLowerCase(), "body");
      else onRule(selector.trim().toLowerCase(), css.slice(open + 1, close));
    }
    i = close + 1;
  }
}

interface Sheet {
  byKey: Map<string, Rule[]>;
  /** Per-frame layers already worked out, by id and classes (pages repeat them). */
  memo: Map<string, Declaration[][]>;
  /** The stylesheet text was longer than {@link MAX_CSS_CHARS}: the rest was not read. */
  truncated: boolean;
  /** Rule visits left for frames (see {@link SHEET_WORK_BUDGET}). */
  work: number;
}

const sheetCache = new WeakMap<object, Partial<Record<Reading, Sheet>>>();

function sheetFor(doc: Document, wanted: Wanted, reading: Reading): Sheet {
  const byReading = sheetCache.get(doc) ?? {};
  sheetCache.set(doc, byReading);
  const cached = byReading[reading];
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
      const { selectors, oversized } = parseSelectorList(selector);
      // a selector longer than the bound is not read and could match any iframe on the page
      if (oversized && wanted.frames > 0) cut.dropped = true;
      const keys = new Set<string>();
      for (const parsed of selectors) {
        const key = ruleKey(parsed, wanted);
        if (key) keys.add(key);
      }
      if (keys.size === 0) return;
      const declarations = parseDeclarations(body, reading);
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
    }, reading, (selector, reason) => {
      // A rule past the bounds is not read: say so when it could be an overlay's. A selector list past the bound could match any
      // iframe; a body past it matters when one of its selectors matches an iframe on the page.
      if (reason === "prelude") {
        if (wanted.frames > 0) cut.dropped = true;
        return;
      }
      const { selectors, oversized } = parseSelectorList(selector);
      if ((oversized && wanted.frames > 0) || selectors.some((parsed) => ruleKey(parsed, wanted))) cut.dropped = true;
    });
  }
  const sheet: Sheet = { byKey, memo: new Map(), truncated: truncated || cut.dropped, work: SHEET_WORK_BUDGET };
  byReading[reading] = sheet;
  return sheet;
}

function ruleMatches(rule: Rule, id: string, classes: Set<string>): boolean {
  return rule.selectors.some(
    (selector) => selector.classes.every((c) => classes.has(c)) && selector.ids.every((i) => i === id),
  );
}

/** Logical offsets in a horizontal left-to-right page (the injected overlays are never vertical or right-to-left). */
const LOGICAL_SIDES: Readonly<Record<string, string>> = {
  "inset-block-start": "top",
  "inset-block-end": "bottom",
  "inset-inline-start": "left",
  "inset-inline-end": "right",
};

/** `inset-block` / `inset-inline`: one value for both sides or two values, start then end. */
function expandPair(value: string, first: string, second: string): Array<[string, string]> {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return [];
  return [
    [first, parts[0]!],
    [second, parts[1] ?? parts[0]!],
  ];
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

/** The iframe's resolved style properties, lower-cased: stylesheet, then inline, `!important` over either. */
function resolvedStyle(sheet: Sheet, frame: Element, reading: Reading): Map<string, string> {
  const id = (getAttrCI(frame, "id") ?? "").toLowerCase();
  // The class attribute is charged to the page's budget by length, so padding it costs the page, not the scan.
  const classAttr = getAttrCI(frame, "class") ?? "";
  sheet.work -= Math.ceil(classAttr.length / CLASS_CHARS_PER_VISIT);
  const classes = new Set<string>();
  if (sheet.work > 0) {
    for (const c of classAttr.toLowerCase().split(/\s+/)) if (c) classes.add(c);
  } else sheet.truncated = true;
  const [normal, important] = sheetLayers(sheet, id, classes, sheet.memo) as [Declaration[], Declaration[]];
  const inline = parseDeclarations(getAttrCI(frame, "style") ?? "", reading);
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
      else if (d.property === "inset-block") for (const [side, value] of expandPair(d.value, "top", "bottom")) out.set(side, value);
      else if (d.property === "inset-inline") for (const [side, value] of expandPair(d.value, "left", "right")) out.set(side, value);
      else out.set(LOGICAL_SIDES[d.property] ?? d.property, d.value);
    }
  }
  return out;
}

const ZERO = /^0(?:px|%|em|rem|vh|vw)?$/;

/**
 * Whether a `width` or `height` value fills its axis (#1496), read as CSS spells it and leaning toward "fills" when it
 * cannot tell. Units of the axis: `%`, the viewport units (`vw`/`vh` and their dynamic, small and large forms `dvw`, `svh`,
 * `lvh`, ...), the logical `vi`/`vb` forms, the container units (`cqw`, `cqh`, `cqi`, `cqb`, `cqmin`, `cqmax`) and
 * `vmin`/`vmax`. A number of 100 or more fills (an over-full 150% or 10000vw does too), any spelling of it (`100.0`,
 * `+100`, `1e2`); inside `calc()`, `min()`, `max()` or `clamp()` the numbers of the axis are added, so `calc(50vw + 50vw)`
 * fills and `calc(100% - 0px)` does (a subtraction of a fixed length is not taken off). The keywords
 * `stretch`, `fill-available` and their prefixed forms fill. Not it: `10vw`, `100px`, `0.100vw`, `50%`, `-100vw`, and
 * a length held in a custom property (`var(--w)`), which is not resolved: a documented limit.
 */
const AXIS_UNITS = {
  width: "%|[dsl]?vw|[dsl]?vi|cqw|cqi|vmax|vmin|cqmin|cqmax",
  height: "%|[dsl]?vh|[dsl]?vb|cqh|cqb|vmax|vmin|cqmin|cqmax",
} as const;
const AXIS_TOKEN = {
  width: new RegExp(`(?<![\\d.])([+-]?)(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|\\.\\d+(?:e[+-]?\\d+)?)(?:${AXIS_UNITS.width})`, "gi"),
  height: new RegExp(`(?<![\\d.])([+-]?)(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|\\.\\d+(?:e[+-]?\\d+)?)(?:${AXIS_UNITS.height})`, "gi"),
};
const FILL_KEYWORD = /(?:^|[\s(,])(?:-webkit-|-moz-)?(?:stretch|fill-available|available)(?:$|[\s),])/i;
/** Work cap of the tokeniser: a longer (whitespace-collapsed) value is padding, not a length, and counts as filling. */
const MAX_LENGTH_SCAN = 2_048;
const MAX_RAW_LENGTH = 100_000;

function fillsAxis(raw: string, axis: "width" | "height"): boolean {
  if (raw === "") return false;
  // The cap bounds the work, never the verdict: a value padded past it is treated as filling (fail toward detection).
  if (raw.length > MAX_RAW_LENGTH) return true;
  // parseDeclarations has already dropped comments and undone escapes.
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (value.length > MAX_LENGTH_SCAN) return true;
  if (FILL_KEYWORD.test(value)) return true;
  // Inside a calc() a minus sign may subtract or flip a sign, so every magnitude counts there; alone a negative length is off-screen.
  const arithmetic = value.includes("calc(") || value.includes("*") || value.includes("/");
  let sum = 0;
  let any = false;
  for (const match of value.matchAll(AXIS_TOKEN[axis])) {
    const amount = Number(match[2]);
    if (match[1] === "-" && !arithmetic) continue;
    any = true;
    if (amount >= 100) return true;
    sum += amount;
  }
  // `calc(1vw * 100)`: a product or quotient of an axis length is not worked out; it counts as filling.
  if (any && (value.includes("*") || value.includes("/"))) return true;
  return sum >= 100;
}

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
  const wanted: Wanted = { ids: new Set(), classes: new Set(), frames: 0 };
  for (const frame of doc.querySelectorAll("iframe")) {
    wanted.frames++;
    const id = (getAttrCI(frame, "id") ?? "").toLowerCase();
    if (id) wanted.ids.add(id);
    for (const c of (getAttrCI(frame, "class") ?? "").toLowerCase().split(/\s+/)) if (c) wanted.classes.add(c);
  }
  wantedCache.set(doc, wanted);
  return wanted;
}

/** Whether a geometry is a fixed, high-z-index, viewport-filling cover pinned to a corner (what the detector requires). */
export const isCover = (g: OverlayGeometry): boolean => g.fixed && g.zIndex >= 1000 && g.fillsViewport && g.pinned;

/**
 * An iframe's geometry as the page styles it: the first of the three {@link Reading}s that makes it a cover, else the
 * `tokens` one. The union means nothing a plain split of the CSS caught is lost to a stricter parse, and nothing a stricter
 * parse reads is lost to a plain split.
 */
export function overlayGeometry(doc: Document, frame: Element): OverlayGeometry {
  let first: OverlayGeometry | undefined;
  for (const reading of READINGS) {
    const geometry = overlayGeometryFor(doc, frame, reading);
    if (isCover(geometry)) return geometry;
    first ??= geometry;
  }
  return first!;
}

/** The cascaded style of a frame under one reading (exported for the tests that compare readings with the old rules). */
export function styleUnder(doc: Document, frame: Element, reading: Reading): Map<string, string> {
  return resolvedStyle(sheetFor(doc, wantedFor(doc), reading), frame, reading);
}

/** The geometry under one reading (exported for the tests that compare readings). */
export function overlayGeometryFor(doc: Document, frame: Element, reading: Reading): OverlayGeometry {
  const style = resolvedStyle(sheetFor(doc, wantedFor(doc), reading), frame, reading);
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
    fillsViewport: (fillsAxis(width, "width") && fillsAxis(height, "height")) || stretched,
    pinned: zero("top") || zero("left"),
  };
}

/** Whether the page's CSS was longer than the amount read (the overlay rule may be in the part that was not). */
export function cssScanTruncated(doc: Document): boolean {
  // The `tokens` sheet always; the others only if a frame needed them (they are built on demand).
  const tokens = sheetFor(doc, wantedFor(doc), "tokens");
  return tokens.truncated || Object.values(sheetCache.get(doc) ?? {}).some((sheet) => sheet.truncated);
}

const hiddenCache = new WeakMap<object, { classes: Set<string>; ids: Set<string>; truncated: boolean }>();

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
export function hiddenSelectors(doc: Document): { classes: Set<string>; ids: Set<string>; truncated: boolean } {
  const cached = hiddenCache.get(doc);
  if (cached) return cached;
  const classes = new Set<string>();
  const ids = new Set<string>();
  // A rule past the size bounds, or CSS past the amount read, may hide a class or id this scan then reads as visible text.
  let truncated = false;
  let chars = 0;
  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    const room = MAX_CSS_CHARS - chars;
    if (room <= 0) {
      truncated = true;
      break;
    }
    if (text.length > room) truncated = true;
    const css = text.length > room ? text.slice(0, room) : text;
    chars += css.length;
    scanCss(css, (selector, body) => {
      const { selectors: parsed, oversized } = parseSelectorList(selector);
      if (oversized) truncated = true;
      if (parsed.length === 0) return;
      const declarations = parseDeclarations(body);
      if (!declaresHidden(declarations)) return;
      for (const sel of parsed) {
        if (sel.tag) continue;
        for (const c of sel.classes) classes.add(c);
        for (const i of sel.ids) ids.add(i);
      }
    }, "tokens", (selector, reason) => {
      // an unread rule: a selector list past the bound could name any class, a body past it matters when its selector is a class or id
      if (reason === "prelude" || parseSelectorList(selector).oversized || parseSelectors(selector).some((sel) => !sel.tag)) truncated = true;
    });
  }
  const result = { classes, ids, truncated };
  hiddenCache.set(doc, result);
  return result;
}
