// Page content inside a JavaScript chunk (squirrelscan/squirrelscan#1200).
//
// A site that imports its MDX or Markdown bodies eagerly (`import.meta.glob`),
// or imports CMS JSON at build time, compiles the text of its pages into the
// client bundle. The HTML is already server-rendered, so every visitor downloads
// the content twice, and the entry chunk carries every other page's text too.
//
// Black-box detection: while a page's DOM is live, take a few distinctive
// sentences of its main content ({@link extractContentSentences}); in the site
// pass, search each large same-origin chunk for them ({@link countSentencesIn}).
// Compiled output hides text behind JavaScript string escapes, HTML entities and
// JSX, so the chunk is first decoded once ({@link normalizeScriptText}) and both
// sides are compared as whitespace-collapsed plain text.
//
// Everything here reads untrusted input and is bounded: the DOM walk visits a
// capped number of nodes, the sentences kept per page are few and short, the
// decoder is one linear pass with a fixed lookahead, and a chunk over
// {@link MAX_CHUNK_CHARS} is not searched at all. No pattern runs over a chunk.

import type { ParsedPage } from "../types";

type Doc = NonNullable<ParsedPage["document"]>;

/** Sentences kept per page. Three have to be found, so five leaves room for chrome that slipped through. */
export const SENTENCES_PER_PAGE = 5;
/** A sentence is a single text node of at least this many words. */
export const MIN_SENTENCE_WORDS = 10;
/** ...and at least this many characters once whitespace is collapsed. */
const MIN_SENTENCE_CHARS = 60;
/** Characters of a sentence kept: a prefix is enough to find it, and bounds the record. */
const MAX_SENTENCE_CHARS = 200;
/** DOM nodes visited per page. */
const MAX_NODES = 100_000;
/** A chunk longer than this (in characters, after fetch) is not searched. The script fetch caps bodies at 5 MB. */
export const MAX_CHUNK_CHARS = 8 * 1024 * 1024;

/** Containers whose text is site chrome, not the page's own content. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form", "menu"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);
/** Elements whose text is not prose: code and markup the page carries. */
const SKIP_TAGS = new Set(["script", "style", "template", "noscript", "pre", "code", "textarea", "svg", "math"]);

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function isChrome(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (CHROME_TAGS.has(tag)) return true;
  const role = el.getAttribute("role");
  return role !== null && CHROME_ROLES.has(role.toLowerCase());
}

/**
 * Up to {@link SENTENCES_PER_PAGE} distinctive sentences of the page's main
 * content: the longest text nodes of ten or more words, in document order.
 * Taken from `<main>`, `<article>` or `[role=main]` when the page has one, else
 * from the body outside navigation, header, footer, aside and form landmarks.
 * Each is a single text node, so inline links and emphasis around it (which a
 * compiled component renders as separate children) do not split a match.
 */
export function extractContentSentences(doc: Doc): string[] {
  const roots = Array.from(doc.querySelectorAll("main, article, [role=main]")).slice(0, 8);
  const body = doc.body ?? doc.documentElement;
  if (roots.length === 0 && !body) return [];

  const candidates: Array<{ text: string; order: number }> = [];
  let visited = 0;
  let order = 0;
  const stack: Node[] = roots.length > 0 ? [...roots].reverse() : [body!];
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop()!;
    visited++;
    if (node.nodeType === 3) {
      const text = collapse(node.textContent ?? "");
      if (text.length >= MIN_SENTENCE_CHARS) {
        const words = text.split(" ").length;
        if (words >= MIN_SENTENCE_WORDS) candidates.push({ text: text.slice(0, MAX_SENTENCE_CHARS), order: order++ });
      }
    } else if (node.nodeType === 1) {
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName.toLowerCase()) || isChrome(el)) continue;
      const children = el.childNodes;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }

  const picked = candidates
    .sort((a, b) => b.text.length - a.text.length || a.order - b.order)
    .slice(0, SENTENCES_PER_PAGE)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.text);
  return [...new Set(picked)];
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

/** Longest `&...;` entity body looked ahead for. */
const MAX_ENTITY = 10;

const isHex = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function codePoint(value: number): string {
  return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "";
}

/**
 * The chunk as plain text for matching: JavaScript string escapes decoded
 * (`\n`, `\t`, `\"`, `\'`, `\/`, `\xNN`, `\uNNNN`, `\u{N}`), HTML entities
 * decoded (named, `&#N;`, `&#xN;`) and every whitespace run collapsed to one
 * space. One linear pass with a fixed lookahead. Returns null when the chunk is
 * over {@link MAX_CHUNK_CHARS}: it is not searched.
 *
 * A single level of escaping is undone. Text a bundler double-escapes (JSON
 * inside a string literal) is only half decoded and may not match.
 */
