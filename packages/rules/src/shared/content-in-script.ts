// Page content inside a JavaScript chunk (squirrelscan/squirrelscan#1200).
//
// A site that imports its MDX or Markdown bodies eagerly (`import.meta.glob`),
// or imports CMS JSON at build time, compiles the text of its pages into the
// client bundle. The HTML is already server-rendered, so every visitor downloads
// the content twice, and the entry chunk carries every other page's text too.
//
// Black-box detection: while a page's DOM is live, take a few distinctive
// sentences of its main content ({@link extractContentSentences}); in the site
// pass, search each large same-origin chunk for them ({@link findNeedles}).
// Compiled output hides text behind JavaScript string escapes, HTML entities and
// JSX, so the chunk is first decoded once ({@link normalizeScriptText}) and both
// sides are compared as whitespace-collapsed plain text.
//
// Everything here reads untrusted input and is bounded: the DOM walk visits a
// capped number of nodes, the sentences kept per page are few and short, the
// decoder is one linear pass with a fixed lookahead, and a chunk over
// {@link MAX_CHUNK_CHARS} is not searched at all. No pattern runs over a chunk.

import type { ParsedPage } from "../types";

import { documentBody } from "./framework-payload";

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
/** Characters of one text node read: a sentence is judged on its first few hundred. */
const MAX_TEXT_NODE_CHARS = 4096;
/** Candidate sentences collected per page before the best are picked. */
const MAX_CANDIDATES = 5000;
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
  const body = documentBody(doc);
  if (roots.length === 0 && !body) return [];

  const candidates: Array<{ text: string; order: number }> = [];
  let visited = 0;
  let order = 0;
  const stack: Node[] = roots.length > 0 ? [...roots].reverse() : [body!];
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop()!;
    visited++;
    if (node.nodeType === 3) {
      const raw = node.textContent ?? "";
      const text = collapse(raw.length > MAX_TEXT_NODE_CHARS ? raw.slice(0, MAX_TEXT_NODE_CHARS) : raw);
      if (text.length >= MIN_SENTENCE_CHARS && candidates.length < MAX_CANDIDATES) {
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

/** Longest `&...;` entity body looked ahead for, and the most characters ever read ahead of an `&` or `\\u{`. */
const MAX_ENTITY = 10;

const hexValue = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;

const isSpaceCode = (c: number): boolean =>
  c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 11 || c === 160 || c === 0x2028 || c === 0x2029;

/** A whole code point written as UTF-16 code units into `out` at `pos`; returns the new position. */
function putCodePoint(out: Uint16Array, pos: number, value: number): number {
  if (value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return pos;
  if (value >= 0x10000) {
    const v = value - 0x10000;
    out[pos++] = 0xd800 + (v >> 10);
    out[pos++] = 0xdc00 + (v & 0x3ff);
  } else out[pos++] = value;
  return pos;
}

/**
 * The chunk as plain text for matching: JavaScript string escapes decoded
 * (`\n`, `\t`, `\"`, `\'`, `\/`, `\xNN`, `\uNNNN`, `\u{N}`), HTML entities
 * decoded (named, `&#N;`, `&#xN;`) and every whitespace run collapsed to one
 * space. Returns null when the chunk is over {@link MAX_CHUNK_CHARS}: it is not
 * searched.
 *
 * Work is linear in the chunk and the memory is two bytes per input character:
 * the output is written into one preallocated buffer (a decoded sequence is
 * never longer than its source), each character is visited once, and the only
 * lookahead is a fixed few characters past a `&` or `\u{`, so no input shape
 * (millions of `&`, `\`, or `\u{`) makes it quadratic.
 *
 * A single level of escaping is undone. Text a bundler double-escapes (JSON
 * inside a string literal) is only half decoded and may not match.
 */
export function normalizeScriptText(content: string): string | null {
  const n = content.length;
  if (n > MAX_CHUNK_CHARS) return null;
  const out = new Uint16Array(n + 1);
  let pos = 0;
  let lastSpace = true;
  const put = (code: number) => {
    if (isSpaceCode(code)) {
      if (lastSpace) return;
      lastSpace = true;
      out[pos++] = 32;
    } else {
      lastSpace = false;
      out[pos++] = code;
    }
  };
  const putPoint = (value: number) => {
    const before = pos;
    pos = putCodePoint(out, pos, value);
    if (pos > before) lastSpace = false;
  };

  let i = 0;
  while (i < n) {
    const c = content.charCodeAt(i);
    if (c === 92 /* \ */ && i + 1 < n) {
      const e = content.charCodeAt(i + 1);
      let consumed = 2;
      if (e === 110 || e === 114 || e === 116 || e === 102 || e === 118) put(32); // n r t f v
      else if (e === 10 || e === 13) {
        // line continuation: nothing
      } else if (e === 117 /* u */) {
        if (content.charCodeAt(i + 2) === 123 /* { */) {
          let value = 0;
          let j = i + 3;
          let digits = 0;
          while (j < n && digits <= 8) {
            const h = hexValue(content.charCodeAt(j));
            if (h < 0) break;
            value = value * 16 + h;
            digits++;
            j++;
          }
          if (digits > 0 && digits <= 8 && content.charCodeAt(j) === 125 /* } */) {
            putPoint(value);
            consumed = j - i + 1;
          } else put(117);
        } else {
          const h0 = hexValue(content.charCodeAt(i + 2));
          const h1 = hexValue(content.charCodeAt(i + 3));
          const h2 = hexValue(content.charCodeAt(i + 4));
          const h3 = hexValue(content.charCodeAt(i + 5));
          if (h0 >= 0 && h1 >= 0 && h2 >= 0 && h3 >= 0) {
            put((h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
            consumed = 6;
          } else put(117);
        }
      } else if (e === 120 /* x */) {
        const h0 = hexValue(content.charCodeAt(i + 2));
        const h1 = hexValue(content.charCodeAt(i + 3));
        if (h0 >= 0 && h1 >= 0) {
          put((h0 << 4) | h1);
          consumed = 4;
        } else put(120);
      } else put(e); // \" \' \/ \\ and anything else: the character itself
      i += consumed;
      continue;
    }
    if (c === 38 /* & */) {
      // Look at most MAX_ENTITY characters ahead for the closing `;`.
      let semi = -1;
      const limit = Math.min(n, i + 2 + MAX_ENTITY);
      for (let j = i + 1; j < limit; j++) {
        if (content.charCodeAt(j) === 59) {
          semi = j;
          break;
        }
      }
      if (semi > i + 1) {
        const body = content.slice(i + 1, semi);
        let decoded: number | undefined;
        if (body.charCodeAt(0) === 35 /* # */) {
          const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
          let value = 0;
          let ok = body.length > (hex ? 2 : 1);
          for (let j = hex ? 2 : 1; j < body.length && ok; j++) {
            const d = hex ? hexValue(body.charCodeAt(j)) : body.charCodeAt(j) - 48;
            if (d < 0 || d > 15 || (!hex && d > 9)) ok = false;
            else value = value * (hex ? 16 : 10) + d;
          }
          if (ok) decoded = value;
        } else {
          const named = NAMED_ENTITIES[body];
          if (named !== undefined) decoded = named.codePointAt(0);
        }
        if (decoded !== undefined) {
          if (isSpaceCode(decoded)) put(32);
          else putPoint(decoded);
          i = semi + 1;
          continue;
        }
      }
    }
    put(c);
    i++;
  }

  // Back to a string in slices, so no argument list is larger than the engine allows.
  const pieces: string[] = [];
  for (let k = 0; k < pos; k += 8192) {
    pieces.push(String.fromCharCode.apply(null, out.subarray(k, Math.min(pos, k + 8192)) as unknown as number[]));
  }
  return pieces.join("");
}

/** A page's sentences in the form {@link findNeedles} compares: decoded the same way the chunk is. */
export function sentenceNeedle(sentence: string): string {
  return normalizeScriptText(sentence)?.trim() ?? "";
}

/** Window length hashed. Needles are at least 60 characters before decoding, so they are always longer than this. */
const WINDOW = 24;
const HASH_BASE = 1_000_003;
/** Verified candidate positions allowed per search: bounds the cost of a haystack built to collide. */
export const MAX_VERIFICATIONS = 100_000;

export interface NeedleIndex {
  /** Needle prefixes by the hash of their first {@link WINDOW} characters. */
  byHash: Map<number, string[]>;
  /** Distinct needles indexed. */
  size: number;
}

/** Hash of the first WINDOW characters of `text`. */
function prefixHash(text: string): number {
  let h = 0;
  for (let i = 0; i < WINDOW; i++) h = (Math.imul(h, HASH_BASE) + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Needles shorter than the window cannot be indexed and are left out. */
export function buildNeedleIndex(needles: Iterable<string>): NeedleIndex {
  const byHash = new Map<number, string[]>();
  let size = 0;
  const seen = new Set<string>();
  for (const needle of needles) {
    if (needle.length < WINDOW || seen.has(needle)) continue;
    seen.add(needle);
    const hash = prefixHash(needle);
    const bucket = byHash.get(hash);
    if (bucket) bucket.push(needle);
    else byHash.set(hash, [needle]);
    size++;
  }
  return { byHash, size };
}

export interface NeedleSearch {
  found: Set<string>;
  /** Positions of the haystack hashed. */
  positions: number;
  /** Candidate positions compared in full. */
  verifications: number;
  /** The search stopped at the deadline or the verification cap before the end of the chunk. */
  truncated: boolean;
}

/**
 * Which needles occur in `haystack`, in ONE pass over it whatever the number of
 * needles: a rolling hash of every {@link WINDOW}-character window is looked up
 * among the needles' prefix hashes, and only a hit is compared in full (at most
 * {@link MAX_VERIFICATIONS} of them). O(haystack) time, O(needles) memory.
 * Stops early once every needle is found, or at `deadlineMs` (a
 * `performance.now()` value; checked every 65 536 positions).
 */
export function findNeedles(haystack: string, index: NeedleIndex, deadlineMs = Number.POSITIVE_INFINITY): NeedleSearch {
  const found = new Set<string>();
  const result: NeedleSearch = { found, positions: 0, verifications: 0, truncated: false };
  const n = haystack.length;
  if (index.size === 0 || n < WINDOW) return result;

  // BASE^WINDOW mod 2^32, to take the outgoing character off the hash.
  let power = 1;
  for (let i = 0; i < WINDOW; i++) power = Math.imul(power, HASH_BASE);

  let h = 0;
  for (let i = 0; i < WINDOW; i++) h = (Math.imul(h, HASH_BASE) + haystack.charCodeAt(i)) | 0;

  for (let start = 0; ; start++) {
    result.positions++;
    const bucket = index.byHash.get(h >>> 0);
    if (bucket) {
      for (const needle of bucket) {
        if (found.has(needle)) continue;
        if (result.verifications >= MAX_VERIFICATIONS) {
          result.truncated = true;
          return result;
        }
        result.verifications++;
        if (haystack.startsWith(needle, start)) found.add(needle);
      }
      if (found.size === index.size) return result;
    }
    const next = start + WINDOW;
    if (next >= n) return result;
    h = (Math.imul(h, HASH_BASE) + haystack.charCodeAt(next) - Math.imul(haystack.charCodeAt(start), power)) | 0;
    if ((start & 0xffff) === 0xffff && performance.now() > deadlineMs) {
      result.truncated = true;
      return result;
    }
  }
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
