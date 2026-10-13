// shared/css-imports - the `@import` rules a browser would actually fetch
//
// `/@import\b/g` over a `<style>` element's text counts an `@import` inside a
// comment (`/* @import url(a.css); */`), a string (`content: "@import"`) or a
// URL (`url(/x@import.png)`), none of which loads anything (#725). CSS Syntax
// reads comments, strings and `url(...)` as single tokens, so this scanner does
// too, in one linear pass.
//
// A browser also ignores an `@import` that is not at the top level, or that comes
// after any rule other than `@charset` and, before the first import, `@layer`
// statements (CSS Cascade, "Importing style sheets"), and never fetches it. Only
// the imports that load are returned. Any other rule ends the scan, even one a
// browser would drop as invalid (`@foo {}`): that can only undercount, the safe
// side for a rule that warns.

import { isNameChar, skipComment, skipString, skipUnquotedUrl, stepBlocks } from "./css-tokens";

export interface CssImport {
  /** The imported URL as written (unresolved). */
  url: string;
  /** What follows the URL up to the `;`: media queries, `layer(...)`, `supports(...)`. */
  media: string;
}

const CSS_SPACE = /[\t\n\f\r ]/;

/** Index of the next character that is not whitespace or a comment. */
function skipSpaceAndComments(css: string, start: number, end: number): number {
  let i = start;
  while (i < end) {
    if (CSS_SPACE.test(css[i])) i++;
    else if (css[i] === "/" && css[i + 1] === "*") i = skipComment(css, i);
    else break;
  }
  return i;
}

/**
 * Where the statement starting at `start` ends: just past its `;`, or just past
 * the block it opens, or the end of input. `block` says which ended it. Strings,
 * comments, escapes and unquoted `url(...)` are stepped over, so a `;` or `{`
 * inside them is text.
 */
function statementEnd(css: string, start: number): { end: number; block: boolean } {
  let i = start;
  const closers: string[] = [];
  while (i < css.length) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (closers.length === 0) {
      if (ch === ";") return { end: i + 1, block: false };
      if (ch === "{") {
        // Consume the whole block, nested blocks included.
        const blockClosers = ["}"];
        let j = i + 1;
        while (j < css.length && blockClosers.length > 0) {
          const c = css[j];
          if (c === "\\") j += 2;
          else if (c === "/" && css[j + 1] === "*") j = skipComment(css, j);
          else if (c === '"' || c === "'") j = skipString(css, j);
          else j = stepBlocks(css, j, blockClosers);
        }
        return { end: j, block: true };
      }
    }
    i = stepBlocks(css, i, closers);
  }
  return { end: css.length, block: false };
}

/** The at-keyword name at `start` (just past the `@`), lowercased. */
function atKeywordName(css: string, start: number): { name: string; end: number } {
  let i = start;
  while (i < css.length && isNameChar(css[i]) && css[i] !== "\\") i++;
  return { name: css.slice(start, i).toLowerCase(), end: i };
}

/** The text of a quoted string token starting at `start`, without its quotes. */
function stringValue(css: string, start: number, end: number): string {
  const close = Math.min(skipString(css, start), end);
  const inner = css.slice(start + 1, css[close - 1] === css[start] ? close - 1 : close);
  return inner.replace(/\\(.)/g, "$1");
}

/**
 * The URL and the trailing conditions of an `@import` prelude (`css[start, end)`),
 * or null when it names no URL: a browser drops that rule and fetches nothing.
 */
function parseImport(css: string, start: number, end: number): CssImport | null {
  let i = skipSpaceAndComments(css, start, end);
  let url: string | null = null;
  if (css[i] === '"' || css[i] === "'") {
    url = stringValue(css, i, end);
    i = Math.min(skipString(css, i), end);
  } else if (/^url\(/i.test(css.slice(i, i + 4))) {
    const unquoted = skipUnquotedUrl(css, i);
    if (unquoted !== -1) {
      // An unterminated `url(` runs to the end of input with no `)` to drop.
      const stop = Math.min(unquoted, end);
      url = css.slice(i + 4, css[stop - 1] === ")" ? stop - 1 : stop).trim();
      i = stop;
    } else {
      // url("...") is a function holding a string.
      const q = skipSpaceAndComments(css, i + 4, end);
      if (css[q] === '"' || css[q] === "'") {
        url = stringValue(css, q, end);
        const after = skipSpaceAndComments(css, Math.min(skipString(css, q), end), end);
        i = css[after] === ")" ? after + 1 : after;
      }
    }
  }
  const tail = css.slice(i, end).replace(/;\s*$/, "");
  // Comments between the URL and the media list are whitespace.
  let media = "";
  for (let k = 0; k < tail.length; ) {
    if (tail[k] === "/" && tail[k + 1] === "*") {
      k = skipComment(tail, k);
      media += " ";
    } else {
      media += tail[k];
      k++;
    }
  }
  // A string broken by a newline is a bad token, and the rule is dropped.
  if (!url || /[\n\r\f]/.test(url)) return null;
  return { url, media: media.replace(/\s+/g, " ").trim() };
}

/**
 * Every `@import` in a style sheet's text that a browser would fetch, in order:
 * top-level statements that come before any rule other than `@charset` and, before
 * the first import, `@layer` statements. Linear in the length of `css`.
 */
export function findCssImports(css: string): CssImport[] {
  const imports: CssImport[] = [];
  let seenImport = false;
  let i = 0;
  while (i < css.length) {
    i = skipSpaceAndComments(css, i, css.length);
    if (i >= css.length) break;
    // `<!--` and `-->` are ignored at the top level of a style sheet.
    if (css.startsWith("<!--", i)) {
      i += 4;
      continue;
    }
    if (css.startsWith("-->", i)) {
      i += 3;
      continue;
    }
    // Any other rule ends the import prelude: later `@import`s are never fetched.
    if (css[i] !== "@") break;
    const { name, end: nameEnd } = atKeywordName(css, i + 1);
    if (name !== "import" && name !== "charset" && name !== "layer") break;
    // A `@layer` statement after an import is a rule like any other.
    if (name === "layer" && seenImport) break;
    const statement = statementEnd(css, nameEnd);
    // An at-rule with a block is another rule (`@layer a { ... }`).
    if (statement.block) break;
    if (name === "import") {
      seenImport = true;
      const parsed = parseImport(css, nameEnd, statement.end);
      if (parsed) imports.push(parsed);
    }
    i = statement.end;
  }
  return imports;
}
