// The regions of a page's HTML that a browser does not run or show (#1550), taken out in ONE tokenizing pass.
//
// A detector that reads the page's HTML as text also matches a vendor URL or tag that sits only in content nothing loads: the
// raw text of a JSON, JSON-LD or import-map `<script>`, the inert content of a `<template>`, and an HTML comment that holds
// commented-out code. This pass builds the views the detectors read:
//   - `markup`: the page with `<template>` content taken out, and nothing else. The tag readers (`script-url`, `tag-attr`)
//     read it; they skip comments and data scripts themselves, and an import map's body stays for them.
//   - `clean`: `markup` with the body of every data script taken out and every comment removed: what an `html` detector reads.
//   - `commented`: `clean` with the comments kept, for the fingerprints whose evidence is a marker comment (see
//     {@link COMMENT_MARKER_FINGERPRINTS}).
//
// FAIL CLOSED. A region comes out only when this pass can prove where a browser's tokenizer puts its edges; a dropped real tag
// is a missed detection a page can cause, a kept commented-out one is the accepted old behaviour. So the pass follows the HTML
// tokenizer where a boundary depends on it and keeps whatever it cannot prove:
//   - a comment ends at `-->` or `--!>` (and `<!-->` and `<!--->` are empty comments); one that never ends stays;
//   - the text of `<script>`, `<style>`, `<textarea>`, `<title>`, `<xmp>`, `<iframe>`, `<noembed>`, `<noframes>` and
//     `<noscript>` is raw text, its end is `</name` followed by whitespace, `/` or `>`, and `<!--` or `<template` inside it
//     is not markup; a script's end follows the script-data "escaped" states (`<!--` ... `<script>` ... `</script>` ...),
//     and `<plaintext>` makes the rest of the page text;
//   - a tag is read as the tokenizer reads it (a quote opens a value only after `=`); a tag longer than 64 KB, or one that
//     never ends, stops the pass and the rest of the page stays;
//   - `<template>` pairs only with `</template>` tags the pass itself saw as tags, innermost first, so the word in an
//     attribute, a script string, a comment or a textarea never pairs; one that never closes stays, and so does a
//     declarative shadow root (its content is rendered), which still pairs, so it cannot steal an outer template's end;
//   - `<svg>` and `<math>` are foreign content, where the tokenizer's rules change: the region is kept whole and read only to
//     find its end, and if it holds anything whose reading depends on the tree builder (an HTML element that breaks out of
//     foreign content, a raw-text element with markup inside, `<plaintext>`) the pass stops and the rest of the page stays;
//   - a script whose type is not plainly data, a duplicate `type` (the first wins), and a data script that never closes, stay.
// `<style>` text is CSS evidence and always stays. Linear: every index is visited once and every search moves forward.

/**
 * The fingerprints whose evidence is a comment the page carries on purpose (a plugin's banner, a template's marker): they read
 * the `commented` view. Explicit, because a comment is otherwise not evidence. A test checks that every fingerprint with a
 * pattern that opens at `<!--` is listed and that every id here exists.
 */
export const COMMENT_MARKER_FINGERPRINTS: ReadonlySet<string> = new Set([
  "wp-rocket",
  "litespeed-cache",
  "w3-total-cache",
  "wp-super-cache",
  "wp-fastest-cache",
  "yoast-seo",
  "rank-math",
  "all-in-one-seo",
  "jekyll",
  "mailchimp",
  // Shopify writes `<!-- BEGIN app block: shopify://apps/klaviyo-email-marketing-sms/... -->` around an app block that is enabled.
  "klaviyo",
  // Font Awesome's banner (`<!--!Font Awesome Free ... by @fontawesome-->`) sits inside the inline SVGs of real use.
  "font-awesome",
]);


/** Longest tag read; a longer one stops the pass (the rest of the page is kept). */
const MAX_TAG_CHARS = 64 * 1024;
const MAX_ATTRIBUTES = 100;

export interface PageViews {
  markup: string;
  clean: string;
  commented: string;
}

