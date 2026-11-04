import type {
  DetectedTechnology,
  Detector,
  ScriptMatchValidator,
  TechDetectInput,
  TechFingerprint,
} from "./types";
import { ALL_FINGERPRINTS } from "./fingerprints";
import { flightLoaderText, hasFlightChunk } from "./flight";
import { COLLECTED_TAGS } from "./collected-tags";
import { inString, scanJs, skipStart, stringEnd, type ScannedJs } from "./js-scan";
import { isScriptTextString } from "./script-text";

/**
 * Default wall-clock budget for one detectTechnologies call (one page). A caller
 * that reads whole bundles (the local scan) passes a longer one; running out of
 * time is reported through `onBudgetExceeded`, never silent.
 */
export const TECH_DETECT_PAGE_BUDGET_MS = 5_000;

/**
 * Candidate matches an `inCode` detector inspects before giving up. A candidate is a pattern match that starts
 * inside a string (a docs snippet, a product named in prose): a whole bundle holds many before the real one. The
 * search moves on past the string a candidate was in, so many mentions inside one string are one candidate, and
 * the matches go forward over the body once, so the bound is on the work per detector, not on correctness: it is
 * high enough that a whole bundle's real match is reached (#1422).
 */
const MAX_IN_CODE_CANDIDATES = 4_096;

/**
 * Longest slice of one script body a caller gets matched, in characters, unless it asks for more
 * (`DetectOptions.maxScriptChars`). The cloud services that run this package over bodies a client
 * sent, and over a hostile audited site's bundles, rely on it: only the local scan, which reads
 * what the user's own crawl fetched, passes a larger value.
 */
export const TECH_SCRIPT_CONTENT_LIMIT = 256 * 1024;

export interface DetectOptions {
  /** Stop evaluating fingerprints once this much time has passed. */
  budgetMs?: number;
  /** Match at most this many characters of each script body; default {@link TECH_SCRIPT_CONTENT_LIMIT}. */
  maxScriptChars?: number;
  /** Called once when the budget cut the scan short. */
  onBudgetExceeded?: () => void;
}

interface ScriptView {
  head: string;
  scanned?: ScannedJs;
}

function scriptView(views: Map<string, ScriptView>, content: string, maxChars: number): ScriptView {
  let view = views.get(content);
  if (!view) {
    view = { head: content.length > maxChars ? content.slice(0, maxChars) : content };
    views.set(content, view);
  }
  return view;
}

function matchesInCode(
  pattern: RegExp,
  view: ScriptView,
  validate?: ScriptMatchValidator,
  stringValue?: RegExp,
): boolean {
  view.scanned ??= scanJs(view.head);
  const { code, strings, skips } = view.scanned;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  for (let seen = 0; seen < MAX_IN_CODE_CANDIDATES; seen++) {
    const m = re.exec(code);
    if (!m) return false;
    if (!inString(strings, m.index)) {
      if (!validate || validate(m)) return true;
      if (m[0].length === 0) re.lastIndex++;
      continue;
    }
    // Nothing that starts inside this string can be code: continue after it.
    const end = stringEnd(strings, m.index);
    if (stringValue && end !== -1 && (!validate || validate(m)) && isScriptTextString(code, strings, skipStart(skips, m.index), end, stringValue)) return true;
    if (end >= re.lastIndex) re.lastIndex = end + 1;
    else if (m[0].length === 0) re.lastIndex++;
  }
  return false;
}

/**
 * The regions a browser neither runs nor shows (#1550), found by the page pass in `pageMarkup` and cut out of the text the `html`
 * detectors read: the body of a data script (any script the browser does not run: {@link scriptRuns}), the content of a `<template>`, and HTML
 * comments. `<style>` text is CSS evidence and stays. The page's own
 * `<script src>`, inline loaders and a comment a detector matches on purpose (see {@link readsComments}) are kept.
 *
 * Fail closed: a region is cut only when the pass saw both of its edges, so a comment with no `-->`, a `<template>` with no
 * `</template>`, a data script with no `</script` and everything after a tag over {@link MAX_TAG_CHARS} stay in the text. A
 * comment ends at `-->` or `--!>`, and `<!-->` and `<!--->` are empty comments. Raw-text elements (`<style>`, `<textarea>`,
 * `<title>`, `<xmp>`, `<iframe>`, `<noembed>`, `<noframes>`, and `<script>`) are skipped whole, so a `<template` or `<!--` inside
 * one opens nothing. `</template>` pairs innermost first with the `<template>` tags the pass read as tags, a self-closing `<template/>` included (HTML
 * ignores the slash on a non-void element); a declarative shadow root (`shadowrootmode` of `open` or `closed`, exactly, as the
 * first such attribute) is rendered, so it pairs but is not cut. SVG and MathML are not treated specially.
 */