export function normalizeScriptText(content: string): string | null {
  if (content.length > MAX_CHUNK_CHARS) return null;
  const parts: string[] = [];
  let start = 0;
  let lastSpace = true;
  const n = content.length;
  const flush = (end: number) => {
    if (end > start) parts.push(content.slice(start, end));
  };
  const emit = (text: string) => {
    if (text === " ") {
      if (lastSpace) return;
      lastSpace = true;
    } else if (text.length > 0) {
      lastSpace = false;
    }
    parts.push(text);
  };

  let i = 0;
  while (i < n) {
    const c = content.charCodeAt(i);
    if (c === 92 /* \ */ && i + 1 < n) {
      flush(i);
      const e = content[i + 1]!;
      let consumed = 2;
      let out: string;
      if (e === "n" || e === "r" || e === "t" || e === "f" || e === "v") out = " ";
      else if (e === "\n" || e === "\r") out = ""; // line continuation
      else if (e === "u") {
        if (content[i + 2] === "{") {
          const close = content.indexOf("}", i + 3);
          const hex = close > i && close - i <= 10 ? content.slice(i + 3, close) : "";
          out = hex !== "" && /^[0-9a-fA-F]+$/.test(hex) ? codePoint(Number.parseInt(hex, 16)) : "u";
          if (hex !== "" && out !== "u") consumed = close - i + 1;
        } else if (i + 5 < n && isHex(content.charCodeAt(i + 2)) && isHex(content.charCodeAt(i + 3)) && isHex(content.charCodeAt(i + 4)) && isHex(content.charCodeAt(i + 5))) {
          out = String.fromCharCode(Number.parseInt(content.slice(i + 2, i + 6), 16));
          consumed = 6;
        } else out = "u";
      } else if (e === "x" && i + 3 < n && isHex(content.charCodeAt(i + 2)) && isHex(content.charCodeAt(i + 3))) {
        out = String.fromCharCode(Number.parseInt(content.slice(i + 2, i + 4), 16));
        consumed = 4;
      } else out = e; // \" \' \/ \\ and anything else: the character itself
      emit(/\s/.test(out) ? " " : out);
      i += consumed;
      start = i;
      continue;
    }
    if (c === 38 /* & */) {
      const semi = content.indexOf(";", i + 1);
      if (semi > i && semi - i <= MAX_ENTITY) {
        const body = content.slice(i + 1, semi);
        let out: string | undefined;
        if (body[0] === "#") {
          const hex = body[1] === "x" || body[1] === "X";
          const digits = body.slice(hex ? 2 : 1);
          if (digits !== "" && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
            out = codePoint(Number.parseInt(digits, hex ? 16 : 10));
          }
        } else out = NAMED_ENTITIES[body];
        if (out !== undefined) {
          flush(i);
          emit(/\s/.test(out) ? " " : out);
          i = semi + 1;
          start = i;
          continue;
        }
      }
    }
    if (c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 160 || c === 0x2028 || c === 0x2029) {
      // A whitespace run: keep one space.
      flush(i);
      emit(" ");
      i++;
      while (i < n) {
        const d = content.charCodeAt(i);
        if (d === 32 || d === 10 || d === 13 || d === 9 || d === 12 || d === 160) i++;
        else break;
      }
      start = i;
      continue;
    }
    lastSpace = false;
    i++;
  }
  flush(n);
  return parts.join("");
}

/** How many of `sentences` (already normalised with {@link collapse}) occur in the decoded chunk. */
export function countSentencesIn(haystack: string, sentences: readonly string[]): number {
  let found = 0;
  for (const sentence of sentences) {
    if (sentence.length > 0 && haystack.includes(sentence)) found++;
  }
  return found;
}

/** A page's sentences in the form {@link countSentencesIn} compares: decoded the same way the chunk is. */
export function sentenceNeedle(sentence: string): string {
  return normalizeScriptText(sentence)?.trim() ?? "";
}

const isProseChar = (c: number): boolean =>
  c === 32 ||
  (c >= 48 && c <= 57) ||
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  c > 127 ||
  c === 46 || // .
  c === 44 || // ,
  c === 39 || // '
  c === 58 || // :
  c === 33 || // !
  c === 63 || // ?
  c === 45 || // -
  c === 40 || // (
  c === 41; // )

/** The shortest run counted as prose, in characters. Code rarely holds 120 plain characters with spaces. */
const MIN_PROSE_RUN = 120;

/**
 * An estimate of how much of the decoded chunk is prose: the share of
 * characters in long runs of plain text with a word-like share of spaces.
 * Minified code is dense in braces, `=` and `;` and breaks into short runs, so
 * a chunk that is mostly compiled copy scores high and ordinary application
 * code scores near zero. An estimate, and reported as one.
 */
export function estimateProseShare(decoded: string): number {
  const n = decoded.length;
  if (n === 0) return 0;
  let prose = 0;
  let runStart = 0;
  let spaces = 0;
  const closeRun = (end: number) => {
    const length = end - runStart;
    if (length >= MIN_PROSE_RUN && spaces / length >= 0.1 && spaces / length <= 0.3) prose += length;
  };
  for (let i = 0; i < n; i++) {
    if (isProseChar(decoded.charCodeAt(i))) {
      if (decoded.charCodeAt(i) === 32) spaces++;
    } else {
      closeRun(i);
      runStart = i + 1;
      spaces = 0;
    }
  }
  closeRun(n);
  return prose / n;
}

/**
 * The gzip size of `text`, or undefined when the runtime has no
 * CompressionStream. Only called for a chunk already flagged, and bounded by
 * {@link MAX_CHUNK_CHARS}.
 */
export async function gzipSize(text: string): Promise<number | undefined> {
  if (typeof CompressionStream === "undefined") return undefined;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
  } catch {
    return undefined;
  }
}