/** The elements whose text is raw text or RCDATA in HTML: no markup inside, and `</name` + whitespace, `/` or `>` ends it. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const rawTextCloser = (name: string): RegExp => new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
const RAW_TEXT_CLOSERS: ReadonlyMap<string, RegExp> = new Map([...RAW_TEXT_ELEMENTS].map((name) => [name, rawTextCloser(name)]));

/** A `<script` or `</script` that the tokenizer reads as a tag name: followed by whitespace, `/` or `>`. */
const SCRIPT_TAG = /<\/?script(?=[\t\n\f\r />])/gi;

/** HTML start tags that end foreign content (svg, math) in the tree builder; `font` does with some attributes, so always. */
const BREAKOUT_TAGS: ReadonlySet<string> = new Set(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var font".split(" ")
);

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
const isLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

interface Tag {
  /** The index of the `>` that ends it. */
  end: number;
  name: string;
  closing: boolean;
  /** `<a />`: the `/` just before the `>` (HTML ignores it on every element it knows; foreign content honours it). */
  selfClosing: boolean;
  /** Attribute names, lower case, to their values; the first of a repeated name wins. At most {@link MAX_ATTRIBUTES}. */
  attrs: Map<string, string>;
}

/**
 * The tag whose `<` is at `open` (a letter, or `/` and a letter, follows), read the way the HTML tokenizer reads it: the name
 * ends at whitespace, `/` or `>`; an attribute name ends at those or `=`; a quote opens a value only right after `=`; an
 * unquoted value ends at whitespace or `>`. Null when the tag never ends or is longer than {@link MAX_TAG_CHARS}.
 */
function readTag(html: string, open: number): Tag | null {
  const n = html.length;
  const limit = Math.min(n, open + MAX_TAG_CHARS);
  let i = open + 1;
  const closing = html.charCodeAt(i) === 47;
  if (closing) i++;
  const nameStart = i;
  while (i < limit) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === 47 || c === 62) break;
    i++;
  }
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  for (;;) {
    selfClosing = false;
    while (i < limit) {
      const c = html.charCodeAt(i);
      if (isSpace(c)) i++;
      else if (c === 47) {
        selfClosing = html.charCodeAt(i + 1) === 62;
        i++;
      } else break;
    }
    if (i >= limit) return null;
    if (html.charCodeAt(i) === 62) return { end: i, name, closing, selfClosing, attrs };
    const attrStart = i++; // an `=` first is part of the name
    while (i < limit) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === 47 || c === 62 || c === 61) break;
      i++;
    }
    const attrName = html.slice(attrStart, i).toLowerCase();
    while (i < limit && isSpace(html.charCodeAt(i))) i++;
    let value = "";
    if (html.charCodeAt(i) === 61) {
      i++;
      while (i < limit && isSpace(html.charCodeAt(i))) i++;
      const q = html.charCodeAt(i);
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", i + 1);
        if (close === -1 || close >= limit) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const start = i;
        while (i < limit && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i++;
        value = html.slice(start, i);
      }
    }
    if (i >= limit) return null;
    if (!attrs.has(attrName) && attrs.size < MAX_ATTRIBUTES) attrs.set(attrName, value);
  }
}

const COMMENT_END = /--!?>/g;

/** The index just past the comment that starts with `<!--` at `open`, or -1 when it never ends. */
function commentEnd(html: string, open: number): number {
  const i = open + 4;
  if (html.charCodeAt(i) === 62) return i + 1; // <!-->
  if (html.charCodeAt(i) === 45 && html.charCodeAt(i + 1) === 62) return i + 2; // <!--->
  COMMENT_END.lastIndex = i;
  const m = COMMENT_END.exec(html);
  return m ? m.index + m[0].length : -1;
}

/** Where the next comment opener and closer are, kept across the scripts of one page: positions only move forward, so the searches add up to one pass. */
interface ScriptCache {
  opener: number;
  closer: number;
}