interface InertRange {
  from: number;
  to: number;
  /** A comment (kept for the fingerprints that match one); every other region is cut from every view. */
  comment: boolean;
}

const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
const SHADOW_ROOT: ReadonlySet<string> = new Set(["shadowrootmode"]);
const SCRIPT_TYPE_ATTRS: ReadonlySet<string> = new Set(["type", "language"]);
const COMMENT_END = /--!?>/g;
const RAW_TEXT_CLOSERS: ReadonlyMap<string, RegExp> = new Map([...RAW_TEXT_TAGS].map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi")]));

const commentCache = new WeakMap<Detector, boolean>();
/**
 * Whether a detector reads HTML comments: a pattern that opens at `<!--` (a plugin banner), or an `html` detector marked `comments`
 * (Klaviyo's Shopify app block marker). Per detector, not per fingerprint: the same fingerprint's loader detectors still read the
 * page without comments, so a commented-out loader is no evidence.
 */
function readsComments(detector: Detector): boolean {
  let known = commentCache.get(detector);
  if (known === undefined) {
    known = (detector.type === "html" && detector.comments === true) || ("pattern" in detector && detector.pattern.source.includes("<!--"));
    commentCache.set(detector, known);
  }
  return known;
}

/** `html` without the `ranges` (sorted, non-overlapping), and without comments unless `keepComments`. */
function cutRanges(html: string, ranges: readonly InertRange[], keepComments: boolean): string {
  let out = "";
  let at = 0;
  for (const r of ranges) {
    if (r.comment && keepComments) continue;
    out += html.slice(at, r.from);
    at = r.to;
  }
  return out + html.slice(at);
}

/**
 * What `pageMarkup` keeps of a page: the tags that can name a script or a tracking URL (`script`, `link`,
 * `img`, `iframe`, `embed`, `object`, `source`), as written, and the text of each JavaScript `<script>` that
 * is short enough to be a loader snippet. Not kept: text between tags, comments, `<a>` and `<meta>` (a vendor
 * linked or described is not a vendor loaded), data blocks (`application/json`, JSON-LD, `__NEXT_DATA__`) and
 * the body of a script past {@link INLINE_LOADER_MAX_CHARS} (a whole inlined bundle names many URLs in strings
 * it never loads). A Next.js flight script is the exception only for the script elements it carries (#1437).
 */

/**
 * Whether a script body starts as a Next.js flight script: optional whitespace and comments, an optional `(`,
 * then `self.__next_f` or `self.__next_s`. A linear scan over the first characters, with no regular expression
 * (a comment-skipping pattern backtracked for a second on 512 characters of `/* x *\/` repeated).
 */
function flightKind(body: string): "f" | "s" | null {
  const head = body.slice(0, FLIGHT_SCRIPT_HEAD_CHARS);
  let i = 0;
  const skipSpace = (): void => {
    while (i < head.length && /\s/.test(head[i]!)) i++;
  };
  for (;;) {
    skipSpace();
    if (head.startsWith("/*", i)) {
      const end = head.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
    } else if (head.startsWith("//", i)) {
      const end = head.indexOf("\n", i + 2);
      if (end === -1) return null;
      i = end + 1;
    } else break;
  }
  if (head[i] === "(") {
    i++;
    skipSpace();
  }
  for (const [start, kind] of [
    ["self.__next_f", "f"],
    ["self.__next_s", "s"],
  ] as const) {
    if (head.startsWith(start, i)) {
      const next = head[i + start.length] ?? "";
      return /[A-Za-z0-9_$]/.test(next) ? null : kind;
    }
  }
  return null;
}

const URL_TAGS = new Set(["script", "link", "img", "iframe", "embed", "object", "source"]);
const INLINE_LOADER_MAX_CHARS = 16 * 1024;
/**
 * What the HTML spec's "JavaScript MIME type essence match" accepts, lower case: a script with one of these as its `type` is
 * classic JavaScript. The match is on the whole string (a `;charset=` parameter is not part of an essence, and Chrome does not
 * run `text/javascript;charset=utf-8` either), ASCII case-insensitive, after trimming ASCII whitespace.
 */
const JS_MIME_ESSENCES: ReadonlySet<string> = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
/**
 * Types a cache, CDN or consent tool gives a loader it runs itself later (LiteSpeed Cache, Cloudflare Rocket Loader's
 * `<hash>-text/javascript`, Partytown, a consent tool's `text/plain`; #1435). A browser alone does not run them, but the page does,
 * so their text stays evidence. Every other type that is not JavaScript is data (#1550).
 */
const DEFERRED_LOADER_TYPE = /^(?:litespeed\/javascript|text\/(?:plain|partytown)|[0-9a-f]{8,64}-text\/javascript)$/;
const isAsciiSpace = (code: number): boolean => code === 9 || code === 10 || code === 12 || code === 13 || code === 32;

/** `value` without leading and trailing ASCII whitespace (not `String.trim`, which also strips U+00A0 and the like). */
function asciiTrim(value: string): string {
  let from = 0;
  let to = value.length;
  while (from < to && isAsciiSpace(value.charCodeAt(from))) from++;
  while (to > from && isAsciiSpace(value.charCodeAt(to - 1))) to--;
  return value.slice(from, to);
}

/**
 * Whether a script of this `type` string runs, by the HTML spec: an empty type, `module`, a JavaScript MIME type essence (or a
 * {@link DEFERRED_LOADER_TYPE}). Anything else is data (JSON, JSON-LD, import maps, speculation rules, templates, `text/x-*`, a
 * custom type). A type with a character reference (`&`) is not decoded, so it cannot be proved data and counts as running.
 */
export function scriptTypeRuns(typeString: string): boolean {
  const type = asciiTrim(typeString.slice(0, 2048)).toLowerCase();
  return type === "" || type === "module" || type.includes("&") || JS_MIME_ESSENCES.has(type) || DEFERRED_LOADER_TYPE.test(type);
}

/** Whether a `<script>` with these attributes (`type`, `language`) runs: a `type` decides; else a `language` is the type `text/<language>`. */
function scriptRuns(attrs: ReadonlyMap<string, string>): boolean {
  const type = attrs.get("type");
  if (type !== undefined) return scriptTypeRuns(type);
  const language = attrs.get("language");
  return language === undefined || language === "" || scriptTypeRuns(`text/${language}`);
}
/**
 * A Next.js App Router flight script (`self.__next_f.push(...)`) carries the layout's `next/script` snippets as
 * strings, so it is decoded up to this size for the script elements it holds; any other script over the
 * inline cap is a bundle.
 */
const FLIGHT_SCRIPT_HEAD_CHARS = 512;
const FLIGHT_SCRIPT_MAX_CHARS = 2 * 1024 * 1024;
/** Inline script text read per page, all scripts together. */
const INLINE_TEXT_BUDGET = 8 * 1024 * 1024;
/**
 * An import map (`<script type="importmap">`) is data the browser resolves module specifiers with: its `imports` and `scopes`
 * string values are URLs the page loads as modules (`"three": "https://cdn.example/three.module.js"`). They are kept as script
 * URLs (#1539), bounded: a map of at most {@link IMPORTMAP_MAX_CHARS} characters (UTF-16 code units, not bytes), at most {@link IMPORTMAP_MAX_URLS_PER_MAP} URLs
 * a map and {@link IMPORTMAP_MAX_URLS_PER_PAGE} a page, {@link IMPORTMAP_MAX_URL_CHARS} characters a URL, and
 * {@link IMPORTMAP_MAX_MARKUP_CHARS} characters of synthetic tags a page. A URL past a bound, or one that could not be written as
 * the `src` of exactly one tag (a quote, angle bracket, backtick, backslash, whitespace (U+2028 and U+2029 included), a control character (C0, DEL, C1)
 * or a lone surrogate in it), or that is not an address (a scheme other than http and https, or a bare name), is not read.
 * It is counted internally in {@link pageImportMapSkipped} (no report carries it); the rest of the page is read as usual.
 */
const IMPORTMAP_MAX_CHARS = 64 * 1024;
const IMPORTMAP_MAX_URLS_PER_MAP = 256;
const IMPORTMAP_MAX_URLS_PER_PAGE = 512;
const IMPORTMAP_MAX_URL_CHARS = 2048;
const IMPORTMAP_MAX_MARKUP_CHARS = 64 * 1024;
const IMPORTMAP_UNSAFE_URL = /["'`<>\\\s\u0000-\u001f\u007f-\u009f]/;
/** A UTF-16 surrogate with no partner: not a character, and not something to write into a tag. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** What a browser accepts as an import map address: an http(s) URL, or a path starting with `/`, `./` or `../` (a bare name is not one). */
const IMPORTMAP_ADDRESS = /^(?:https?:\/\/|\.{0,2}\/)/i;

/** A URL value that is written as the `src` of one well-formed tag: http, https, protocol-relative or a relative path. */
function isImportMapUrl(value: string): boolean {
  if (value.length > IMPORTMAP_MAX_URL_CHARS || IMPORTMAP_UNSAFE_URL.test(value) || LONE_SURROGATE.test(value)) return false;
  return IMPORTMAP_ADDRESS.test(value);
}

/**
 * The URL strings an import map's `imports` and `scopes` map to, at most `limit` of them, and how many string values were left
 * out (a bound or an unsafe value). A map that is not JSON, or has no such object, has none.
 */
function importMapUrls(text: string, limit: number): { urls: string[]; skipped: number } {
  let map: unknown;
  try {
    map = JSON.parse(text);
  } catch {
    return { urls: [], skipped: 0 };
  }
  const urls: string[] = [];
  let skipped = 0;
  const isTable = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const take = (table: unknown): void => {
    if (!isTable(table)) return;
    for (const value of Object.values(table)) {
      if (typeof value !== "string") continue;
      if (urls.length >= limit || !isImportMapUrl(value)) skipped++;
      else urls.push(value);
    }
  };
  if (!isTable(map)) return { urls, skipped };
  take(map.imports);
  if (isTable(map.scopes)) for (const scope of Object.values(map.scopes)) take(scope);
  return { urls, skipped };
}

/** Longest tag read quote-aware; past it the first `>` ends the tag. */
const MAX_TAG_CHARS = 64 * 1024;

/** The index of the `>` that ends the tag starting at `open`, skipping quoted attribute values. */
function tagEnd(html: string, open: number): number {
  const limit = Math.min(html.length, open + MAX_TAG_CHARS);
  let i = open + 1;
  while (i < limit) {
    const ch = html.charCodeAt(i);
    if (ch === 62) return i; // >
    if (ch === 34 || ch === 39) {
      const close = html.indexOf(ch === 34 ? '"' : "'", i + 1);
      if (close === -1 || close >= limit) break;
      i = close + 1;
      continue;
    }
    i++;
  }
  return html.indexOf(">", open + 1);
}

/** A `<template>` start tag that is a declarative shadow root: its first `shadowrootmode` is exactly `open` or `closed` (ASCII case-insensitive, not trimmed). */
function isDeclarativeShadowRoot(tag: string): boolean {
  const mode = parseTagAttributes(tag.slice(0, MAX_TAG_CHARS), SHADOW_ROOT, false).get("shadowrootmode")?.toLowerCase();
  return mode === "open" || mode === "closed";
}

let lastMarkup:
  | { html: string; attrs: ReadonlySet<string>; markup: string; tags: CollectedTag[]; importMapSkipped: number; ranges: InertRange[]; views: Partial<Record<"clean" | "commented", string>> }
  | undefined;

/** A tag the page pass kept, with its attributes as written (names lower case, first wins). */
interface CollectedTag {
  tag: string;
  attrs: Map<string, string>;
}
/** How many tags (of `COLLECTED_TAGS`) and attributes per tag the page pass keeps. */
const MAX_COLLECTED_TAGS = 100_000;
const MAX_ATTRIBUTES_PER_TAG = 100;
const MAX_ATTRIBUTE_VALUE_CHARS = 2_048;

/**
 * The attributes of a start tag that some detector reads (`wanted`), in one linear pass: quoted, single-quoted or bare
 * values; names lower case; first wins (as in a browser). Other attributes are walked past, not kept: a page of tags
 * with a hundred attributes each must not cost a hundred map entries per tag. The walk itself is bounded.
 */
function parseTagAttributes(tag: string, wanted: ReadonlySet<string>, trim = true): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = tag.search(/[\s/]/);
  if (i === -1) return attrs;
  const n = tag.length;
  for (let seen = 0; i < n && seen < MAX_ATTRIBUTES_PER_TAG; seen++) {
    while (i < n && /[\s/]/.test(tag[i]!)) i++;
    if (i >= n || tag[i] === ">") break;
    const nameStart = i;
    while (i < n && !/[\s=/>]/.test(tag[i]!)) i++;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < n && /\s/.test(tag[i]!)) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < n && /\s/.test(tag[i]!)) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, i + 1);
        if (wanted.has(name) && !attrs.has(name)) value = tag.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else {
        const start = i;
        while (i < n && !/[\s>]/.test(tag[i]!)) i++;
        if (wanted.has(name) && !attrs.has(name)) value = tag.slice(start, i);
      }
    }
    if (name && wanted.has(name) && !attrs.has(name)) {
      const capped = value.length > MAX_ATTRIBUTE_VALUE_CHARS ? value.slice(0, MAX_ATTRIBUTE_VALUE_CHARS) : value;
      attrs.set(name, trim ? capped.trim() : capped);
    }
  }
  return attrs;
}

