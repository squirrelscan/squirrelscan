// shared/comment-scan - string-aware comment counting for the minification heuristics
//
// #142: `js.match(/\/\/[^\n]*/g)` has no notion of string context, so every
// `"https://..."` in a bundle scored as a line comment running to the end of the
// line. In a minified bundle "the end of the line" is most of the file, so a
// handful of URLs produced both a bogus "27 comments" reason and a
// potentialSavingsBytes figure close to the whole bundle size. Counting comments
// needs an actual scanner, not a regex.

export interface CommentScan {
  /** `//` comments found outside strings, templates, regex literals and comments. */
  lineComments: number;
  /** Terminated block comments found outside strings and templates. */
  blockComments: number;
  /** Bytes spanned by every counted comment, delimiters included. */
  commentBytes: number;
}

// A `/` after one of these keywords opens a regex literal rather than dividing.
const REGEX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function isIdentPart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

// Non-ASCII ECMAScript WhiteSpace and LineTerminator code points: NBSP, OGHAM
// SPACE MARK, EN QUAD through HAIR SPACE, LINE and PARAGRAPH SEPARATOR, NARROW
// NO-BREAK SPACE, MEDIUM MATHEMATICAL SPACE, IDEOGRAPHIC SPACE and the BOM.
// Anything omitted reads as a significant token, which would wrongly separate a
// keyword from the `(` after it.
const NON_ASCII_SPACES = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

function isWhitespace(ch: string): boolean {
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
    return true;
  }
  const code = ch.charCodeAt(0);
  return code > 0x7f && NON_ASCII_SPACES.has(code);
}

function isSchemeChar(ch: string): boolean {
  return isIdentPart(ch) || ch === "+" || ch === "-" || ch === ".";
}

/**
 * A URL authority starts right after `//`. Testing for a host character rather
 * than for "not whitespace" avoids depending on an ASCII-only whitespace test,
 * so `http://<NBSP>text` is still read as a comment.
 */
function isUrlHostStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "-" ||
    ch === "_" ||
    ch === "[" ||
    ch === "%"
  );
}

// Only these make the `x://` guard fire, so a JS label really named `foo` still
// gets its `foo:// comment` counted.
const URL_SCHEMES = new Set(["blob", "data", "file", "ftp", "http", "https", "ws", "wss"]);

/** True when `colon` closes a URL scheme, i.e. the `//` after it is part of a URL. */
function endsUrlScheme(src: string, colon: number): boolean {
  let start = colon - 1;
  while (start >= 0 && isSchemeChar(src[start] as string)) start--;
  if (start === colon - 1) return false;
  return URL_SCHEMES.has(src.slice(start + 1, colon).toLowerCase());
}

// A `)` closing one of these heads is followed by a statement, so a `/` there
// opens a regex (`if(ok)/re/.test(s)`). After any other `)` the `/` divides.
const CONTROL_FLOW_HEADS = new Set(["catch", "for", "if", "while", "with"]);
// Caps the memory the open-paren stack can be made to hold. Far beyond any real
// nesting depth, so reaching it means the input is not ordinary JavaScript.
const PAREN_STACK_LIMIT = 4096;

/**
 * The last two identifier tokens seen in code context. Keeping this as the
 * scanner walks forward is what lets a comment or any flavour of whitespace sit
 * between a keyword and what follows it: the scanner has already stepped over
 * both, so nothing ever re-reads raw source behind the cursor.
 */
interface IdentState {
  /** Bounds of the most recent identifier token, or -1 when there is none. */
  start: number;
  end: number;
  /** The token is a property name (`obj.if`), so it is never a keyword. */
  isProperty: boolean;
  /** The same, for the identifier before it. */
  prevStart: number;
  prevEnd: number;
  prevIsProperty: boolean;
  /** Only whitespace and comments separated those two identifiers. */
  prevAdjacent: boolean;
}

function newIdentState(): IdentState {
  return {
    start: -1,
    end: -1,
    isProperty: false,
    prevStart: -1,
    prevEnd: -1,
    prevIsProperty: false,
    prevAdjacent: false,
  };
}

/** The keyword immediately before the cursor, or "" when there is not one. */
function precedingKeyword(src: string, lastCode: number, ident: IdentState): string {
  if (ident.isProperty || ident.end < 0 || lastCode + 1 !== ident.end) return "";
  return src.slice(ident.start, ident.end);
}