/**
 * The index of the `</script` that ends a script whose text starts at `from`, or -1. Follows the script-data states: a
 * comment opener makes it "escaped" (until the comment closer), a `<script` while escaped makes it "double escaped" (a
 * `</script` then only steps back to escaped), and in the plain and the escaped state a `</script` ends it.
 */
function scriptEnd(html: string, from: number, cache: ScriptCache): number {
  const opener = "<!--";
  const closer = "-->";
  const next = (known: number, needle: string, i: number): number => (known === -1 || known >= i ? known : html.indexOf(needle, i));
  let state = 0; // 0 script data, 1 escaped, 2 double escaped
  let i = from;
  SCRIPT_TAG.lastIndex = i;
  let tag = SCRIPT_TAG.exec(html);
  for (;;) {
    cache.opener = next(cache.opener, opener, i);
    cache.closer = next(cache.closer, closer, i);
    const t = tag ? tag.index : Infinity;
    const o = cache.opener === -1 ? Infinity : cache.opener;
    const c = cache.closer === -1 ? Infinity : cache.closer;
    const first = Math.min(o, c, t);
    if (first === Infinity) return -1;
    if (first === o) {
      if (state === 0) state = 1;
      i = first + 2; // the dashes may also begin the closer (`<!-->`, `<!--->`)
    } else if (first === c) {
      state = 0;
      i = first + 3;
    } else {
      if (tag!.index !== first) return -1;
      if (tag![0].charCodeAt(1) === 47) {
        if (state !== 2) return first;
        state = 1;
      } else if (state === 1) state = 2;
      i = first + tag![0].length;
    }
    if (tag && tag.index < i) {
      SCRIPT_TAG.lastIndex = i;
      tag = SCRIPT_TAG.exec(html);
    }
  }
}

/** The index just past the svg or math element whose start tag ended just before `from`, or -1 when the pass cannot tell (see the file comment). */
function foreignEnd(html: string, from: number): number {
  let depth = 1;
  let pos = from;
  for (;;) {
    const open = html.indexOf("<", pos);
    if (open === -1) return -1;
    const c = html.charCodeAt(open + 1);
    if (html.startsWith("<!--", open)) {
      const end = commentEnd(html, open);
      if (end === -1) return -1;
      pos = end;
    } else if (c === 33 || c === 63) {
      if (html.startsWith("<![CDATA[", open)) {
        const end = html.indexOf("]]>", open + 9);
        if (end === -1) return -1;
        pos = end + 3;
      } else {
        const gt = html.indexOf(">", open + 2);
        if (gt === -1) return -1;
        pos = gt + 1;
      }
    } else if (isLetter(c) || (c === 47 && isLetter(html.charCodeAt(open + 2)))) {
      const tag = readTag(html, open);
      if (!tag) return -1;
      pos = tag.end + 1;
      if (tag.name === "svg" || tag.name === "math") {
        if (tag.closing) {
          if (--depth === 0) return pos;
        } else if (!tag.selfClosing) depth++;
      } else if (!tag.closing) {
        if (BREAKOUT_TAGS.has(tag.name) || tag.name === "plaintext") return -1;
        if (!tag.selfClosing && (tag.name === "script" || RAW_TEXT_ELEMENTS.has(tag.name))) {
          // In foreign content these are ordinary elements, elsewhere raw text: the two readings agree only when no markup follows
          const next = html.indexOf("<", pos);
          if (next === -1 || html.charCodeAt(next + 1) !== 47 || html.slice(next + 2, next + 2 + tag.name.length).toLowerCase() !== tag.name) return -1;
        }
      }
    } else if (c === 47) {
      const gt = html.indexOf(">", open + 2);
      if (gt === -1) return -1;
      pos = gt + 1; // `</>` and a bogus end tag
    } else pos = open + 1;
  }
}

type EditKind = "template" | "comment" | "data";
interface Edit {
  start: number;
  end: number;
  kind: EditKind;
}

/**
 * The views of `html` (see the file comment). The strings are `html` itself when nothing was taken out of them.
 * `isDataType` says whether a script `type` marks a data block (the caller's own list).
 */
