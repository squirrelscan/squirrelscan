// Geometry of an iframe as the page's own CSS gives it, for the fake-auth-overlay detector (#784).
//
// The injected overlay does not have to write its geometry inline: `position:fixed !important`, the
// `inset:0` shorthand, or a class defined in a `<style>` block all produce the same full-viewport cover.
// Only what is cheap and safe is resolved: inline `<style>` blocks; rules whose selector names the iframe by its tag,
// `.class`, `#id` or attributes (a combinator is read for its last compound only: the ancestors are not checked, which
// errs toward detection), including rules inside `@media`, `@supports`, `@layer`, `@container` and `@scope` blocks that
// apply to a screen and rules nested in a style rule; the cascade is `!important`, then specificity, then source order.
// Not modelled (documented limits): `@layer` precedence, `:not()`/`:is()` arguments, media query conditions other than a
// print-only or speech-only query, nested conditional group rules written with bare declarations.
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
/** Style rules nested in style rules are read this deep; a deeper one is not read and the CSS is reported truncated. */
const MAX_NESTING_DEPTH = 8;
/** Chars of an attribute value tested by an attribute selector (and kept in the memo key). */
const MAX_ATTR_CHARS = 512;

interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

/** One attribute selector (`[id]`, `[src*="x" i]`) of a compound. */
interface AttrCondition {
  name: string;
  op: "" | "=" | "~=" | "|=" | "^=" | "$=" | "*=";
  value: string;
  ci: boolean;
}

/**
 * One selector of a rule, parsed once: the subject compound (the last one of a complex selector): an optional `iframe` tag
 * and the `.class` / `#id` / attribute conditions that must all match, and its specificity.
 */
interface ParsedSelector {
  tag: boolean;
  classes: string[];
  ids: string[];
  /** The class and id names as written, for the decided reading (a browser compares them case-sensitively). */
  classesExact: string[];
  idsExact: string[];
  attrs: AttrCondition[];
  /** `ids * 10000 + (classes, attributes, pseudo-classes) * 100 + tag`, each part capped at 99. */
  specificity: number;
  /**
   * Whether the selector applies to the iframe cannot be decided here: it has an ancestor part (`main .c`, `html.x iframe`)
   * or a pseudo-class (`:hover`, `:not(.c)`), neither of which is evaluated.
   */
  unknown: boolean;
}

interface Rule {
  selectors: ParsedSelector[];
  declarations: Declaration[];
  /** Position in the stylesheet: later rules win. */
  order: number;
  /** The rule sits in an at-rule whose condition cannot be decided here (`@media (min-width: 1px)`, `@supports`, `@layer`...). */
  atUnknown: boolean;
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

/**
 * Lower-cases A-Z only, as a browser folds selectors, attribute values and keywords: JavaScript `toLowerCase` also folds the
 * Kelvin sign U+212A to `k`, so `[type="K"]` (Kelvin) would match a frame's `type=k` here and not in a browser. Linear.
 */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

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
    if (c === "(" && ident !== "" && asciiLower(unescapeCss(ident)) === "url" && !opensQuoted(text, i + 1)) {
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
    const property = asciiLower(decode(raw.slice(0, idx)).trim());
    let value = asciiLower(decode(raw.slice(idx + 1)).trim());
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

/** The simple selectors in a list; others (combinators, attributes, pseudo-classes) are not modelled. Used for the hidden-text scan, which must stay strict. */
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
      classes: tokens.filter((t) => t[0] === ".").map((t) => asciiLower(t.slice(1))),
      ids: tokens.filter((t) => t[0] === "#").map((t) => asciiLower(t.slice(1))),
      classesExact: [],
      idsExact: [],
      attrs: [],
      specificity: 0,
      unknown: false,
    });
  }
  return { selectors: out, oversized };
}


const isCombinator = (c: string): boolean => c === " " || c === "\n" || c === "\t" || c === ">" || c === "+" || c === "~";

/** Splits `text` at the commas outside brackets, parentheses and strings: a selector list, or a `:is(a, b)` is one part. Linear. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i = escapeEnd(text, i);
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The last compound of a complex selector: what the element itself must match (the combinators and ancestors are not read). */
function subjectCompound(selector: string): string {
  let depth = 0;
  let quote = "";
  let start = 0;
  let last = "";
  const close = (end: number): void => {
    if (end > start) last = selector.slice(start, end);
  };
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === "\\") {
      // a hex escape takes one optional space (`.\63 over`): it is not a descendant combinator
      i = escapeEnd(selector, i);
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (depth === 0 && isCombinator(c)) {
      close(i);
      start = i + 1;
    }
  }
  close(selector.length);
  return last;
}

/** The end of the identifier that starts at `at` (letters, digits, `-`, `_`, escapes and non-ASCII). */
function identEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") i = escapeEnd(text, i) + 1;
    else if (isIdentChar(c)) i++;
    else break;
  }
  return i;
}

/**
 * A selector lower-cased except what a browser compares case-sensitively: what sits inside `[...]` (an attribute value:
 * `[data-k=V]` does not match `data-k="v"`) and the name after a `.` or `#` (a class or an id: `.COVER` does not match
 * `class="cover"`). Their case is kept for the decided reading; the parser lower-cases them where the full reading and the
 * rule index need the folded form, and the attribute name and flag where they are read.
 */
function lowerSelector(selector: string): string {
  return keepOfKeywordCase(selector, foldSelector(selector));
}

/** An `of` keyword of `:nth-child()` written in another case keeps it, so the validity check can see it (Chrome only takes `of`). */
const OF_KEYWORD = /[ \t\n\r\f][oO][fF](?![A-Za-z0-9_\-\\]|[^\x00-\x7f])/g;
function keepOfKeywordCase(original: string, lowered: string): string {
  if (!/[OF]/.test(original)) return lowered;
  // the replaced keywords are collected and the string is rebuilt once: one slice per match was quadratic
  const chunks: string[] = [];
  let from = 0;
  for (const m of original.matchAll(OF_KEYWORD)) {
    if (m[0].slice(1) === "of") continue;
    chunks.push(lowered.slice(from, m.index + 1), m[0].slice(1));
    from = m.index + 3;
  }
  if (from === 0) return lowered;
  chunks.push(lowered.slice(from));
  return chunks.join("");
}