/** True when the `(` about to be pushed opens an `if`/`while`/`for`/`for await` head. */
function opensControlFlowHead(src: string, lastCode: number, ident: IdentState): boolean {
  const word = precedingKeyword(src, lastCode, ident);
  if (CONTROL_FLOW_HEADS.has(word)) return true;
  // `for await (` puts the head keyword one token further back. Plain `await (`
  // is grouping, so only a preceding `for` promotes it.
  if (word !== "await" || !ident.prevAdjacent || ident.prevIsProperty) return false;
  return src.slice(ident.prevStart, ident.prevEnd) === "for";
}

/**
 * @param controlFlowClose index of the most recent `)` that closed a control
 * flow head, or -1. Matched forward by the scanner, so parens inside strings,
 * comments and regex literals never enter the count.
 */
function regexCanStartAfter(
  src: string,
  lastCode: number,
  controlFlowClose: number,
  ident: IdentState,
): boolean {
  if (lastCode < 0) return true;
  const ch = src[lastCode] as string;
  if (ch === '"' || ch === "'" || ch === "`" || ch === "]") return false;
  // `/` here is the closing delimiter of a regex literal with no flags, or a
  // division sign; either way the operand is complete, so this `/` divides.
  if (ch === "/") return false;
  // `x++ / n` and `x-- / n` divide. A single `+` or `-` is a sign, not a suffix.
  if ((ch === "+" || ch === "-") && src[lastCode - 1] === ch) return false;
  if (ch === ")") return lastCode === controlFlowClose;
  // A property name is never a keyword, so `obj.return /re/` divides.
  if (isIdentPart(ch)) return REGEX_KEYWORDS.has(precedingKeyword(src, lastCode, ident));
  // `}` closes a block far more often than it closes an object literal being
  // divided, so a `/` after it is read as a regex at statement position. When
  // that guess is wrong, skipRegex refuses to close a regex on a comment
  // opener, so the comment behind it is still counted.
  return true;
}

/** Index just past the closing quote, or at the line terminator that ended it. */
function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === "\\") {
      // A backslash before CRLF is a single line continuation. Stepping over
      // only two characters would land on the `\n` and end the string early.
      i += src[i + 1] === "\r" && src[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (ch === quote) return i + 1;
    // An unterminated string must not swallow the rest of the file, and an
    // unescaped line terminator ends a quoted string anyway.
    if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") return i;
    i++;
  }
  return src.length;
}

/** Index just past the closing `/`, or -1 when this `/` did not open a regex. */
function skipRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return -1; // regex literals cannot span lines
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      // A regex whose closing delimiter is immediately followed by `/` or `*`
      // would be a regex being divided or multiplied, which is never real code.
      // `i++ / n // real` is division followed by a comment, so refusing here
      // keeps the comment countable instead of swallowing it as a regex body.
      const after = src[i + 1];
      if (after === "/" || after === "*") return -1;
      return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Count JavaScript comments while tracking string, template literal and regex
 * context, so `//` and block-comment openers inside literals are not counted.
 */