/**
 * The attribute names the `tag-attr` detectors of `fingerprints` read: all the page pass keeps of a tag. Computed once
 * per list. A signature list with no such detector keeps no attributes at all.
 */
const neededCache = new WeakMap<object, ReadonlySet<string>>();
function neededAttributes(fingerprints: readonly TechFingerprint[]): ReadonlySet<string> {
  const known = neededCache.get(fingerprints);
  if (known) return known;
  const names = new Set<string>();
  for (const fp of fingerprints) {
    for (const detector of fp.detectors) {
      if (detector.type === "tag-attr") for (const attr of detector.attrs) names.add(attr);
    }
  }
  neededCache.set(fingerprints, names);
  return names;
}

/** The attribute names the running `detectTechnologies` call reads (the built-in signatures' by default). */
let activeAttrs: ReadonlySet<string> | undefined;
const defaultAttrs = (): ReadonlySet<string> => (activeAttrs ??= neededAttributes(ALL_FINGERPRINTS));

/** Drop the page pass's result: it is per page, and a page's tags must not outlive the call that read them. */
export function releasePageMarkup(): void {
  lastMarkup = undefined;
}

export function pageMarkup(html: string): string {
  const wanted = defaultAttrs();
  if (lastMarkup?.html === html && lastMarkup.attrs === wanted) return lastMarkup.markup;
  const parts: string[] = [];
  const collected: CollectedTag[] = [];
  const flightBodies: string[] = [];
  /** The end tag of a script: `</script` and a tag name boundary (whitespace, `/` or `>`), so `</scriptx>` ends nothing. */
  const scriptEnd = /<\/script(?=[\t\n\f\r />])/gi;
  let inlineText = 0;
  let importMapSkipped = 0;
  let importMapUrlCount = 0;
  let importMapMarkup = 0;
  const ranges: InertRange[] = [];
  // Open `<template>` tags, innermost last; what the pass kept up to the tag is restored when a cut template closes.
  const templates: Array<{ contentStart: number; cut: boolean; parts: number; collected: number; flight: number; state: number[] }> = [];
  /** Open `<template>`s whose content a browser keeps inert (every one but a declarative shadow root). */
  let openCut = 0;
  // Where the import map entries read while such a template was open sit in `parts` and `collected` (ascending). A template that
  // closes takes them back with the rest of its content; one still open at the end of the page never rendered them: they are
  // dropped there, unless a tag over the limit means the pass could not tell where the template ends.
  const mapParts: number[] = [];
  const mapCollected: number[] = [];
  const rawMissing = new Set<string>();
  /** Set by a tag over {@link MAX_TAG_CHARS}: the pass can no longer prove where a region ends, so it cuts nothing more. */
  let halted = false;
  let pos = 0;
  for (;;) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      let end: number;
      if (html.startsWith(">", open + 4)) end = open + 5;
      else if (html.startsWith("->", open + 4)) end = open + 6;
      else {
        COMMENT_END.lastIndex = open + 4;
        const found = COMMENT_END.exec(html);
        if (!found) break; // an unterminated comment: the rest of the page stays, as written
        end = found.index + found[0].length;
      }
      if (!halted) ranges.push({ from: open, to: end, comment: true });
      pos = end;
      continue;
    }
    const close = tagEnd(html, open);
    if (close - open >= MAX_TAG_CHARS) halted = true;
    if (close === -1) {
      const rest = html.slice(open);
      const lone = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)?.[1]?.toLowerCase();
      if (lone && URL_TAGS.has(lone)) parts.push(rest);
      break;
    }
    const tag = html.slice(open, close + 1);
    pos = close + 1;
    const name = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (!name) continue;
    const tagName = name[2]!.toLowerCase();
    // Template content is inert (#1539, #1550): what the pass kept inside a template that closes is taken back. A `<template/>`
    // opens one too: HTML ignores the self-closing slash on a non-void element.
    if (tagName === "template") {
      if (name[1] === "/") {
        const t = templates.pop();
        if (t?.cut) openCut--;
        if (t && t.cut && !halted) {
          parts.length = t.parts;
          collected.length = t.collected;
          flightBodies.length = t.flight;
          while (mapParts.length > 0 && mapParts[mapParts.length - 1]! >= t.parts) mapParts.pop();
          while (mapCollected.length > 0 && mapCollected[mapCollected.length - 1]! >= t.collected) mapCollected.pop();
          [inlineText, importMapSkipped, importMapUrlCount, importMapMarkup] = t.state as [number, number, number, number];
          while (ranges.length > 0 && ranges[ranges.length - 1]!.from >= t.contentStart) ranges.pop();
          ranges.push({ from: t.contentStart, to: open, comment: false });
        }
      } else {
        const cut = !isDeclarativeShadowRoot(tag);
        if (cut) openCut++;
        templates.push({ contentStart: pos, cut, parts: parts.length, collected: collected.length, flight: flightBodies.length, state: [inlineText, importMapSkipped, importMapUrlCount, importMapMarkup] });
      }
    }
    if (name[1] === "/") continue;
    if (COLLECTED_TAGS.has(tagName) && collected.length < MAX_COLLECTED_TAGS) {
      const attrs = parseTagAttributes(tag.length > MAX_TAG_CHARS ? tag.slice(0, MAX_TAG_CHARS) : tag, wanted);
      if (attrs.size > 0) collected.push({ tag: tagName, attrs });
    }
    if (tagName === "script" && !tag.endsWith("/>")) {
      scriptEnd.lastIndex = pos;
      const endMatch = scriptEnd.exec(html);
      const end = endMatch?.index ?? html.length;
      parts.push(tag);
      const scriptAttrs = parseTagAttributes(tag.slice(0, MAX_TAG_CHARS), SCRIPT_TYPE_ATTRS);
      const type = scriptAttrs.get("type") ?? "";
      const runs = scriptRuns(scriptAttrs);
      const length = end - pos;
      // A script the browser does not run is data: its text is not read by the `html` detectors either; an unclosed one stays.
      if (length > 0 && endMatch && !halted && !runs) ranges.push({ from: pos, to: end, comment: false });
      if (length > 0 && /^importmap$/i.test(asciiTrim(type).slice(0, 32))) {
        // The page loads these as modules: each is a script URL, for the URL patterns (as one tag in the markup) and for the
        // tag attribute detectors (as a collected script). The map itself stays out of the markup: it is data.
        if (length > IMPORTMAP_MAX_CHARS) importMapSkipped++;
        else {
          const { urls, skipped } = importMapUrls(html.slice(pos, end), Math.min(IMPORTMAP_MAX_URLS_PER_MAP, IMPORTMAP_MAX_URLS_PER_PAGE - importMapUrlCount));
          importMapSkipped += skipped;
          for (const url of urls) {
            const synthetic = `<script type="module" src="${url}"></script>`;
            if (importMapMarkup + synthetic.length > IMPORTMAP_MAX_MARKUP_CHARS) {
              importMapSkipped++;
              continue;
            }
            importMapMarkup += synthetic.length;
            importMapUrlCount++;
            if (openCut > 0) mapParts.push(parts.length);
            parts.push(synthetic);
            if (collected.length < MAX_COLLECTED_TAGS && wanted.has("src")) {
              if (openCut > 0) mapCollected.push(collected.length);
              collected.push({ tag: "script", attrs: new Map([["src", url]]) });
            }
          }
        }
      }
      if (length > 0 && runs && inlineText < INLINE_TEXT_BUDGET) {
        const head = html.slice(pos, Math.min(end, pos + 512));
        // A flight script (`self.__next_f`) is read with the page's other flight scripts, for the script
        // elements they carry, not as text (#1437). One with no readable chunk is read like any other script.
        const flight = flightKind(head) === "f";
        if (flight && hasFlightChunk(html.slice(pos, Math.min(end, pos + FLIGHT_SCRIPT_MAX_CHARS)))) {
          const take = Math.min(length, FLIGHT_SCRIPT_MAX_CHARS, INLINE_TEXT_BUDGET - inlineText);
          flightBodies.push(html.slice(pos, pos + take));
          inlineText += take;
        } else if (length <= INLINE_LOADER_MAX_CHARS) {
          const take = Math.min(length, INLINE_TEXT_BUDGET - inlineText);
          parts.push(html.slice(pos, pos + take));
          inlineText += take;
        }
      }
      pos = end;
    } else if (URL_TAGS.has(tagName)) {
      parts.push(tag);
    }
    // Raw text (style, textarea, title...) has no markup in it: a `<template` or `<!--` there opens nothing. No closer, no skip.
    if (RAW_TEXT_TAGS.has(tagName) && !rawMissing.has(tagName)) {
      const closer = RAW_TEXT_CLOSERS.get(tagName)!;
      closer.lastIndex = pos;
      const found = closer.exec(html);
      if (found) pos = found.index;
      else rawMissing.add(tagName);
    }
  }
  if (!halted && (mapParts.length > 0 || mapCollected.length > 0)) {
    const dropParts = new Set(mapParts);
    const dropCollected = new Set(mapCollected);
    const keptParts = parts.filter((_, i) => !dropParts.has(i));
    parts.length = 0;
    parts.push(...keptParts);
    const keptCollected = collected.filter((_, i) => !dropCollected.has(i));
    collected.length = 0;
    collected.push(...keptCollected);
  }
  if (flightBodies.length > 0) parts.push(flightLoaderText(flightBodies, (t) => !scriptTypeRuns(t)));
  const markup = parts.join("\n");
  lastMarkup = { html, attrs: wanted, markup, tags: collected, importMapSkipped, ranges, views: {} };
  return markup;
}