function foldSelector(selector: string): string {
  if (!/[[.#]/.test(selector)) return asciiLower(selector);
  const n = selector.length;
  let out = "";
  let from = 0;
  let i = 0;
  const keep = (start: number, end: number): void => {
    out += asciiLower(selector.slice(from, start)) + selector.slice(start, end);
    from = end;
  };
  while (i < n) {
    const c = selector[i]!;
    if (c === "\\") {
      i = escapeEnd(selector, i) + 1;
    } else if (c === "[") {
      let j = i + 1;
      let quote = "";
      while (j < n) {
        const d = selector[j]!;
        if (d === "\\") j += 2;
        else if (quote) {
          if (d === quote) quote = "";
          j++;
        } else if (d === '"' || d === "'") {
          quote = d;
          j++;
        } else if (d === "]") break;
        else j++;
      }
      j = Math.min(j, n);
      keep(i + 1, j);
      i = j;
    } else if (c === "." || c === "#") {
      let j = i + 1;
      while (j < n) {
        const d = selector[j]!;
        if (d === "\\") j = escapeEnd(selector, j) + 1;
        else if (isIdentChar(d)) j++;
        else break;
      }
      j = Math.min(j, n);
      keep(i + 1, j);
      i = j;
    } else i++;
  }
  return out + asciiLower(selector.slice(from));
}

/** Attributes whose values HTML compares without case in an attribute selector (the Selectors spec list). */
const CASE_INSENSITIVE_ATTRS: ReadonlySet<string> = new Set(
  "accept accept-charset align alink axis bgcolor charset checked clear codetype color compact declare defer dir direction disabled enctype face frame hreflang http-equiv lang language link media method multiple nohref noresize noshade nowrap readonly rel rev rules scope scrolling selected shape target text type valign valuetype vlink".split(" ")
);

/** What HTML splits a token list (`class`, `~=`) on: space, tab, LF, FF and CR, not JavaScript's `\s` (NBSP, U+2003, U+FEFF, VT). */
const HTML_SPACES = /[ \t\n\f\r]+/;

const ATTR_OPS = new Set(["=", "~=", "|=", "^=", "$=", "*="]);

/** `[name]`, `[name=value]`, `[name op "value" i]` from the text between the brackets, or undefined. */
function parseAttr(inner: string): AttrCondition | undefined {
  const nameEnd = identEnd(inner, 0);
  const name = asciiLower(unescapeCss(inner.slice(0, nameEnd)).trim());
  if (!name) return undefined;
  let i = nameEnd;
  while (inner[i] === " ") i++;
  if (i >= inner.length) return { name, op: "", value: "", ci: false };
  let op = inner[i]!;
  if (inner[i + 1] === "=") op += "=";
  if (!ATTR_OPS.has(op)) return undefined;
  i += op.length;
  while (inner[i] === " ") i++;
  let value: string;
  const q = inner[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < inner.length && inner[j] !== q) j += inner[j] === "\\" ? 2 : 1;
    value = inner.slice(i + 1, j);
    i = j + 1;
  } else {
    const end = identEnd(inner, i);
    value = inner.slice(i, end);
    i = end;
  }
  const flag = asciiLower(inner.slice(i).trim());
  // `s` is not read: a browser that does not support the flag drops the whole rule, so such a rule is not modelled.
  if (flag !== "" && flag !== "i") return undefined;
  return { name, op: op as AttrCondition["op"], value: unescapeCss(value), ci: flag === "i" };
}

const cap99 = (n: number): number => Math.min(n, 99);

/**
 * A compound selector (`iframe.c#id[src*="x"]:hover`) as conditions on the iframe, or undefined when it cannot match an
 * iframe (another tag, a pseudo-element, text it does not understand). A pseudo-class cannot be resolved here and is
 * taken as matching (it still counts in the specificity; `:where()` counts nothing): the error is toward detection.
 */
function parseCompound(text: string): ParsedSelector | undefined {
  const out: ParsedSelector = { tag: false, classes: [], ids: [], classesExact: [], idsExact: [], attrs: [], specificity: 0, unknown: false };
  let i = 0;
  let classLike = 0;
  // A namespace prefix: `*|` (any) is read away. `|` (no namespace) is accepted but Chrome does not apply it to an HTML element
  // (they are in the XHTML namespace), and a named one (`h|`) needs an `@namespace` rule this check does not follow: both are read
  // as of unknown applicability (a cover rule is never silent, a decoy never hides a cover).
  if (text[0] === "|") {
    out.unknown = true;
    i = 1;
  } else if (text[0] === "*" && text[1] === "|") i = 2;
  else {
    const end = text[0] === "*" ? 1 : identEnd(text, 0);
    if (end > 0 && text[end] === "|") {
      out.unknown = true;
      i = end + 1;
    }
  }
  if (i > 0 && i >= text.length) return undefined;
  if (text[i] === "*") i++;
  else if (text[i] !== "." && text[i] !== "#" && text[i] !== "[" && text[i] !== ":") {
    const end = identEnd(text, i);
    if (end === i || asciiLower(unescapeCss(text.slice(i, end))) !== "iframe") return undefined;
    out.tag = true;
    i = end;
  }
  while (i < text.length) {
    const c = text[i]!;
    if (c === "." || c === "#") {
      const end = identEnd(text, i + 1);
      if (end === i + 1) return undefined;
      const written = unescapeCss(text.slice(i + 1, end));
      const name = asciiLower(written);
      if (c === ".") {
        out.classes.push(name);
        out.classesExact.push(written);
        classLike++;
      } else {
        out.ids.push(name);
        out.idsExact.push(written);
      }
      i = end;
    } else if (c === "[") {
      let j = i + 1;
      let quote = "";
      for (; j < text.length; j++) {
        const d = text[j]!;
        if (d === "\\") j++;
        else if (quote) {
          if (d === quote) quote = "";
        } else if (d === '"' || d === "'") quote = d;
        else if (d === "]") break;
      }
      let inner = text.slice(i + 1, j);
      // an attribute namespace: `*|` and `|` are read away (HTML attributes have none, so `[*|id]` is `[id]`); a named one is unknown
      const lead = inner.length - inner.trimStart().length;
      inner = inner.slice(lead);
      if (inner[0] === "|" && inner[1] !== "=") inner = inner.slice(1);
      else if (inner[0] === "*" && inner[1] === "|" && inner[2] !== "=") inner = inner.slice(2);
      else {
        const nsEnd = identEnd(inner, 0);
        if (nsEnd > 0 && inner[nsEnd] === "|" && inner[nsEnd + 1] !== "=") {
          out.unknown = true;
          inner = inner.slice(nsEnd + 1);
        }
      }
      const attr = parseAttr(inner);
      if (!attr) return undefined;
      out.attrs.push(attr);
      classLike++;
      i = j + 1;
    } else if (c === ":") {
      if (text[i + 1] === ":") return undefined; // a pseudo-element is not the iframe
      const end = identEnd(text, i + 1);
      if (end === i + 1) return undefined;
      const name = asciiLower(unescapeCss(text.slice(i + 1, end)));
      i = end;
      if (text[i] === "(") {
        let depth = 0;
        let j = i;
        for (; j < text.length; j++) {
          if (text[j] === "\\") j++;
          else if (text[j] === "(") depth++;
          else if (text[j] === ")" && --depth === 0) break;
        }
        i = j + 1;
      }
      out.unknown = true; // a pseudo-class is a condition on the element's state or surroundings: not evaluated
      if (name !== "where") classLike++;
    } else return undefined;
  }
  out.specificity = cap99(out.ids.length) * 10_000 + cap99(classLike) * 100 + (out.tag ? 1 : 0);
  return out;
}

// Selector syntax, as far as a browser decides a rule's fate by it. A browser drops a style rule whose selector list has one
// invalid part (`.cover, !! {...}`), so the part that would have matched a cover never applies. But engines differ on what is
// valid (`:-moz-any-link`, `::-moz-selection`, `:target-current`, `::search-text`, `ns|name` after an `@namespace`), so a rule is
// dropped only on a certain, browser-independent syntax error: a stray character, an empty part, a doubled combinator, a bad
// identifier or attribute syntax. A part that may be valid in some engine (an unknown or engine-prefixed pseudo name, a named
// namespace, the `s` flag, an unterminated construct) keeps the rule, read as of unknown applicability: the full reading applies
// it (a lone signal), the decided one does not, so it can never hide a cover and never silently drops one. `:is()` and
// `:where()` are forgiving lists (an invalid argument there is ignored), so they are not read.

/** Pseudo-classes written without arguments (Chrome). `-webkit-` ones are all accepted: Chrome has several and the list moves. */
const PLAIN_PSEUDO_CLASSES: ReadonlySet<string> = new Set(
  "active any-link autofill checked current default defined disabled empty enabled first-child first-of-type focus focus-visible focus-within fullscreen future host hover in-range indeterminate interest-source interest-target invalid last-child last-of-type link modal only-child only-of-type open optional out-of-range past picture-in-picture placeholder-shown popover-open read-only read-write required root scope target user-invalid user-valid valid visited xr-overlay active-view-transition target-current target-before target-after horizontal vertical start end decrement increment double-button single-button no-button corner-present window-inactive".split(" "),
);
/** Pseudo-classes that take an argument in parentheses. */
const FUNCTIONAL_PSEUDO_CLASSES: ReadonlySet<string> = new Set(
  "active-view-transition-type dir has host host-context is lang not nth-child nth-last-child nth-last-of-type nth-of-type state where".split(" "),
);
/** Pseudo-elements, with or without arguments (`::part(x)`). */
const PSEUDO_ELEMENTS: ReadonlySet<string> = new Set(
  "after backdrop before checkmark column cue cue-region details-content file-selector-button first-letter first-line grammar-error highlight marker part picker picker-icon placeholder scroll-button scroll-marker scroll-marker-group search-text selection slotted spelling-error target-text view-transition view-transition-group view-transition-image-pair view-transition-new view-transition-old".split(" "),
);
/** Pseudo-elements a browser also accepts with one colon. */
const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set(["after", "before", "first-letter", "first-line"]);

/** Deepest `:not()` / `:has()` read: past it the arguments are not checked (they are taken as valid). */
const MAX_VALIDATE_DEPTH = 8;

const isCssSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** The end of a valid identifier at `at` (not starting with a digit, nor `-` and a digit), or -1. */
function validIdentEnd(text: string, at: number): number {
  let i = at;
  if (text[i] === "-") {
    i++;
    if (text[i] === "-") return identEnd(text, i + 1);
  }
  const c = text[i];
  if (c === undefined) return -1;
  if (c === "\\") {
    if (text[i + 1] === undefined || text[i + 1] === "\n") return -1;
  } else if (!/[A-Za-z_]/.test(c) && c < "\u0080") return -1;
  return identEnd(text, i);
}

/** The index of the `]` or `)` that closes the block opened just before `from`, past strings and escapes, or -1. */
function blockEnd(text: string, from: number, closer: string): number {
  let quote = "";
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") i++;
    else if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      if (depth === 0) return c === closer ? i : -1;
      depth--;
    }
  }
  return -1;
}

