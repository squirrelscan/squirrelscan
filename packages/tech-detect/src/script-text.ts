/**
 * Whether a string literal of a bundle is the text of an inline script a framework renders (#1509): the value of
 * `dangerouslySetInnerHTML:{__html:...}` or of `children` on the props of a script element, and a loader rather than a
 * quote of one. A docs page, a markdown renderer or a test fixture holds the same snippet as text under the same
 * keys, so the key alone is no evidence: the element must be script-shaped, and the string must read as JavaScript.
 *
 * Everything is read from the scanner's tokens: the keys and braces come from the code with every string's contents
 * blanked, so a string cannot supply an `id:`, a `strategy:` or a `{` of its own. Reads are bounded on every side.
 */

/** Longest string read as a carrier: the standard snippet is about 400 characters. */
const MAX_CARRIER_CHARS = 4_096;
/** Chars read before a string for the key it is the value of. */
const KEY_CHARS = 48;
/** Chars of code searched for the braces around a string, each way. */
const OBJECT_SCAN_CHARS = 2_000;

const CHILDREN_KEY = /children["']?\s*:\s*$/;
const HTML_KEY = /__html["']?\s*:\s*$/;
const INNER_HTML_KEY = /dangerouslySetInnerHTML["']?\s*:\s*$/;
const SCRIPT_TAG = /["']script["']\s*,\s*$/;
const STRATEGY_KEY = /(?:^|[{,\s])strategy["']?\s*:/;
const TYPE_KEY = /(?:^|[{,\s])type["']?\s*:\s*$/;
const SCRIPT_MIME = /^["']?(?:text\/javascript|application\/javascript|module)\b/;
/** Markup: a string that opens a tag or holds one is a page's HTML, not a script body. */
const MARKUP = /<[a-z!/]/i;

/** The code between `from` and `to` with the contents of every string blanked (quotes kept), indices unchanged. */
function blanked(code: string, strings: readonly number[], from: number, to: number): string {
  let lo = 0;
  let hi = strings.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strings[mid * 2 + 1]! < from) lo = mid + 1;
    else hi = mid;
  }
  const parts: string[] = [];
  let at = from;
  for (let k = lo; k * 2 < strings.length; k++) {
    const start = strings[k * 2]!;
    const end = strings[k * 2 + 1]!;
    if (start >= to) break;
    if (end < at) continue;
    const a = Math.max(start + 1, at);
    const b = Math.min(end, to);
    if (a >= b) continue;
    parts.push(code.slice(at, a), " ".repeat(b - a));
    at = b;
  }
  parts.push(code.slice(at, to));
  return parts.join("");
}

/** The `{` that directly encloses `pos` in `text` (indices relative to `base`), or -1 when a `(` or `[` comes first. */
function enclosingBrace(text: string, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 125 || c === 93 || c === 41) depth++; // } ] )
    else if (c === 123) {
      if (depth === 0) return i;
      depth--;
    } else if (c === 91 || c === 40) {
      if (depth === 0) return -1;
      depth--;
    }
  }
  return -1;
}

/** The `}` that closes the `{` at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 123 || c === 91 || c === 40) depth++;
    else if (c === 125 || c === 93 || c === 41) {
      if (depth === 0) return c === 125 ? i : -1;
      depth--;
    }
  }
  return -1;
}

/** `text[open..close]` with everything nested deeper than the object itself blanked: its own keys only. */
function ownKeys(text: string, open: number, close: number): string {
  let depth = 0;
  let out = "";
  for (let i = open + 1; i < close; i++) {
    const c = text.charCodeAt(i);
    if (c === 123 || c === 91 || c === 40) {
      depth++;
      out += " ";
    } else if (c === 125 || c === 93 || c === 41) {
      depth--;
      out += " ";
    } else out += depth === 0 ? text[i] : " ";
  }
  return out;
}

/** Whether the props object `{open..}` belongs to a script element. */
function scriptProps(code: string, text: string, base: number, open: number): boolean {
  const close = closingBrace(text, open);
  if (close === -1) return false;
  // `h("script",{...})`, `jsx("script",{...})`, `createElement("script",{...})`: the tag is the argument before the props.
  if (SCRIPT_TAG.test(code.slice(Math.max(0, base + open - KEY_CHARS), base + open))) return true;
  const own = ownKeys(text, open, close);
  if (STRATEGY_KEY.test(own)) return true; // next/script
  // `type:"text/javascript"`: the value is a string, blanked in `own`, so it is read from the code at the same place.
  const re = new RegExp(TYPE_KEY.source.replace("$", ""), "g");
  for (let m = re.exec(own); m; m = re.exec(own)) {
    const at = base + open + 1 + m.index + m[0].length;
    if (SCRIPT_MIME.test(code.slice(at, at + 32))) return true;
  }
  return false;
}

/**
 * `open` and `close` are the quote positions of the string literal; `evidence` must match its text (the standard
 * snippet's signature, or its loader pair).
 */
export function isScriptTextString(
  code: string,
  strings: readonly number[],
  open: number,
  close: number,
  evidence: RegExp,
): boolean {
  if (close - open > MAX_CARRIER_CHARS) return false;
  const key = code.slice(Math.max(0, open - KEY_CHARS), open);
  const isChildren = CHILDREN_KEY.test(key);
  const isHtml = !isChildren && HTML_KEY.test(key);
  if (!isChildren && !isHtml) return false;
  const text = code.slice(open + 1, close);
  if (MARKUP.test(text) || !evidence.test(text)) return false;
  const base = Math.max(0, open - OBJECT_SCAN_CHARS);
  const view = blanked(code, strings, base, Math.min(code.length, close + 1 + OBJECT_SCAN_CHARS));
  const brace = enclosingBrace(view, open - base);
  if (brace === -1) return false;
  if (isChildren) return scriptProps(code, view, base, brace);
  // `{__html:...}` is the value of `dangerouslySetInnerHTML` on the props of the element.
  if (!INNER_HTML_KEY.test(code.slice(Math.max(0, base + brace - KEY_CHARS), base + brace))) return false;
  const props = enclosingBrace(view, brace);
  return props !== -1 && scriptProps(code, view, base, props);
}