export function pageViews(html: string, isDataType: (type: string) => boolean): PageViews {
  // Nothing here can matter on a page with none of these: the common case costs three searches.
  if (!html.includes("<!--") && !/<template(?![\w:.-])/i.test(html) && !/<script[\s/>]/i.test(html)) {
    return { markup: html, clean: html, commented: html };
  }
  const edits: Edit[] = [];
  const templates: Array<{ start: number; mark: number; shadow: boolean }> = [];
  const n = html.length;
  const scriptCache: ScriptCache = { opener: -2, closer: -2 };
  let pos = 0;
  scan: for (;;) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;
    const c = html.charCodeAt(open + 1);
    if (html.startsWith("<!--", open)) {
      const end = commentEnd(html, open);
      if (end === -1) break; // never ends: it stays, and so does the rest
      edits.push({ start: open, end, kind: "comment" });
      pos = end;
    } else if (c === 33 || c === 63) {
      // `<!DOCTYPE>`, `<![CDATA[` outside foreign content, `<?x>`: a bogus comment or doctype up to the first `>`
      const gt = html.indexOf(">", open + 2);
      if (gt === -1) break;
      pos = gt + 1;
    } else if (c === 47 && !isLetter(html.charCodeAt(open + 2))) {
      const gt = html.indexOf(">", open + 2);
      if (gt === -1) break;
      pos = gt + 1; // `</>` and a bogus end tag
    } else if (isLetter(c) || c === 47) {
      const tag = readTag(html, open);
      if (!tag) break;
      pos = tag.end + 1;
      if (tag.closing) {
        if (tag.name === "template" && templates.length > 0) {
          const top = templates.pop()!;
          if (!top.shadow) {
            edits.length = top.mark; // whatever was found inside goes with the template
            edits.push({ start: top.start, end: pos, kind: "template" });
          }
        }
        continue;
      }
      const name = tag.name;
      if (name === "template") {
        templates.push({ start: open, mark: edits.length, shadow: tag.attrs.has("shadowrootmode") || tag.attrs.has("shadowroot") });
      } else if (name === "svg" || name === "math") {
        if (tag.selfClosing) continue;
        const end = foreignEnd(html, pos);
        if (end === -1) break scan;
        pos = end;
      } else if (name === "plaintext") {
        break;
      } else if (name === "script") {
        const end = scriptEnd(html, pos, scriptCache);
        if (end === -1) break; // never ends: the rest is script text and stays
        const type = (tag.attrs.get("type") ?? "").trim().slice(0, 256);
        if (end > pos && tag.attrs.has("type") && isDataType(type)) {
          // the body of a data script: kept for the tag readers, taken out of the views an `html` detector reads
          edits.push({ start: pos, end, kind: "data" });
        }
        pos = end;
      } else if (RAW_TEXT_ELEMENTS.has(name)) {
        const closer = RAW_TEXT_CLOSERS.get(name)!;
        closer.lastIndex = pos;
        const found = closer.exec(html);
        if (!found) break;
        pos = found.index;
      }
    } else pos = open + 1;
    if (pos > n) break;
  }
  return viewsOf(html, edits);
}

/** The three views of `html` with the edits taken out (edits are in order and do not overlap). */
function viewsOf(html: string, edits: readonly Edit[]): PageViews {
  const kinds = { template: false, comment: false, data: false };
  for (const edit of edits) kinds[edit.kind] = true;
  const build = (drops: (kind: EditKind) => boolean, any: boolean): string => {
    if (!any) return html;
    let out = "";
    let from = 0;
    for (const edit of edits) {
      if (!drops(edit.kind)) continue;
      out += html.slice(from, edit.start);
      from = edit.end;
    }
    return out + html.slice(from);
  };
  return {
    markup: build((k) => k === "template", kinds.template),
    clean: build(() => true, kinds.template || kinds.comment || kinds.data),
    commented: build((k) => k !== "comment", kinds.template || kinds.data),
  };
}