/** The text between the brackets of an attribute selector is `name`, `name op value` or `name op value flag`. */
function validAttribute(inner: string, d: Doubt): boolean {
  const n = inner.length;
  let i = 0;
  const skip = (): void => {
    while (i < n && isCssSpace(inner[i])) i++;
  };
  skip();
  if (inner[i] === "*" && inner[i + 1] === "|" && inner[i + 2] !== "=") i += 2;
  else if (inner[i] === "|" && inner[i + 1] !== "=") i++;
  const nameEnd = validIdentEnd(inner, i);
  if (nameEnd < 0) return false;
  i = nameEnd;
  // `ns|name` with a named namespace: valid after an `@namespace` rule, so the rule is kept as undecided.
  if (inner[i] === "|" && inner[i + 1] !== "=") {
    d.doubtful = true;
    return true;
  }
  skip();
  if (i >= n) return true;
  const op = inner[i] === "=" ? "=" : inner[i + 1] === "=" ? inner.slice(i, i + 2) : "";
  if (op !== "=" && !ATTR_OPS.has(op)) return false;
  i += op.length;
  skip();
  const q = inner[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n && inner[j] !== q) j += inner[j] === "\\" ? 2 : 1;
    // an unterminated string runs to the end of the sheet in some engines: doubtful, not a certain error
    if (j >= n) {
      d.doubtful = true;
      return true;
    }
    i = j + 1;
  } else {
    const end = validIdentEnd(inner, i);
    if (end < 0) return false;
    i = end;
    // an unquoted value is followed by white space before a flag
    if (i < n && !isCssSpace(inner[i])) return false;
  }
  skip();
  if (i >= n) return true;
  // `i` is read; `s` is a flag some engines support and some do not (doubtful); any other flag is invalid in every engine.
  if (inner[i] === "s" || inner[i] === "S") d.doubtful = true;
  else if (inner[i] !== "i" && inner[i] !== "I") return false;
  i++;
  skip();
  return i >= n;
}

/** Pseudo-elements after which a pseudo-class is never valid (`::before:hover`); the others take some (`::part(x):hover`, `::-webkit-scrollbar:horizontal`). */
const NO_PSEUDO_CLASS_AFTER: ReadonlySet<string> = new Set(["after", "backdrop", "before", "first-letter", "first-line", "marker", "placeholder"]);

/** Pseudo-classes Chrome accepts after a pseudo-element that otherwise takes none (checked in headless Chrome); any other is read as doubtful. */
const PSEUDO_CLASS_AFTER_ELEMENT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["part", new Set(["hover", "focus", "active", "focus-visible"])],
  ["file-selector-button", new Set(["hover", "focus", "active"])],
  ["selection", new Set(["window-inactive"])],
  ["scroll-marker", new Set(["target-current"])],
  ["view-transition-group", new Set(["only-child"])],
  ["view-transition-image-pair", new Set(["only-child"])],
  ["view-transition-old", new Set(["only-child"])],
  ["view-transition-new", new Set(["only-child"])],
]);

/** `trim()` also strips NBSP and other Unicode spaces, which CSS reads as identifier characters: only the CSS whitespace set goes. */
function trimCss(text: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && isCssSpace(text[a])) a++;
  while (b > a && isCssSpace(text[b - 1])) b--;
  return text.slice(a, b);
}

/** Can a pseudo-element follow another one? Chrome takes `::part(x)::before`, `::slotted(a)::before` and `::before::marker`, not the rest. */
function secondElementValid(previous: string, next: string): boolean {
  if (next === "part" || next === "slotted") return false;
  if (previous === "before" || previous === "after") return next === "marker";
  if (previous === "first-letter" || previous === "first-line" || previous === "marker" || previous === "placeholder" || previous === "backdrop") return false;
  if (previous === "slotted") return next !== "first-line" && next !== "first-letter";
  return true;
}

/** `::part(a b)` takes one or more identifiers, `::slotted(compound)` one compound selector. */
function pseudoElementArgsValid(name: string, args: string, depth: number, d: Doubt): boolean {
  const text = trimCss(args);
  if (text === "") return false;
  if (name === "part") {
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i < text.length && !isCssSpace(text[i])) continue;
      if (i > start && validIdentEnd(text.slice(start, i), 0) !== i - start) return false;
      start = i + 1;
    }
    return true;
  }
  if (splitTopLevel(text, ",").length > 1) return false;
  if (depth >= MAX_VALIDATE_DEPTH) return true;
  const inner = selectorListState(text, false, depth + 1, true);
  if (inner === "invalid") return false;
  if (inner === "doubtful") d.doubtful = true;
  return true;
}