/**
 * The page's HTML the `html` detectors read: without the inert regions (data script bodies, `<template>` content) and, unless
 * `keepComments`, without comments. Built once per page and view from the ranges the single page pass found.
 */
function pageHtml(html: string, keepComments: boolean): string {
  pageMarkup(html);
  const page = lastMarkup;
  if (!page || page.ranges.length === 0) return html;
  const key = keepComments ? "commented" : "clean";
  return (page.views[key] ??= cutRanges(html, page.ranges, keepComments));
}

/** How many import map entries (a bound, an unsafe value, a map over its size) the page pass left out: see {@link IMPORTMAP_MAX_CHARS}. */
export function pageImportMapSkipped(html: string): number {
  pageMarkup(html);
  return lastMarkup?.importMapSkipped ?? 0;
}

/** The tags a page pass kept (see {@link COLLECTED_TAGS}), found in the same single pass as {@link pageMarkup}. */
function pageTags(html: string): CollectedTag[] {
  pageMarkup(html);
  return lastMarkup?.tags ?? [];
}

function matchesTagAttr(detector: Extract<Detector, { type: "tag-attr" }>, html: string): boolean {
  for (const entry of pageTags(html)) {
    if (!detector.tags.includes(entry.tag)) continue;
    for (const attr of detector.attrs) {
      const value = entry.attrs.get(attr);
      if (value === undefined) continue;
      if (detector.pattern.test(value)) return true;
      if (detector.tokens) {
        for (const token of value.split(/[\s,]+/)) if (token && detector.pattern.test(token)) return true;
      }
    }
  }
  return false;
}

