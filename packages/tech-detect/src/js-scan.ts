/**
 * A single linear pass over a JavaScript slice that blanks comments and records
 * where string literals sit. A `script-content` detector flagged `inCode` needs a
 * real usage (a call, a config object), so a match inside a comment or a string
 * (a docs snippet, an error message, a commented-out call) is not evidence.
 *
 * Heuristic, not a parser: regex literals are skipped by the usual
 * previous-token rule so a `/["']/` does not open a string, and template
 * literals are read as one string with no `${}` nesting. A wrong guess costs a
 * missed or extra match on odd code, never a hang: the pass is O(n) and the
 * input is already capped by the caller.
 */
export interface ScannedJs {
  /** The source with comment bodies replaced by spaces (indices line up with the input). */
  code: string;
  /** Flat `[start, end, start, end, ...]` of string and regex literals, ascending. */
  strings: number[];
  /**
   * Flat `[start, end, ...]` of every string, regex literal and comment,
   * ascending: a cut point `p` is inside one when `start < p <= end`. A window
   * cut at a position outside them starts (and ends) in code state, so a scan of
   * the window alone reads the same as a scan of the whole file.
   */
  skips: number[];
}

/** Separates independently scanned segments: a NUL ends any string or comment still open. */
export const SEGMENT_SEPARATOR = "\n\0\n";

const REGEX_PRECEDING_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);

function isIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

/** Whether a `/` after the code ending at `end` (exclusive, whitespace skipped) opens a regex literal. */
function slashOpensRegex(src: string, end: number): boolean {
  let p = end - 1;
  while (p >= 0) {
    const c = src.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10 || c === 13) p--;
    else break;
  }
  if (p < 0) return true;
  const c = src.charCodeAt(p);
  if (c === 41 || c === 93 || c === 125) return false; // ) ] }
  if (!isIdentChar(c)) return true;
  let s = p;
  while (s > 0 && isIdentChar(src.charCodeAt(s - 1))) s--;
  return REGEX_PRECEDING_WORDS.has(src.slice(s, p + 1));
}

export function scanJs(src: string): ScannedJs {
  const n = src.length;
  const strings: number[] = [];
  const skips: number[] = [];
  const parts: string[] = [];
  let copied = 0;
  let i = 0;
  let lastCode = 0; // exclusive end of the last non-comment, non-space char seen

  const blank = (from: number, to: number): void => {
    parts.push(src.slice(copied, from), " ".repeat(to - from));
    copied = to;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      i += 2;
      lastCode = Math.min(i, n);
      continue;
    }
    if (c === 34 || c === 39 || c === 96) {
      const start = i;
      i++;
      while (i < n) {
        const d = src.charCodeAt(i);
        if (d === 92) {
          i += 2;
          continue;
        }
        if (d === c) break;
        if (d === 0) break;
        if (d === 10 && c !== 96) break;
        i++;
      }
      strings.push(start, Math.min(i, n));
      skips.push(start, Math.min(i, n));
      i++;
      lastCode = Math.min(i, n);
      continue;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        let end = src.indexOf("\n", i);
        if (end === -1) end = n;
        skips.push(i, Math.max(i, end - 1));
        blank(i, end);
        i = end;
        continue;
      }
      if (d === 42) {
        const close = src.indexOf("*/", i + 2);
        let end = close === -1 ? n : close + 2;
        const nul = src.indexOf("\0", i + 2);
        if (nul !== -1 && nul < end) end = nul;
        skips.push(i, end - 1);
        blank(i, end);
        i = end;
        continue;
      }
      if (slashOpensRegex(src, lastCode)) {
        // Skip the regex literal: to the next unescaped `/` outside a class.
        const regexStart = i;
        i++;
        let inClass = false;
        while (i < n) {
          const e = src.charCodeAt(i);
          if (e === 92) {
            i += 2;
            continue;
          }
          if (e === 10 || e === 0) break;
          if (e === 91) inClass = true;
          else if (e === 93) inClass = false;
          else if (e === 47 && !inClass) break;
          i++;
        }
        strings.push(regexStart, Math.min(i, n));
        skips.push(regexStart, Math.min(i, n));
        i++;
        lastCode = Math.min(i, n);
        continue;
      }
    }
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) lastCode = i + 1;
    i++;
  }
  parts.push(src.slice(copied));
  return { code: parts.length === 1 ? parts[0]! : parts.join(""), strings, skips };
}

/** Whether `index` falls inside one of the recorded string literals (binary search). */
export function inString(strings: number[], index: number): boolean {
  let lo = 0;
  let hi = strings.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = strings[mid * 2]!;
    const end = strings[mid * 2 + 1]!;
    if (index < start) hi = mid - 1;
    else if (index > end) lo = mid + 1;
    else return index > start; // the opening quote itself is code
  }
  return false;
}

/** The start of the range in `skips` that has `index` inside it (`start < index <= end`), or -1. */
export function skipStart(skips: number[], index: number): number {
  let lo = 0;
  let hi = skips.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = skips[mid * 2]!;
    const end = skips[mid * 2 + 1]!;
    if (index <= start) hi = mid - 1;
    else if (index > end) lo = mid + 1;
    else return start;
  }
  return -1;
}

/** The end of the range in `skips` that has `index` inside it (`start < index <= end`), or -1. */
export function skipEnd(skips: number[], index: number): number {
  let lo = 0;
  let hi = skips.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = skips[mid * 2]!;
    const end = skips[mid * 2 + 1]!;
    if (index <= start) hi = mid - 1;
    else if (index > end) lo = mid + 1;
    else return end;
  }
  return -1;
}