const AN_PLUS_B = /^(?:even|odd|[+-]?\d+|[+-]?\d*n(?:[ \t\n\r\f]*[+-][ \t\n\r\f]*\d+)?)$/i;

/**
 * The arguments of the functional pseudo-classes whose grammar is fixed. `invalid`: every engine rejects them (`:nth-child(bogus)`,
 * `:nth-child()`, `:lang()`, `:dir()`). An escape or a nested `of` selector this cannot decide is `doubtful`. Linear.
 */
function pseudoArgsState(name: string, args: string, depth: number, d: Doubt): boolean {
  const text = trimCss(args);
  if (name === "nth-child" || name === "nth-last-child" || name === "nth-of-type" || name === "nth-last-of-type") {
    if (text.includes("\\")) {
      d.doubtful = true;
      return true;
    }
    let formula = text;
    let list: string | undefined;
    if (name.endsWith("child")) {
      // `of` after white space, ended by anything that cannot continue an identifier (`of.a`, `of:hover`, `of*` are valid)
      const of = /[ \t\n\r\f]of(?![A-Za-z0-9_\-\\]|[^\x00-\x7f])/i.exec(text);
      if (of) {
        formula = trimCss(text.slice(0, of.index));
        list = text.slice(of.index + of[0].length);
        // a browser reads the keyword without case; not every one does, so a capital is not a certain error
        if (!/^\sof$/.test(of[0])) d.doubtful = true;
      }
    }
    if (!AN_PLUS_B.test(formula)) return false;
    if (list !== undefined && depth < MAX_VALIDATE_DEPTH) {
      const inner = selectorListState(list, false, depth + 1, false);
      if (inner === "invalid") return false;
      if (inner === "doubtful") d.doubtful = true;
    }
    return true;
  }
  if (name === "lang") {
    // Only a single identifier is certainly valid (`en`, `en-US`, `\*-Latn`). A string, a wildcard or a comma list is accepted by
    // some engines and not by Chrome: doubtful. An empty part, a number or several words (`en fr`) is invalid everywhere.
    const parts = splitTopLevel(text, ",").map(trimCss);
    for (const part of parts) {
      if (part === "") return false;
      if (part[0] === '"' || part[0] === "'" || part[0] === "*") continue;
      if (validIdentEnd(part, 0) !== part.length) return false;
    }
    if (parts.length > 1 || parts[0]![0] === '"' || parts[0]![0] === "'" || parts[0]![0] === "*") {
      // a string or a wildcard is only doubtful when it is well formed enough to be one
      d.doubtful = true;
    }
    return true;
  }
  if (name === "dir") {
    if (text.includes("\\")) {
      d.doubtful = true;
      return true;
    }
    // Chrome accepts any identifier (`:dir(foo)` matches nothing), so only a non-identifier is a certain error
    if (validIdentEnd(text, 0) !== text.length) return false;
    const value = asciiLower(text);
    if (value !== "ltr" && value !== "rtl") d.doubtful = true;
    return true;
  }
  return true;
}