function matchDetector(
  detector: Detector,
  input: TechDetectInput,
  html: string,
  views: Map<string, ScriptView>,
  maxChars: number,
): boolean {
  switch (detector.type) {
    case "header": {
      const value = input.headers[detector.name] ?? input.headers[detector.name.toLowerCase()];
      return value != null && detector.pattern.test(value);
    }
    case "meta": {
      const value = input.meta?.[detector.name] ?? input.meta?.[detector.name.toLowerCase()];
      return value != null && detector.pattern.test(value);
    }
    case "script-url":
      // The listed URLs, and the page's own markup: an inline loader builds its URL inside a `<script>` and
      // has no `src` to list. The same page gives the same answer with or without script bodies attached.
      if (input.scripts?.some((s) => s.url && detector.pattern.test(s.url))) return true;
      return detector.pattern.test(pageMarkup(input.html));
    case "script-content":
      if (detector.inCode) {
        return (
          input.scripts?.some(
            (s) =>
              s.content &&
              matchesInCode(
                detector.pattern,
                scriptView(views, s.content, maxChars),
                detector.validate,
                detector.stringValue,
              ) &&
              (!detector.also || detector.also.pattern.test(scriptView(views, s.content, maxChars).head)),
          ) ?? false
        );
      }
      if (
        input.scripts?.some(
          (s) => s.content && detector.pattern.test(scriptView(views, s.content, maxChars).head),
        )
      ) {
        return true;
      }
      // Inline scripts live in the HTML, not the fetched `scripts` array — scan
      // it too so inline init snippets (window._taboola=…, obApi(…)) match.
      // Patterns are JS-specific (global assignments / vendor calls), so the
      // false-positive risk from scanning full HTML is negligible.
      return detector.pattern.test(html);
    case "html":
      if (detector.requires && !html.includes(detector.requires)) return false;
      return detector.pattern.test(html);
    case "dom":
      // DOM selectors need a document — skip in headerless detection
      return false;
    case "tag-attr":
      // `input.html`, not `html`: the page pass already leaves comments out, and one string keeps the one-page cache warm.
      return matchesTagAttr(detector, input.html);
    case "url-host": {
      try {
        return detector.pattern.test(new URL(input.url).hostname);
      } catch {
        return false;
      }
    }
    case "url-path":
      // Match the page URL first, then fall back to the HTML. The HTML fallback
      // is intentional: url-path patterns are specific path SEGMENTS (e.g.
      // /wp-json/, /sites/default/files/, /media/jui/) that real fingerprints
      // rely on finding in asset/link URLs embedded in the markup — the page URL
      // itself rarely carries them. Patterns are deliberately narrow segments,
      // not bare words, to keep the HTML scan low-false-positive.
      return detector.pattern.test(input.url) || detector.pattern.test(html);
  }
}

