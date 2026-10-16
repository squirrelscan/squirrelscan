// shared/css-tokens - the pieces of a CSS tokenizer the rules share
//
// A regex over site-controlled CSS cannot be interrupted by the rule time budget,
// and the simple ones are wrong besides: `/@import\b/` counts an `@import` inside
// a comment or a string. These helpers step over the tokens a browser reads as
// one unit (strings, comments, unquoted `url(...)`, escapes, `(`/`[`/`{` blocks)
// in one linear pass, so callers can tell structure from text. Moved out of
// content/hidden-text.ts, which uses them for its declaration and rule scanners.

/**
 * Index just past a quoted string that starts at `start`. Used by every scanner
 * below so that punctuation inside a quoted value or a `data:` URL cannot be
 * mistaken for structure.
 */
export function skipString(css: string, start: number): number {
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
export function skipComment(css: string, start: number): number {
  const end = css.indexOf("*/", start + 2);
  return end === -1 ? css.length : end + 2;
}

/**
 * `css` with its comments removed, as a browser's tokenizer drops them: no
 * space is left behind, so `.a`, a comment, then `.b` reads `.a.b` (pub#684). Quoted strings
 * and escapes are copied through untouched, so a `/*` inside a string is text.
 */
export function stripComments(css: string): string {
  if (!css.includes("/*")) return css;
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "\\") {
      out += css.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      // A comment still separates tokens: `.a/**` + `/b` is `.a` then `b`,
      // never the class `.ab`. Joining two name characters would merge them,
      // so a space keeps them apart (a selector that then reads as complex is
      // the safe reading).
      if (isNameChar(out[out.length - 1]) && isNameChar(css[i])) out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** A character that continues a CSS name: `myurl(` is not `url(`. */
export function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && (/[-_a-zA-Z0-9\\]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

const CSS_WHITESPACE = new Set(["\t", "\n", "\f", "\r", " "]);

/**
 * Whether a `url(` at `start` begins its own token. After a name character, a
 * `#` or `@` (hash and at-keyword tokens), an escaped space, or the space that
 * ends a hex escape, `url` is the tail of another token: `myurl(`, `#url(`,
 * `@url(`, `a\ url(` and `a\20 url(` are a function or a `(` block, not a url
 * token.
 */
function urlTokenCanStart(css: string, start: number): boolean {
  const prev = css[start - 1];
  if (prev === undefined) return true;
  if (prev === "#" || prev === "@" || isNameChar(prev)) return false;
  // Any escaped character (`a\!url(`, `a\ url(`) is part of a name. A newline
  // cannot be escaped.
  const newline = prev === "\n" || prev === "\r" || prev === "\f";
  if (!newline && escapeIntroducerEndsAt(css, start - 2)) return false;
  if (!CSS_WHITESPACE.has(prev)) return true;
  // The whitespace may end a hex escape (`\20 url(`, `\20` + newline): look
  // back over at most six hex digits. A browser reads CRLF as one newline.
  let k = prev === "\n" && css[start - 2] === "\r" ? start - 3 : start - 2;
  let hex = 0;
  while (k >= 0 && hex < 6 && /[0-9a-fA-F]/.test(css[k])) {
    k--;
    hex++;
  }
  return hex === 0 || !escapeIntroducerEndsAt(css, k);
}

/**
 * Whether the backslash run ending at `end` closes on an escape introducer: an
 * odd run does, an even one is escaped backslashes. Each run sits before one
 * character, so the callers' lookbacks never rescan it.
 */
function escapeIntroducerEndsAt(css: string, end: number): boolean {
  let slashes = 0;
  for (let k = end; k >= 0 && css[k] === "\\"; k--) slashes++;
  return slashes % 2 === 1;
}

/**
 * Index just past an unquoted `url(…)` starting at `start`, or -1 when none
 * starts there. A browser reads it as one token up to `)`, so the `{`, `}` and
 * `;` inside (`url(}.b{x)`) are never structure (pub#679). `url("…")` is an
 * ordinary function holding a string, and returns -1.
 */
export function skipUnquotedUrl(css: string, start: number): number {
  // `| 0x20` lower-cases an ASCII letter without allocating.
  if (
    (css.charCodeAt(start) | 0x20) !== 0x75 ||
    (css.charCodeAt(start + 1) | 0x20) !== 0x72 ||
    (css.charCodeAt(start + 2) | 0x20) !== 0x6c ||
    css[start + 3] !== "("
  ) {
    return -1;
  }
  if (!urlTokenCanStart(css, start)) return -1;
  let i = start + 4;
  while (i < css.length && CSS_WHITESPACE.has(css[i])) i++;
  if (css[i] === '"' || css[i] === "'") return -1;
  while (i < css.length) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === ")") return i + 1;
    i++;
  }
  return css.length;
}

/**
 * Tracks the `(`, `[` and `{` blocks a browser opens inside a stretch of CSS.
 * Only the closer a block expects ends it; any other closer is plain text, so
 * `(}` keeps the `}` inside the parentheses (pub#679). Returns the index to
 * continue at, after the character (or unquoted `url(…)` token) at `i`.
 * Callers skip escapes, strings and comments first.
 */
export function stepBlocks(css: string, i: number, closers: string[]): number {
  const ch = css[i];
  if (ch === "u" || ch === "U") {
    const end = skipUnquotedUrl(css, i);
    if (end !== -1) return end;
  }
  if (ch === "(") closers.push(")");
  else if (ch === "[") closers.push("]");
  else if (ch === "{") closers.push("}");
  else if (ch === closers[closers.length - 1]) closers.pop();
  return i + 1;
}