/** The end of the valid compound selector at `at`, or -1 when none starts there or it is invalid. */
function validCompound(text: string, at: number, depth: number, d: Doubt): number {
  const n = text.length;
  let i = at;
  // set once a pseudo-element (one this list knows, not an engine-prefixed one) has been read: its name, for what may follow it
  let element: string | undefined;
  d.element = false;
  const first = text[i];
  if (first === "*" || first === "|" || (first !== undefined && first !== "&" && validIdentEnd(text, i) >= 0)) {
    // a type selector, with an optional namespace prefix: only `*|` and `|` name a namespace that exists
    let p = i;
    let named = false;
    if (first === "|") {
      p++;
      named = true;
    } else {
      const end = first === "*" ? i + 1 : validIdentEnd(text, i);
      if (text[end] === "|" && text[end + 1] !== "=") {
        if (first !== "*") d.doubtful = true;
        p = end + 1;
        named = true;
      } else i = end;
    }
    if (named) {
      const end = text[p] === "*" ? p + 1 : validIdentEnd(text, p);
      if (end < 0) return -1;
      i = end;
    }
  }
  while (i < n) {
    const c = text[i]!;
    if (c === "." || c === "#") {
      // nothing but a pseudo-class may follow a pseudo-element (`::before.x`)
      if (element !== undefined) return -1;
      const end = validIdentEnd(text, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === "&") i++;
    else if (c === "[") {
      if (element !== undefined) return -1;
      const close = blockEnd(text, i + 1, "]");
      if (close < 0) {
        // unterminated: the sheet's end closes it in a browser, so it is not a certain error
        d.doubtful = true;
        return n;
      }
      if (!validAttribute(text.slice(i + 1, close), d)) return -1;
      i = close + 1;
    } else if (c === ":") {
      const isElement = text[i + 1] === ":";
      const start = i + (isElement ? 2 : 1);
      const nameEnd = validIdentEnd(text, start);
      if (nameEnd < 0) return -1;
      const name = asciiLower(unescapeCss(text.slice(start, nameEnd)));
      let after = nameEnd;
      let args: string | undefined;
      if (text[nameEnd] === "(") {
        const close = blockEnd(text, nameEnd + 1, ")");
        if (close < 0) {
          d.doubtful = true;
          return n;
        }
        args = text.slice(nameEnd + 1, close);
        after = close + 1;
      }
      if (isElement || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        if (d.forbidElement) return -1;
        if (element !== undefined && !secondElementValid(element, name)) return -1;
        if (isElement && (name === "part" || name === "slotted") && (args === undefined || !pseudoElementArgsValid(name, args, depth, d))) return -1;
        // a name this list does not know may be valid in some engine (`::-moz-selection`): doubtful
        if (!PSEUDO_ELEMENTS.has(name) && !name.startsWith("-webkit-")) d.doubtful = true;
        else if (PSEUDO_ELEMENTS.has(name)) element = name;
      } else if (
        element !== undefined &&
        NO_PSEUDO_CLASS_AFTER.has(element) &&
        name !== "is" &&
        name !== "where" &&
        // `:not(:is(.a))` after a pseudo-element is accepted by some browsers: doubtful, not an error
        !((name === "not" || name === "has") && args !== undefined && /:(?:is|where)\(/.test(args))
      ) {
        // `:is()` and `:where()` are accepted after a pseudo-element by some browsers: they are read like any pseudo-class
        return -1;
      } else if (!name.startsWith("-webkit-")) {
        // after a pseudo-element that takes some pseudo-classes, only a verified one is certainly valid
        if (element !== undefined && !NO_PSEUDO_CLASS_AFTER.has(element) && !PSEUDO_CLASS_AFTER_ELEMENT.get(element)?.has(name)) d.doubtful = true;
        if (element !== undefined && NO_PSEUDO_CLASS_AFTER.has(element) && (name === "not" || name === "has")) d.doubtful = true;
        if (args === undefined ? !PLAIN_PSEUDO_CLASSES.has(name) : !FUNCTIONAL_PSEUDO_CLASSES.has(name)) d.doubtful = true;
        // `:not()` and `:has()` are strict lists (`:is()` and `:where()` forgive an invalid argument, so they are not read).
        else if (args !== undefined && (name === "not" || name === "has") && depth < MAX_VALIDATE_DEPTH) {
          const inner = selectorListState(args, name === "has", depth + 1, true);
          if (inner === "invalid") return -1;
          if (inner === "doubtful") d.doubtful = true;
        } else if (args !== undefined && !pseudoArgsState(name, args, depth, d)) return -1;
      }
      i = after;
    } else break;
  }
  d.element = element !== undefined;
  return i > at ? i : -1;
}

/** One complex selector: compounds joined by descendant, `>`, `+` and `~` combinators (a leading one only in a relative selector). */
function validComplexSelector(text: string, relative: boolean, depth: number, d: Doubt): boolean {
  const n = text.length;
  let i = 0;
  const skip = (): void => {
    while (i < n && isCssSpace(text[i])) i++;
  };
  const combinator = (c: string | undefined): boolean => c === ">" || c === "+" || c === "~";
  skip();
  if (i >= n) return false;
  if (combinator(text[i])) {
    if (!relative) return false;
    i++;
    skip();
  }
  for (;;) {
    const end = validCompound(text, i, depth, d);
    if (end < 0) return false;
    i = end;
    const spaced = i;
    const afterElement = d.element === true;
    skip();
    if (i >= n) return true;
    // a pseudo-element ends the selector: `.x::before .y` and `.x::before > .y` are invalid
    if (afterElement) return false;
    if (combinator(text[i])) {
      i++;
      skip();
      if (i >= n || combinator(text[i])) return false;
    } else if (i === spaced) return false;
  }
}

/** Set when a part may be valid in some engine though this check does not know it. */
interface Doubt {
  doubtful: boolean;
  /** The last compound read ended in a pseudo-element, so no combinator may follow it. */
  element?: boolean;
  /** Reading the argument of `:not()`, `:has()` or an `of` list, where a pseudo-element is invalid. */
  forbidElement?: boolean;
}

/**
 * `invalid`: a part has a certain, browser-independent syntax error, so a browser drops the whole rule. `doubtful`: no certain
 * error, but a part may be valid in some engine (see the header above): the rule is kept as undecided. `valid` otherwise. A part
 * past the size bound is not read (the caller already reports it) and counts as valid. `relative`: a part may start with a
 * combinator (nested rules, `:has()`).
 */
export type SelectorListState = "valid" | "doubtful" | "invalid";

export function selectorListState(selector: string, relative: boolean, depth = 0, forbidElement = false): SelectorListState {
  const d: Doubt = { doubtful: false, forbidElement };
  for (const part of splitTopLevel(selector, ",")) {
    if (part.length > MAX_SELECTOR_CHARS + 64) continue;
    if (!validComplexSelector(part, relative, depth, d)) return "invalid";
  }
  return d.doubtful ? "doubtful" : "valid";
}

/** Starts a part of a nested selector whose ancestors were dropped: the part is read, as one whose applicability is unknown. */
const UNKNOWN_MARK = "\u0001";

/**
 * The selectors of a rule's list that can match an iframe, each as its subject compound (see {@link subjectCompound}), and
 * whether one part was past a bound (it is not read and could match any iframe).
 */
function parseFrameSelectorList(selector: string): { selectors: ParsedSelector[]; oversized: boolean } {
  const out: ParsedSelector[] = [];
  let oversized = false;
  for (const part of splitTopLevel(selector, ",")) {
    if (part.length > MAX_SELECTOR_CHARS + 64) {
      oversized = true;
      continue;
    }
    let raw = part.trim();
    // A selector produced by nesting carries a mark when its ancestors were dropped (see nestSelector).
    const marked = raw.startsWith(UNKNOWN_MARK);
    if (marked) raw = raw.slice(1);
    const subject = subjectCompound(raw);
    if (!subject) continue;
    const parsed = parseCompound(subject);
    if (!parsed) continue;
    // An ancestor part is a condition on the page that is not evaluated.
    if (marked || subject !== raw) parsed.unknown = true;
    out.push(parsed);
  }
  return { selectors: out, oversized };
}

/** Parts of a parent's or a child's selector list that are combined (the rest is not read and the CSS is reported truncated). */
const MAX_NEST_PARTS = 64;
/** Nested rules read per sheet, and selectors produced for them: past either the rest is not read and the CSS is reported truncated. */
const MAX_NESTED_RULES = 50_000;
const MAX_NESTED_SELECTORS = 20_000;

/** What nesting has used of a sheet's budget (also read by the tests, which assert the counts, not the clock). */
interface NestBudget {
  rules: number;
  selectors: number;
}

const countChar = (text: string, char: string): number => {
  let n = 0;
  for (let i = text.indexOf(char); i !== -1; i = text.indexOf(char, i + 1)) n++;
  return n;
};

/**
 * A nested rule's selector list in the context of its parent's. Only the last compound of a selector is ever read (see
 * {@link subjectCompound}), so a child without `&` in it is itself, whatever its parent was, and `&` is the parent's own
 * last compound, never its whole text: nothing is multiplied by the depth. What remains, a child with `&` against each parent
 * part, is bounded three ways: at most {@link MAX_NEST_PARTS} parts of each list, no produced part longer than
 * {@link MAX_SELECTOR_CHARS} (its length is worked out before it is built, so a run of `&` is not expanded), and a shared
 * budget of produced selectors. Whatever one of those drops makes `cut` true: the caller reports the CSS truncated.
 */
function nestSelector(parent: string, child: string, budget: NestBudget): { selector: string; cut: boolean; invalid?: boolean; doubtful?: boolean } {
  // A child list with a certainly invalid part is dropped whole, with the rules nested in it.
  const state = selectorListState(child, true);
  if (state === "invalid") return { selector: "", cut: false, invalid: true };
  const doubtful = state === "doubtful";
  if (budget.selectors <= 0) return { selector: "", cut: true };
  let cut = false;
  const parentParts = splitTopLevel(parent, ",");
  const childParts = splitTopLevel(child, ",");
  if (parentParts.length > MAX_NEST_PARTS || childParts.length > MAX_NEST_PARTS) cut = true;
  const parents: Array<{ subject: string; unknown: boolean }> = [];
  for (const part of parentParts.slice(0, MAX_NEST_PARTS)) {
    let text = part.trim();
    const marked = text.startsWith(UNKNOWN_MARK);
    if (marked) text = text.slice(1);
    const subject = subjectCompound(text);
    // The parent's own ancestors and pseudo-classes are dropped with it: what is built from it is of unknown applicability.
    if (subject) parents.push({ subject, unknown: marked || subject !== text || subject.includes(":") });
  }
  const out: string[] = [];
  const emit = (text: string): void => {
    if (budget.selectors <= 0) {
      cut = true;
      return;
    }
    budget.selectors--;
    out.push(text);
  };
  for (const part of childParts.slice(0, MAX_NEST_PARTS)) {
    // Once the sheet's selector budget is spent nothing more is produced: stop reading, not just stop emitting.
    if (budget.selectors <= 0) {
      cut = true;
      break;
    }
    if (part.length > MAX_SELECTOR_CHARS + 64) {
      cut = true;
      continue;
    }
    const text = part.trim();
    const subject = subjectCompound(text);
    if (!subject) continue;
    const amps = countChar(subject, "&");
    if (amps === 0) {
      // `child` inside `parent` is `parent child`: a descendant, so an ancestor condition that is not evaluated.
      emit(UNKNOWN_MARK + subject);
      continue;
    }
    for (const parent of parents) {
      if (budget.selectors <= 0) {
        cut = true;
        break;
      }
      if (subject.length + amps * Math.max(parent.subject.length - 1, 0) > MAX_SELECTOR_CHARS) {
        cut = true;
        continue;
      }
      emit((parent.unknown || subject !== text ? UNKNOWN_MARK : "") + subject.replaceAll("&", parent.subject));
    }
  }
  return { selector: out.join(","), cut, doubtful };
}

/** The index key (`.c`, `#i`, `iframe`, or `*` for attributes alone) of a selector when every token could match an iframe on the page. */
function ruleKey(selector: ParsedSelector, wanted: Wanted): string | undefined {
  if (!selector.classes.every((c) => wanted.classes.has(c))) return undefined;
  if (!selector.ids.every((i) => wanted.ids.has(i))) return undefined;
  const first = selector.classes[0] ? `.${selector.classes[0]}` : selector.ids[0] ? `#${selector.ids[0]}` : undefined;
  return first ?? (selector.tag ? "iframe" : "*");
}

/** Whether the body between `open` and `close` holds a block of its own (CSS nesting): an unread body could then hold a rule for an iframe. */
function hasNestedBlock(css: string, open: number, close: number): boolean {
  const at = css.indexOf("{", open + 1);
  return at !== -1 && at < close;
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
 * The declarations of a style rule's body with its nested blocks (and the selectors in front of them) taken out: the text
 * before the first nested block, and the text after it. Linear, one {@link walk}.
 */
function splitNestedDeclarations(body: string): { before: string; after: string } {
  const text = preprocess(body);
  let seen = false;
  let before = "";
  let current = "";
  let segment = 0;
  walk(
    text,
    0,
    [],
    (i, c, closers) => {
      if (c === ";" && closers.length === 0 && segment >= 0) {
        current += text.slice(segment, i + 1);
        segment = i + 1;
      } else if (c === "{" && closers.length === 1) {
        // a nested block starts: what is in front of it back to the last `;` is its selector, not a declaration
        if (!seen) {
          seen = true;
          before = current;
          current = "";
        }
        segment = -1;
      } else if (c === "}" && closers.length === 0 && segment < 0) {
        segment = i + 1;
      }
      return false;
    },
    () => {},
  );
  if (segment >= 0) current += text.slice(segment);
  return seen ? { before, after: current } : { before: current, after: "" };
}

/** At-rules whose block holds style rules that apply to the document (conditional group rules and `@layer`). */
const GROUP_AT_RULES = new Set(["media", "supports", "layer", "container", "scope"]);
/** Longest at-rule prelude whose conditions are read: a longer one is read as a condition that is not decided. */
const MAX_AT_PRELUDE = 2_048;

/**
 * What the block of the at-rule whose prelude is `prelude` (text from the `@` to the `{`) is for. `descend`: its rules are read.
 * A group rule is read unless it can never apply to a screen (a `@media` list whose every query is print-only, speech-only or
 * `not all`). `known`: its condition is decided, true for a screen: `@media all`, `@media screen`, or none. Every other
 * condition (`(max-width: 1px)`, `@supports`, `@container`, `@scope`, `@layer` precedence) is not evaluated, so its rules are
 * of unknown applicability (see {@link Rule.atUnknown}). A prelude past {@link MAX_AT_PRELUDE} is read for its name only
 * and is not decided either (its block is still read).
 */
function atRuleKind(prelude: string): { descend: boolean; known: boolean } {
  const head = prelude.length > 64 ? prelude.slice(0, 64) : prelude;
  const name = /^@([\w-]+)/.exec(asciiLower(head.includes("\\") ? unescapeCss(head) : head));
  if (!name || !GROUP_AT_RULES.has(name[1]!)) return { descend: false, known: false };
  if (name[1] !== "media") return { descend: true, known: false };
  if (prelude.length > MAX_AT_PRELUDE) return { descend: true, known: false };
  const text = asciiLower(prelude.includes("\\") ? unescapeCss(prelude) : prelude).slice(name[0].length);
  let descend = false;
  let known = false;
  for (const q of splitTopLevel(text, ",")) {
    const query = q.trim();
    if (/^(?:only\s+)?(?:print|speech)(?![\w-])/.test(query) || /^not\s+all(?![\w-])/.test(query)) continue;
    descend = true;
    if (query === "" || /^(?:only\s+)?(?:all|screen)$/.test(query)) known = true;
  }
  return { descend, known };
}

/**
 * One pass over a stylesheet: comments and at-rules are skipped (except, with `atRules`, the blocks of the group rules in
 * {@link atRuleKind}, whose rules are read as if written at the top level), every other `selector { body }` is
 * handed to `onRule`. `indexOf` only searches forward from
 * the cursor and the cursor then moves past what it found, so the scan is linear however the text is
 * built (unterminated comments, runs of openers, no braces at all).
 */
export function scanCss(
  css: string,
  onRule: (selector: string, body: string, unknown: boolean) => void,
  reading: Reading = "tokens",
  onOversized?: (selector: string, reason: "prelude" | "body", nested?: boolean) => void,
  atRules = false,
): void {
  if (reading === "tokens") return scanCssTokens(css, onRule, onOversized, atRules);
  let i = 0;
  const n = css.length;
  // The blocks of the group rules being read, each whether its condition is undecided; a `}` outside a rule closes the last.
  const open: boolean[] = [];
  let undecided = 0;
  while (i < n) {
    const ch = css[i]!;
    if (ch === "}" && open.length > 0 && open.pop()) undecided--;
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
      if (atRules) {
        // A group rule's block is read in place: its rules are the next ones, and its closing `}` is skipped like any other.
        let stop = i + 1;
        while (stop < n && stop - i <= MAX_PRELUDE_CHARS && css[stop] !== "{" && css[stop] !== ";") stop++;
        const kind = css[stop] === "{" ? atRuleKind(css.slice(i, stop)) : undefined;
        if (kind?.descend) {
          open.push(!kind.known);
          if (!kind.known) undecided++;
          i = stop + 1;
          continue;
        }
      }
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
    const brace = css.indexOf("{", i);
    if (brace === -1) return;
    // The `plain` and `naive` readings cut at the first `}` (the `tokens` reading has its own scan, see `scanCssTokens`);
    // a rule left open at the end of the text ends there, as a browser reads it.
    const found = css.indexOf("}", brace + 1);
    const close = found === -1 ? n : found;
    // A rule whose selector or body is past the bounds is not read, and the caller is told which selector, so a rule that could
    // be an overlay's is reported rather than skipped in silence; the rest of the sheet is still read.
    if (brace - i > MAX_PRELUDE_CHARS) onOversized?.("", "prelude");
    else if (close - brace - 1 > MAX_BODY_CHARS) onOversized?.(lowerSelector(css.slice(i, brace).trim()), "body", hasNestedBlock(css, brace, close));
    else onRule(lowerSelector(css.slice(i, brace).trim()), css.slice(brace + 1, close), undecided > 0);
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
  onRule: (selector: string, body: string, unknown: boolean) => void,
  onOversized?: (selector: string, reason: "prelude" | "body", nested?: boolean) => void,
  atRules = false,
): void {
  const css = preprocess(source);
  const n = css.length;
  let i = 0;
  // The blocks of the group rules being read, each whether its condition is undecided; a `}` outside a rule closes the last.
  const blocks: boolean[] = [];
  let undecided = 0;
  while (i < n) {
    const ch = css[i]!;
    if (ch === "}" && blocks.length > 0 && blocks.pop()) undecided--;
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
    // A group rule's block is read in place (no search for its end: the blocks nest, and the closing `}` is skipped below).
    if (atRules && ch === "@") {
      const kind = atRuleKind(selector);
      if (kind.descend) {
        blocks.push(!kind.known);
        if (!kind.known) undecided++;
        i = open + 1;
        continue;
      }
    }
    // A rule left open at the end of the text ends there, as a browser reads it.
    const ended = findRuleEnd(css, open);
    const close = ended === -1 ? n : ended;
    // A rule whose selector or body is past the bounds is not read, and the caller is told which selector (see the plain scan).
    if (ch !== "@") {
      if (open - i > MAX_PRELUDE_CHARS) onOversized?.("", "prelude");
      else if (close - open - 1 > MAX_BODY_CHARS) onOversized?.(lowerSelector(selector.trim()), "body", hasNestedBlock(css, open, close));
      else onRule(lowerSelector(selector.trim()), css.slice(open + 1, close), undecided > 0);
    }
    i = close + 1;
  }
}

interface Sheet {
  byKey: Map<string, Rule[]>;
  /** Attribute names any kept selector tests: the frame's values of them are part of its memo key. */
  attrNames: Set<string>;
  /** Nested rules read and selectors produced for them (see {@link nestSelector}). */
  nest: NestBudget;
  /** A rule of the sheet is of unknown applicability (an undecided at-rule, an ancestor part or a pseudo-class). */
  hasUnknown: boolean;
  /** Per-frame layers already worked out, by id and classes (pages repeat them). */
  memo: Map<string, Declaration[][]>;
  /** The stylesheet text was longer than {@link MAX_CSS_CHARS}: the rest was not read. */
  truncated: boolean;
  /** Rule visits left for frames (see {@link SHEET_WORK_BUDGET}). */
  work: number;
  /** The page has no doctype: a browser is in quirks mode and compares class and id names without case. */
  quirks: boolean;
}

const sheetCache = new WeakMap<object, Partial<Record<Reading, Sheet>>>();

function sheetFor(doc: Document, wanted: Wanted, reading: Reading): Sheet {
  const byReading = sheetCache.get(doc) ?? {};
  sheetCache.set(doc, byReading);
  const cached = byReading[reading];
  if (cached) return cached;
  const byKey = new Map<string, Rule[]>();
  const attrNames = new Set<string>();
  const nest: NestBudget = { rules: 0, selectors: MAX_NESTED_SELECTORS };
  const hasUnknown = { value: false };
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
    /** One rule of a sheet: its declarations, kept under the keys its selectors can be found by. */
    const keepRule = (selectors: ParsedSelector[], text: string, atUnknown: boolean): void => {
      if (text.trim() === "") return;
      const keys = new Set<string>();
      for (const parsed of selectors) {
        const key = ruleKey(parsed, wanted);
        if (key) keys.add(key);
      }
      if (keys.size === 0) return;
      const declarations = parseDeclarations(text, reading);
      if (!declarations.some((d) => GEOMETRY.test(d.property))) return;
      const rule: Rule = { selectors, declarations, order: position.next++, atUnknown };
      for (const parsed of selectors) {
        for (const attr of parsed.attrs) {
          attrNames.add(attr.name);
          // A value is compared case-sensitively in a browser but case-folded under `all`: the `decided` reading is needed too.
          if (attr.op !== "" && !attr.ci) hasUnknown.value = true;
        }
        // A class or id written with capitals reads differently under a browser's case-sensitive match: the decided reading too.
        if (parsed.classesExact.some((c) => c !== asciiLower(c)) || parsed.idsExact.some((i) => i !== asciiLower(i))) hasUnknown.value = true;
      }
      if (atUnknown || selectors.some((parsed) => parsed.unknown)) hasUnknown.value = true;
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
    };
    /**
     * One rule, and the rules nested in its body (CSS nesting: `main { .c { ... } }`), to a bounded depth. The declarations
     * before its first nested rule come first in the cascade, the nested rules next, the declarations after them last, as a
     * browser orders them; a nested block is never part of a declaration.
     */
    const addRule = (selector: string, body: string, depth: number, atUnknown: boolean): void => {
      // A browser drops the whole rule, and the rules nested in it, when a part of its list is invalid: done only for a certain
      // syntax error. A part that may be valid in some engine keeps the rule as undecided. (A nested rule's own list was checked
      // by nestSelector.)
      if (depth === 0) {
        const state = selectorListState(selector, false);
        if (state === "invalid") return;
        if (state === "doubtful") atUnknown = true;
      }
      const { selectors, oversized } = parseFrameSelectorList(selector);
      // a selector longer than the bound is not read and could match any iframe on the page
      if (oversized && wanted.frames > 0) cut.dropped = true;
      if (!body.includes("{")) {
        keepRule(selectors, body, atUnknown);
        return;
      }
      const parts = splitNestedDeclarations(body);
      keepRule(selectors, parts.before, atUnknown);
      if (depth >= MAX_NESTING_DEPTH) cut.dropped = true;
      else {
        scanCss(
          body,
          (inner, innerBody, innerUnknown) => {
            if (nest.rules >= MAX_NESTED_RULES) {
              cut.dropped = true;
              return;
            }
            nest.rules++;
            const nested = nestSelector(selector, inner, nest);
            if (nested.invalid) return;
            if (nested.cut) cut.dropped = true;
            addRule(nested.selector, innerBody, depth + 1, atUnknown || innerUnknown || nested.doubtful === true);
          },
          reading,
          undefined,
          true,
        );
      }
      keepRule(selectors, parts.after, atUnknown);
    };
    scanCss(css, (selector, body, unknown) => addRule(selector, body, 0, unknown), reading, (selector, reason, nested) => {
      // A rule past the bounds is not read: say so when it could be an overlay's. A selector list past the bound could match any
      // iframe; a body past it matters when one of its selectors matches an iframe on the page.
      if (reason === "prelude") {
        if (wanted.frames > 0) cut.dropped = true;
        return;
      }
      const { selectors, oversized } = parseFrameSelectorList(selector);
      // A body past the bound that holds nested rules is unread whatever its own selector is: a nested rule could be an iframe's.
      if ((nested && wanted.frames > 0) || (oversized && wanted.frames > 0) || selectors.some((parsed) => ruleKey(parsed, wanted))) cut.dropped = true;
    }, true);
  }
  const sheet: Sheet = { byKey, attrNames, nest, hasUnknown: hasUnknown.value, memo: new Map(), truncated: truncated || cut.dropped, work: SHEET_WORK_BUDGET, quirks: !doc.doctype };
  byReading[reading] = sheet;
  return sheet;
}

/** Whether an attribute selector holds for the frame's value of the attribute (`undefined`: the attribute is absent). */
function attrMatches(condition: AttrCondition, raw: string | undefined, foldAll: boolean): boolean {
  const fold = foldAll || CASE_INSENSITIVE_ATTRS.has(condition.name);
  if (raw === undefined) return false;
  if (condition.op === "") return true;
  // A browser compares a value case-sensitively unless the selector says `i`; the full cascade also reads it case-folded, so a
  // decoy that only matches once case is ignored can still hide a cover there but never counts as a decided match.
  const have = condition.ci || fold ? asciiLower(raw) : raw;
  const want = condition.ci || fold ? asciiLower(condition.value) : condition.value;
  switch (condition.op) {
    case "=":
      return have === want;
    case "~=":
      return want !== "" && !/[ \t\n\f\r]/.test(want) && have.split(HTML_SPACES).includes(want);
    case "|=":
      return have === want || have.startsWith(`${want}-`);
    case "^=":
      return want !== "" && have.startsWith(want);
    case "$=":
      return want !== "" && have.endsWith(want);
    case "*=":
      return want !== "" && have.includes(want);
  }
}

/**
 * The highest specificity among the selectors of the rule that match the frame, or -1 when none does. With `decided` only the
 * selectors whose applicability is known count: a rule in an undecided at-rule, and a selector with an ancestor part or a
 * pseudo-class, are left out (see {@link Mode}).
 */
function matchedSpecificity(rule: Rule, frame: FrameNames, attr: (name: string) => string | undefined, decided: boolean): number {
  if (decided && rule.atUnknown) return -1;
  let best = -1;
  for (const selector of rule.selectors) {
    if (selector.specificity <= best) continue;
    if (decided && selector.unknown) continue;
    if (
      // The decided reading compares a class and an id as a browser does: case-sensitively in standards mode, folded in quirks mode (no doctype); the full reading always folds case.
      (decided && !frame.quirks
        ? selector.classesExact.every((c) => frame.rawClasses.has(c)) && selector.idsExact.every((i) => i === frame.rawId)
        : selector.classes.every((c) => frame.classes.has(c)) && selector.ids.every((i) => i === frame.id)) &&
      selector.attrs.every((a) => attrMatches(a, attr(a.name), !decided))
    ) {
      best = selector.specificity;
    }
  }
  return best;
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

/**
 * Which rules of a sheet the cascade is worked out with. `all`: every rule, those of unknown applicability applied as if
 * they matched. `decided`: only the rules whose applicability is known. A cover is reported when EITHER says so: a rule
 * that cannot be evaluated can enable a cover (found under `all`) but must not be able to disable one (a decoy that never
 * matches in a browser: found under `decided`), whichever way a browser would decide it.
 */
type Mode = "all" | "decided";

/** An iframe's id and classes, folded for the rule index and the full reading and as written for the decided one. */
interface FrameNames {
  id: string;
  classes: Set<string>;
  rawId: string;
  rawClasses: Set<string>;
  /** Quirks mode: the decided reading compares class and id names folded too. */
  quirks: boolean;
}

/** The stylesheet's contribution to one iframe, memoised per (id, classes): pages repeat them. */
function sheetLayers(
  sheet: Sheet,
  frame: FrameNames,
  attr: (name: string) => string | undefined,
  memo: Map<string, Declaration[][]>,
  mode: Mode,
): Declaration[][] {
  // The frame's values of the attributes some selector tests are part of the key: two frames alike in all of it cascade alike.
  let attrKey = "";
  for (const name of sheet.attrNames) attrKey += `\u0000${name}=${attr(name) ?? "\u0001"}`;
  const { id, classes } = frame;
  // The decided reading also depends on the names' case as written.
  const exact = mode === "decided" ? `\u0000${frame.rawId}\u0000${[...frame.rawClasses].sort().join(" ")}` : "";
  const key = `${mode}\u0000${id}\u0000${[...classes].sort().join(" ")}${exact}${attrKey}`;
  const cached = memo.get(key);
  if (cached) return cached;
  // The frame's candidate rules: the lists of its tag, id and (at most a few) classes that have any, merged and
  // cut to the LAST rules by source order, so one frame costs a bounded amount however many classes it carries.
  const lists: Rule[][] = [];
  const own = sheet.byKey.get("iframe");
  if (own) lists.push(own);
  const universal = sheet.byKey.get("*");
  if (universal) lists.push(universal);
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
  // The cascade among the rules that match: specificity, then source order, the last one applied wins.
  const matched: Array<{ rule: Rule; specificity: number }> = [];
  for (const rule of candidates) {
    const specificity = matchedSpecificity(rule, frame, attr, mode === "decided");
    if (specificity >= 0) matched.push({ rule, specificity });
  }
  matched.sort((a, b) => a.specificity - b.specificity || a.rule.order - b.rule.order);
  const layers: Declaration[][] = [[], []]; // normal, !important
  for (const { rule } of matched) {
    for (const d of rule.declarations) layers[d.important ? 1 : 0]!.push(d);
  }
  memo.set(key, layers);
  return layers;
}

/** The iframe's resolved style properties, lower-cased: stylesheet, then inline, `!important` over either. */
function resolvedStyle(sheet: Sheet, frame: Element, reading: Reading, mode: Mode): Map<string, string> {
  const rawId = getAttrCI(frame, "id") ?? "";
  const id = asciiLower(rawId);
  // The class attribute is charged to the page's budget by length, so padding it costs the page, not the scan.
  const classAttr = getAttrCI(frame, "class") ?? "";
  sheet.work -= Math.ceil(classAttr.length / CLASS_CHARS_PER_VISIT);
  const classes = new Set<string>();
  const rawClasses = new Set<string>();
  if (sheet.work > 0) {
    for (const c of classAttr.split(HTML_SPACES)) {
      if (!c) continue;
      rawClasses.add(c);
      classes.add(asciiLower(c));
    }
  } else sheet.truncated = true;
  const attr = (name: string): string | undefined => {
    const value = getAttrCI(frame, name);
    return value === undefined || value === null ? undefined : value.slice(0, MAX_ATTR_CHARS);
  };
  const [normal, important] = sheetLayers(sheet, { id, classes, rawId, rawClasses, quirks: sheet.quirks }, attr, sheet.memo, mode) as [Declaration[], Declaration[]];
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
    const id = asciiLower(getAttrCI(frame, "id") ?? "");
    if (id) wanted.ids.add(id);
    for (const c of asciiLower(getAttrCI(frame, "class") ?? "").split(HTML_SPACES)) if (c) wanted.classes.add(c);
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
    const geometry = overlayGeometryFor(doc, frame, reading, "all");
    if (isCover(geometry)) return geometry;
    first ??= geometry;
    // A sheet with rules that cannot be evaluated is read again without them (see {@link Mode}).
    if (sheetFor(doc, wantedFor(doc), reading).hasUnknown) {
      const decided = overlayGeometryFor(doc, frame, reading, "decided");
      if (isCover(decided)) return decided;
    }
  }
  return first!;
}

/** The cascaded style of a frame under one reading (exported for the tests that compare readings with the old rules). */
export function styleUnder(doc: Document, frame: Element, reading: Reading, mode: Mode = "all"): Map<string, string> {
  return resolvedStyle(sheetFor(doc, wantedFor(doc), reading), frame, reading, mode);
}

/** The geometry under one reading (exported for the tests that compare readings). */
export function overlayGeometryFor(doc: Document, frame: Element, reading: Reading, mode: Mode = "all"): OverlayGeometry {
  const style = resolvedStyle(sheetFor(doc, wantedFor(doc), reading), frame, reading, mode);
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

/** What nesting used of the sheet's budget under one reading: nested rules read and selectors produced (for tests that assert the bounds). */
export function nestingUsed(doc: Document, reading: Reading = "tokens"): { rules: number; selectors: number } {
  const { rules, selectors } = sheetFor(doc, wantedFor(doc), reading).nest;
  return { rules, selectors: MAX_NESTED_SELECTORS - selectors };
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