function detectorLabel(detector: Detector): string {
  switch (detector.type) {
    case "header":
      return `header:${detector.name}`;
    case "meta":
      return `meta:${detector.name}`;
    case "script-url":
      return `script-url:${detector.pattern.source.slice(0, 30)}`;
    case "script-content":
      return `script-content:${detector.pattern.source.slice(0, 30)}`;
    case "html":
      return `html:${detector.pattern.source.slice(0, 30)}`;
    case "dom":
      return `dom:${detector.selector}`;
    case "url-path":
      return `url-path:${detector.pattern.source.slice(0, 30)}`;
    case "url-host":
      return `url-host:${detector.pattern.source.slice(0, 30)}`;
    case "tag-attr":
      return `tag-attr:${detector.attrs.join("|")}:${detector.pattern.source.slice(0, 30)}`;
  }
}

// Patterns like `[\d.]+` happily capture a bare "." from prose ("built with
// Next.js."). A version must contain at least one digit.
function validVersion(match: RegExpMatchArray | null): string | null {
  return match?.[1] && /\d/.test(match[1]) ? match[1] : null;
}

function extractVersion(fingerprint: TechFingerprint, input: TechDetectInput): string | null {
  if (!fingerprint.versionPattern) return null;

  // Check headers
  for (const value of Object.values(input.headers)) {
    const version = validVersion(value.match(fingerprint.versionPattern));
    if (version) return version;
  }

  // Check meta tags
  if (input.meta) {
    for (const value of Object.values(input.meta)) {
      const version = validVersion(value.match(fingerprint.versionPattern));
      if (version) return version;
    }
  }

  // Check HTML — sampled to the first 50KB. Version strings (generator meta,
  // header comments, bundle banners) live near the top of the document; the cap
  // bounds the regex work without missing them in practice.
  const htmlSample = input.html.slice(0, 51200);
  const htmlVersion = validVersion(htmlSample.match(fingerprint.versionPattern));
  if (htmlVersion) return htmlVersion;

  // Check script URLs and content
  if (input.scripts) {
    for (const script of input.scripts) {
      if (script.url) {
        const version = validVersion(script.url.match(fingerprint.versionPattern));
        if (version) return version;
      }
      if (script.content) {
        const version = validVersion(
          script.content.slice(0, 10240).match(fingerprint.versionPattern),
        );
        if (version) return version;
      }
    }
  }

  return null;
}

