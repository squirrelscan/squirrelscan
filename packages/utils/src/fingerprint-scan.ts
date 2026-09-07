// A forward-only HTML scanner for the source fingerprint (#1899).
//
// The fingerprint has to find two kinds of region in up to 2 MB of
// attacker-influenced markup: `<script>` blocks, and the runs of Shopify app
// blocks / app-extension asset tags whose ORDER rotates per cache entry.
//
// Regexes were the obvious tool and the wrong one. A pattern like
// `<!--\s*BEGIN app block:[\s\S]*?<!--\s*END app block\s*-->` rescans the
// remainder of the document once per unmatched BEGIN, and an asset-tag pattern
// with a trailing `[^>]*` compounds it: measured at 9 / 68 / 523 ms on 3.5 / 7 /
// 14 KB of hostile input, i.e. cubic, against a 2 MB ceiling. This scanner is
// single-pass and cannot backtrack: every function below advances an index and
// never re-reads what it has passed.
//
// It also fixes a correctness problem regexes had here. A regex matches inside
// `<textarea>`, `<title>` and script payloads, where markup-looking text is
// DATA — sorting "tags" found in a textarea would change what the page displays
// while claiming to normalize noise. The scanner tracks raw-text elements and
// refuses to look inside them.

/** A region of the source, located by the scanner. */
export interface SourceRegion {
  start: number;
  end: number;
}

/** A `<script>`, split so a rewrite can touch the body without the open tag. */
export interface ScriptRegion extends SourceRegion {
  openTagEnd: number;
  bodyEnd: number;
}

/** Elements whose content is text, not markup. Nothing inside them is a tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

function isNameChar(code: number): boolean {
  // a-z A-Z 0-9 - _ : .
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95 ||
    code === 58 ||
    code === 46
  );
}

/**
 * Read a tag name at `i` (which points just past `<` or `</`). Returns the
 * lowercased name and the index after it, or null when this is not a tag start.
 */
function readTagName(html: string, i: number): { name: string; next: number } | null {
  let j = i;
  while (j < html.length && isNameChar(html.charCodeAt(j))) j++;
  if (j === i) return null;
  return { name: html.slice(i, j).toLowerCase(), next: j };
}

/**
 * Skip to just past the `>` that closes an open tag, respecting quoted
 * attribute values.
 *
 * Quote awareness is why this is not `indexOf(">")`: in
 * `<script data-x=">" src="/a.js">` the first `>` is inside an attribute, and a
 * scanner that stopped there would treat `src="/a.js"` as body text — which is
 * how a body-only rewrite ends up rewriting a src attribute.
 */
function skipOpenTag(html: string, i: number): number {
  let quote = 0;
  for (let j = i; j < html.length; j++) {
    const c = html.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
      continue;
    }
    if (c === 34 || c === 39) {
      quote = c;
      continue;
    }
    if (c === 62) return j + 1; // '>'
  }
  return html.length;
}

/**
 * Find `</name` from `i`, case-insensitively, without allocating.
 *
 * The obvious version lowercases the document and calls `indexOf`. That is one
 * full copy per call — 102 scripts on a real 957 KB page turned a 2 ms scan
 * into 246 ms — and it is also unsound: `toLowerCase` is not length-preserving
 * for every code point, so indices into the lowered copy can drift from the
 * original. This compares in place.
 */
function findClosingTag(html: string, name: string, i: number): number {
  const len = name.length;
  for (let at = html.indexOf("<", i); at >= 0; at = html.indexOf("<", at + 1)) {
    if (html.charCodeAt(at + 1) !== 47) continue; // '/'
    let k = 0;
    while (k < len) {
      const c = html.charCodeAt(at + 2 + k);
      const want = name.charCodeAt(k);
      // name is already lowercase; accept either case in the document.
      if (c !== want && c !== want - 32) break;
      k++;
    }
    if (k === len) return at;
  }
  return -1;
}

/**
 * Walk the document once, reporting every `<script>` and every top-level
 * comment, and skipping the contents of raw-text elements entirely.
 *
 * `onScript` receives the region plus the two interior boundaries a rewrite
 * needs. `onComment` receives comment regions, which is how the Shopify app
 * blocks (fenced by `<!-- BEGIN app block: … -->` / `<!-- END app block -->`)
 * are located without a pattern that can rescan.
 */
export function scanSource(
  html: string,
  visit: {
    onScript?: (region: ScriptRegion) => void;
    onComment?: (region: SourceRegion, text: string) => void;
    onTag?: (region: SourceRegion, name: string) => void;
  },
): void {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return;

    // Comment: `<!-- … -->`. Unterminated, it runs to the end, and the scanner
    // stops rather than treating the rest of the document as markup.
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const end = close < 0 ? html.length : close + 3;
      visit.onComment?.({ start: lt, end }, html.slice(lt + 4, close < 0 ? html.length : close));
      i = end;
      continue;
    }

    if (html.startsWith("</", lt)) {
      i = skipOpenTag(html, lt + 2);
      continue;
    }

    const tag = readTagName(html, lt + 1);
    if (!tag) {
      i = lt + 1; // a bare `<` in text
      continue;
    }

    const openTagEnd = skipOpenTag(html, tag.next);

    if (tag.name === "script") {
      const closeAt = findClosingTag(html, "script", openTagEnd);
      const bodyEnd = closeAt < 0 ? html.length : closeAt;
      const end = closeAt < 0 ? html.length : skipOpenTag(html, closeAt + 8);
      visit.onScript?.({ start: lt, openTagEnd, bodyEnd, end });
      i = end;
      continue;
    }

    if (RAW_TEXT.has(tag.name)) {
      // Everything inside is text. Never look at it, never sort in it.
      const closeAt = findClosingTag(html, tag.name, openTagEnd);
      i = closeAt < 0 ? html.length : skipOpenTag(html, closeAt + 2 + tag.name.length);
      continue;
    }

    visit.onTag?.({ start: lt, end: openTagEnd }, tag.name);
    i = openTagEnd;
  }
}
