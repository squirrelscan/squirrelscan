// Case-insensitive DOM attribute helpers
//
// HTML attribute names are case-insensitive per spec, but React SSR outputs
// camelCase (e.g. charSet, tabIndex, httpEquiv). linkedom preserves original
// case, so querySelector("[tabindex]") misses React's "tabIndex".
// These helpers normalise attribute access across all frameworks.

/**
 * Case-insensitive getAttribute. Returns the value of the first attribute
 * whose name matches (ignoring case), or null.
 */
export function getAttrCI(el: Element, name: string): string | null {
  const lower = name.toLowerCase();
  // Deliberately NOT short-circuiting on getAttribute(lower) first: linkedom
  // keeps BOTH spellings of a case-variant duplicate (<img ALT="a" alt="b">
  // yields two attributes), so an exact-match fast path would return the last
  // one where this scan returns the first — and the first is what a browser
  // keeps, since its parser drops the duplicate. A hash lookup is not worth
  // disagreeing with browsers on malformed markup.
  for (const attr of el.attributes) {
    if (attr.name.toLowerCase() === lower) return attr.value;
  }
  return null;
}

/**
 * Check whether an element has an attribute (case-insensitive name match).
 */
export function hasAttrCI(el: Element, name: string): boolean {
  const lower = name.toLowerCase();
  for (const attr of el.attributes) {
    if (attr.name.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Find all elements matching `tag` that have `attr` (case-insensitive).
 * Returns matching elements. Pass "*" for tag to search all elements.
 */
export function querySelectorAllByAttrCI(
  root: Element | Document,
  tag: string,
  attr: string
): Element[] {
  const elements = root.querySelectorAll(tag);
  const results: Element[] = [];
  for (const el of elements) {
    if (hasAttrCI(el, attr)) results.push(el);
  }
  return results;
}

/**
 * Find first element matching `tag` that has `attr` with `value` (case-insensitive
 * attribute name, exact value match).
 */
export function querySelectorByAttrValueCI(
  root: Element | Document,
  tag: string,
  attr: string,
  value: string
): Element | null {
  const elements = root.querySelectorAll(tag);
  for (const el of elements) {
    if (getAttrCI(el, attr) === value) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// <noscript> content
//
// A browser with scripting enabled parses `<noscript>` content as raw text
// (HTML Standard, "the noscript element"), so nothing inside it becomes an
// element: it never loads, renders or reaches the accessibility tree. linkedom
// parses it as ordinary markup, so a plain querySelectorAll also returns the
// tracking pixels, GTM iframes and fallback stylesheets that sites put there
// for no-JS visitors (#434). Rules and extractors that describe what a browser
// loads or renders select through these helpers instead.

/** The tree links these helpers read: true of linkedom and DOM elements. */
interface TreeElement {
  localName: string;
  parentElement: TreeElement | null;
}

interface Queryable<E> {
  querySelectorAll(selector: string): Iterable<E>;
}

/**
 * Whether `el` sits inside a `<noscript>`, which makes it inert text to a
 * browser with scripting enabled. The `<noscript>` element itself is not
 * inside one.
 */
export function isInsideNoscript(el: TreeElement): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.localName === "noscript") return true;
  }
  return false;
}

/**
 * `root.querySelectorAll(selector)` without the elements inside `<noscript>`:
 * the elements a browser with scripting enabled actually builds.
 */
export function querySelectorAllOutsideNoscript<E extends TreeElement>(
  root: Queryable<E>,
  selector: string
): E[] {
  const matches: E[] = [];
  for (const el of root.querySelectorAll(selector)) {
    if (!isInsideNoscript(el)) matches.push(el);
  }
  return matches;
}

// Elements whose content the tokenizer reads as text up to the matching end
// tag, so a `<noscript>` written inside one (a JS string, a CSS comment) is not
// a tag. `noscript` itself joins them: with scripting on it is raw text too.
const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

const TAG_NAME = /<(\/?)([a-zA-Z][^\t\n\f\r />]*)/y;
const closeTagCache = new Map<string, RegExp>();

/** Index just past the `>` that ends the tag whose name ends at `from`. */
function endOfTag(html: string, from: number): number {
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (c === ">") return i + 1;
    if (c === '"' || c === "'") {
      const close = html.indexOf(c, i + 1);
      if (close === -1) return html.length;
      i = close;
    }
  }
  return html.length;
}

/**
 * Index just past the comment whose `<!--` ends at `from`. Besides `-->`, a
 * browser also closes one at `--!>`, and `<!-->` / `<!--->` close at once.
 */
function endOfComment(html: string, from: number): number {
  if (html.startsWith(">", from)) return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  const plain = html.indexOf("-->", from);
  const bang = html.indexOf("--!>", from);
  if (plain === -1 && bang === -1) return html.length;
  if (bang === -1 || (plain !== -1 && plain < bang)) return plain + 3;
  return bang + 4;
}

/** Start of the next `</name` end tag at or after `from`, or -1. */
function findEndTag(html: string, name: string, from: number): number {
  let re = closeTagCache.get(name);
  if (!re) {
    re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "gi");
    closeTagCache.set(name, re);
  }
  re.lastIndex = from;
  return re.exec(html)?.index ?? -1;
}

/**
 * Raw `html` without its `<noscript>` elements, for the rules that scan page
 * source with a regex rather than the DOM. It tokenizes just enough to find
 * real `<noscript>` start tags: comments, quoted attribute values and the
 * content of `<script>`, `<style>` and the other raw-text elements are passed
 * over, and a `<noscript>` runs to the first `</noscript>` after its start
 * tag, as it does in a browser with scripting on (or to the end, unclosed).
 * Linear in the length of `html`.
 */
export function stripNoscriptMarkup(html: string): string {
  if (!/<noscript/i.test(html)) return html;

  let out = "";
  let copyFrom = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      i = endOfComment(html, lt + 4);
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      // DOCTYPE, CDATA and other bogus comments end at the first `>`.
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    TAG_NAME.lastIndex = lt;
    const tag = TAG_NAME.exec(html);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const isEndTag = tag[1] === "/";
    const name = (tag[2] ?? "").toLowerCase();
    const afterTag = endOfTag(html, lt + tag[0].length);

    if (isEndTag || !RAW_TEXT_ELEMENTS.has(name)) {
      i = afterTag;
      continue;
    }

    const close = findEndTag(html, name, afterTag);
    const afterElement = close === -1 ? html.length : endOfTag(html, close + 2 + name.length);
    if (name === "noscript") {
      out += html.slice(copyFrom, lt);
      copyFrom = afterElement;
    }
    i = afterElement;
  }
  return out + html.slice(copyFrom);
}