/**
 * Parse `<meta name=… content=…>` tags from the head sample into a name→content
 * map. `meta`-type detectors (e.g. `generator` → WordPress/Wix/Shopify) read ONLY
 * this map, never the raw HTML — so callers that don't pre-parse meta (the CLI's
 * local scan, cloud-runner's fallback) would silently miss every CMS whose primary
 * signal is the generator tag. Auto-extracting here closes that gap (#407). Both
 * attribute orders are handled — some CMSes emit `content=… name=generator`.
 */
function extractMetaFromHtml(html: string): Record<string, string> {
  // Object.create(null): `name` is page-controlled, so on a plain object the
  // `key in out` guard below would be true for `constructor`/`__proto__` from
  // the prototype chain and drop those tags before they reach a detector.
  const out: Record<string, string> = Object.create(null);
  // Quoted attributes only — unquoted generator tags are vanishingly rare.
  const sample = html.slice(0, 51200);
  const tagRe = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(sample)) !== null) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag[0])?.[1];
    if (name && content !== undefined) {
      const key = name.toLowerCase();
      if (!(key in out)) out[key] = content;
    }
  }
  return out;
}

/** Detect technologies from page data. Returns all matches. */
export function detectTechnologies(
  rawInput: TechDetectInput,
  fingerprints: TechFingerprint[] = ALL_FINGERPRINTS,
  options: DetectOptions = {},
): DetectedTechnology[] {
  const previous = activeAttrs;
  activeAttrs = neededAttributes(fingerprints);
  try {
    return detectOnePage(rawInput, fingerprints, options);
  } finally {
    activeAttrs = previous;
    releasePageMarkup();
  }
}

