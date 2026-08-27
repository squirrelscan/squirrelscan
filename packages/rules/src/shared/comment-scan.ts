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
// After an identifier, a literal, `)` or `]` it is treated as division, which is
// the conservative choice: mistaking a regex for division at worst scans its
// body as code, while mistaking division for a regex swallows real comments.
// `if(x)/re/.test(y)` is therefore read as division; that is legal JavaScript but
// rare enough not to be worth a backwards paren match.
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

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isSchemeChar(ch: string): boolean {
  return isIdentPart(ch) || ch === "+" || ch === "-" || ch === ".";
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

function regexCanStartAfter(src: string, lastCode: number): boolean {
  if (lastCode < 0) return true;
  const ch = src[lastCode] as string;
  if (ch === ")" || ch === "]" || ch === '"' || ch === "'" || ch === "`") return false;
  if (isIdentPart(ch)) {
    let start = lastCode;
    while (start >= 0 && isIdentPart(src[start] as string)) start--;
    return REGEX_KEYWORDS.has(src.slice(start + 1, lastCode + 1));
  }
  // `}` closes a block far more often than it closes an object literal being
  // divided, so a `/` after it is read as a regex at statement position.
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
  // a line such as `x=/\/\/\/…` re-probes at every slash and the scan goes
  // quadratic on a multi-MB bundle. If nothing could close a regex opened at i,
  // treat the rest of that line as division rather than probing again.
  let noRegexBefore = -1;
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
        // colon of a URL scheme.
        if (i > 0 && src[i - 1] === ":" && endsUrlScheme(src, i - 1)) {
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
      if (i >= noRegexBefore && regexCanStartAfter(src, lastCode)) {
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

    if (!isWhitespace(ch)) lastCode = i;
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