export function scanJsComments(src: string): CommentScan {
  const scan: CommentScan = { lineComments: 0, blockComments: 0, commentBytes: 0 };

  // Frames record the mode to return to; template interpolations (`${ ... }`)
  // put us back into code, so brace depth has to be tracked per frame.
  const frames: Array<{ mode: "code" | "template"; braceDepth: number }> = [];
  let mode: "code" | "template" = "code";
  let braceDepth = 0;
  // Last non-whitespace character consumed in code context. Comments are
  // transparent, so they never update it.
  let lastCode = -1;
  // A failed regex probe scans to end of line. Without remembering the failure,
  // a line such as `x=/\/\/\/...` re-probes at every slash and the scan goes
  // quadratic on a multi-MB bundle. If nothing could close a regex opened at i,
  // treat the rest of that line as division rather than probing again.
  let noRegexBefore = -1;
  // Open `(` positions, pushed only in code context, and the index of the most
  // recent `)` that closed a control flow head. Matching parens forward keeps
  // this O(1) per paren; walking backwards from each `)` was quadratic. Script
  // bodies come from crawled pages, so the stack is capped: 5MB of `(` grew RSS
  // by 131MB unbounded. Past the cap only the depth is tracked, which can lose
  // one control flow head far past any real nesting.
  // Each entry says whether that `(` opened a control flow head, decided from
  // token state at push time rather than by re-reading the source behind it.
  const parens: boolean[] = [];
  let parenOverflow = 0;
  let controlFlowClose = -1;
  const ident = newIdentState();
  let i = 0;

  while (i < src.length) {
    const ch = src[i] as string;

    if (mode === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        const frame = frames.pop();
        mode = frame?.mode ?? "code";
        braceDepth = frame?.braceDepth ?? 0;
        lastCode = i;
        i++;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        frames.push({ mode: "template", braceDepth });
        mode = "code";
        braceDepth = 0;
        lastCode = i + 1;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "/") {
      const next = src[i + 1];
      if (next === "/") {
        // Backstop for a URL that reached code context anyway, e.g. inside a
        // regex this scanner read as division. A real comment never abuts the
        // colon of a URL scheme, and a URL always has a host right after the
        // slashes, so `http:// text` stays a comment on a label named `http`.
        if (
          i > 0 &&
          src[i - 1] === ":" &&
          isUrlHostStart(src[i + 2]) &&
          endsUrlScheme(src, i - 1)
        ) {
          lastCode = i + 1;
          i += 2;
          continue;
        }
        let end = i + 2;
        while (end < src.length && src[end] !== "\n") end++;
        scan.lineComments++;
        scan.commentBytes += end - i;
        i = end;
        continue;
      }
      if (next === "*") {
        const close = src.indexOf("*/", i + 2);
        if (close === -1) {
          // Unterminated: the old regex did not match it either, so it is not
          // counted, but the rest of the file is still comment text.
          break;
        }
        scan.blockComments++;
        scan.commentBytes += close + 2 - i;
        i = close + 2;
        continue;
      }
      if (i >= noRegexBefore && regexCanStartAfter(src, lastCode, controlFlowClose, ident)) {
        const end = skipRegex(src, i);
        if (end !== -1) {
          lastCode = end - 1;
          i = end;
          continue;
        }
        const lineEnd = src.indexOf("\n", i);
        noRegexBefore = lineEnd === -1 ? src.length : lineEnd;
      }
      lastCode = i;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = skipQuoted(src, i, ch);
      lastCode = end - 1;
      i = end;
      continue;
    }

    if (ch === "`") {
      frames.push({ mode: "code", braceDepth });
      mode = "template";
      i++;
      continue;
    }

    if (ch === "(") {
      const head = opensControlFlowHead(src, lastCode, ident);
      if (parens.length < PAREN_STACK_LIMIT) parens.push(head);
      else parenOverflow++;
      lastCode = i;
      i++;
      continue;
    }

    if (ch === ")") {
      if (parenOverflow > 0) {
        parenOverflow--;
      } else if (parens.pop() === true) {
        controlFlowClose = i;
      }
      lastCode = i;
      i++;
      continue;
    }

    if (ch === "{") {
      braceDepth++;
      lastCode = i;
      i++;
      continue;
    }

    if (ch === "}") {
      const frame = frames[frames.length - 1];
      if (braceDepth === 0 && frame?.mode === "template") {
        frames.pop();
        mode = "template";
        braceDepth = frame.braceDepth;
        i++;
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      lastCode = i;
      i++;
      continue;
    }

    if (isIdentPart(ch)) {
      // `ident.end !== i` means this character opens a new identifier token
      // rather than continuing the one already being consumed.
      if (ident.end !== i) {
        ident.prevStart = ident.start;
        ident.prevEnd = ident.end;
        ident.prevIsProperty = ident.isProperty;
        ident.prevAdjacent = ident.end >= 0 && lastCode + 1 === ident.end;
        ident.start = i;
        // `.` makes it a member name. `#` makes it a private name, which only
        // ever appears as `this.#x`, `#x in o` or a `#x = 1` field. Neither
        // form can be a keyword, and testing `#` on its own also covers
        // `this. #x`, where a space sits between the dot and the hash.
        const prev = lastCode >= 0 ? src[lastCode] : "";
        ident.isProperty = prev === "." || prev === "#";
      }
      lastCode = i;
      ident.end = i + 1;
    } else if (!isWhitespace(ch)) {
      lastCode = i;
    }
    i++;
  }

  return scan;
}

/**
 * Count CSS block comments while skipping quoted strings, so a `/*` inside
 * `content: "..."` or a data URI is not read as a comment opener (#142).
 */
export function scanCssComments(src: string): CommentScan {
  const scan: CommentScan = { lineComments: 0, blockComments: 0, commentBytes: 0 };
  let i = 0;

  while (i < src.length) {
    const ch = src[i] as string;

    if (ch === '"' || ch === "'") {
      i = skipQuoted(src, i, ch);
      continue;
    }

    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) break;
      scan.blockComments++;
      scan.commentBytes += close + 2 - i;
      i = close + 2;
      continue;
    }

    i++;
  }

  return scan;
}