function detectOnePage(
  rawInput: TechDetectInput,
  fingerprints: TechFingerprint[],
  options: DetectOptions,
): DetectedTechnology[] {
  const results: DetectedTechnology[] = [];
  const views = new Map<string, ScriptView>();
  const maxChars = options.maxScriptChars ?? TECH_SCRIPT_CONTENT_LIMIT;
  const deadline = performance.now() + (options.budgetMs ?? TECH_DETECT_PAGE_BUDGET_MS);

  // Resolve the meta map: trust a non-empty caller-supplied one, otherwise parse
  // it from the HTML so meta-type detectors fire without a separate parse step.
  const input: TechDetectInput =
    rawInput.meta && Object.keys(rawInput.meta).length > 0
      ? rawInput
      : { ...rawInput, meta: extractMetaFromHtml(rawInput.html) };

  for (const fp of fingerprints) {
    if (performance.now() > deadline) {
      options.onBudgetExceeded?.();
      break;
    }
    let matchedDetector: Detector | null = null;
    for (const detector of fp.detectors) {
      // The page without what a browser does not run or show; comments stay only for a detector that matches one (#1550).
      const html = pageHtml(input.html, readsComments(detector));
      if (matchDetector(detector, input, html, views, maxChars)) {
        matchedDetector = detector;
        break; // ANY match = detected
      }
    }

    if (matchedDetector) {
      results.push({
        id: fp.id,
        name: fp.name,
        category: fp.category,
        version: extractVersion(fp, input),
        confidence: fp.confidence ?? "high",
        detectedBy: detectorLabel(matchedDetector),
        website: fp.website,
        icon: fp.icon,
      });
    }
  }

  // A fingerprint that another detection explains (a shared backend an AI app
  // builder loads for every app) is dropped, not reported as a second stack.
  const found = new Set(results.map((r) => r.id));
  const suppressed = new Set(
    fingerprints
      .filter((fp) => fp.unlessAny?.some((id) => found.has(id)))
      .map((fp) => fp.id),
  );
  return suppressed.size ? results.filter((r) => !suppressed.has(r.id)) : results;
}
