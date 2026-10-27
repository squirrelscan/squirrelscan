// The ONE featurizer for the page classifier.
//
// Pure TypeScript over a linkedom DOM, deterministic, O(n) in element count, no
// geometry, no network. Training and inference both go through this file, so
// there is no train/serve skew by construction.
//
// Two hard rules:
//
//  1. NOTHING derived from JSON-LD, microdata or og:type may become a feature.
//     Those are a page-type label source. That is why there is no script count,
//     no meta count and no itemtype anywhere below: a count of <script>
//     elements is a proxy for "this page ships JSON-LD".
//  2. Landmark tags and ARIA roles are a region label source, so the masked
//     variant has to hide them well enough that a masked <foot> and a masked
//     <div> with the same subtree produce byte-identical vectors. `maskVector`
//     is what makes that true; featurize.test.ts is what keeps it true.
//
// Everything a node contributes is computed in three linear passes:
//   forward  - record every element, its own text, its attributes
//   reverse  - fold each element's subtree totals into its parent
//   emit     - build the numeric vector for the <= MAX_CANDIDATES candidates

import { parseHTML } from "@squirrelscan/parser/dom";

// ---------------------------------------------------------------------------
// Versioning. Any change to the feature list, the vocabulary, the hash or the
// candidate rule MUST bump this: the dataset and the trained artifact both
// carry it, and a model evaluated against a different featurizer version is
// measuring nothing.
// ---------------------------------------------------------------------------

export const FEATURIZER_VERSION = "v2.3.0";

// v2.3.0 adds a text/attribute channel to the NODE tokens only (the dense vector is unchanged): the node's own-text
// words (t:), the first words of its subtree text (st:), its aria-label words (a:), the rel values of the node and its
// first 20 descendant anchors (r:) and the social/contact host tag of the anchors in its first 60 subtree elements (h:).
// It is a SECOND stream (`textTokens`, same 512 buckets), not a change to `tokens`: `tokens` stays exactly the v2.2.0
// class/id stream, so the region head (and the page-type head, which reads page tokens) keep their trained input. Only
// the section head reads the union. An artifact built for another version degrades to the rules path.

/** Hashed class/id token buckets. Fixed forever at this version. */
export const TOKEN_BUCKETS = 512;

/** Hard cap on candidate nodes per page. */
export const MAX_CANDIDATES = 400;

/** Tokens kept per element, in source order after dedupe (utility-class pages
 *  otherwise contribute hundreds of meaningless tokens each). */
const MAX_TOKENS_PER_ELEMENT = 32;

/** Cap on the text scanned for a pattern flag on one element. */
const MAX_LOCAL_TEXT = 400;

/** Words taken from a node's own text and from its aria-label (v2.3.0). */
const MAX_TEXT_WORDS = 12;
/** Characters of own text scanned for those words. */
const MAX_WORD_SCAN = 300;
/** Descendant anchors (the node itself included) whose rel and host become tokens (v2.3.0). */
const MAX_TOKEN_ANCHORS = 20;
/** Attribute reads for the text/attribute stream are bounded when the walk stores them, never per candidate: characters of a `rel`
 *  scanned, values kept per anchor, characters of one value, and characters of an href looked at for its host. */
const MAX_REL_SCAN = 200;
const MAX_REL_VALUES = 8;
const MAX_REL_LENGTH = 32;
const MAX_HREF_SCAN = 2048;
/** Elements of a node's subtree (preorder, the node first) read for the subtree words (st:) and the anchor hosts (h:). */
const MAX_SUBTREE_ELEMENTS = 60;

// ---------------------------------------------------------------------------
// Tag sets
// ---------------------------------------------------------------------------

/** Subtrees never walked: no user-visible structure, and script/style text
 *  would otherwise contaminate every text statistic. */
export const SKIP_SUBTREE = new Set([
  "script",
  "style",
  "template",
  "svg",
  "math",
  "noscript",
  "head",
  "link",
  "meta",
  "title",
  "base",
]);

/** Always a candidate: a region, a section, a list or a form control group. */
const REGION_TAGS = new Set([
  "div",
  "section",
  "article",
  "aside",
  "nav",
  "header",
  "footer",
  "main",
  "search",
  "form",
  "fieldset",
  "dialog",
  "ul",
  "ol",
  "dl",
  "table",
  "figure",
  "blockquote",
  "details",
  "address",
  "li",
  "menu",
]);

/** Candidate whatever its size: the node IS the component. */
const MEDIA_TAGS = new Set(["img", "iframe", "video", "audio", "picture", "canvas", "object"]);

/** Tags whose candidacy needs >= 2 element children or >= 20 chars of text. */
const SIZE_GATED_TAGS = new Set(["div", "li"]);

/** HTML landmark elements. Masked away in the masked variant. */
const LANDMARK_TAGS = new Set([
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "search",
  "form",
  "dialog",
]);

/** ARIA landmark / dialog roles. Masked away in the masked variant. */
const LANDMARK_ROLES = new Set([
  "banner",
  "contentinfo",
  "navigation",
  "complementary",
  "main",
  "search",
  "form",
  "region",
  "dialog",
  "alertdialog",
]);

/** The implicit ARIA role of a landmark element, so masking a <footer> to a
 *  <div> also removes the role a consumer would have inferred from the tag. */
const IMPLICIT_ROLE: Record<string, string> = {
  header: "banner",
  footer: "contentinfo",
  nav: "navigation",
  aside: "complementary",
  main: "main",
  search: "search",
  form: "form",
  dialog: "dialog",
};

/** Sectioning content: a <header>/<footer> inside one of these is the section's
 *  own chrome, not the site's. */
export const SECTIONING_TAGS = new Set(["article", "section", "aside", "nav"]);

// ---------------------------------------------------------------------------
// Categorical vocabularies. Out-of-vocabulary maps to 0, so adding a tag later
// never renumbers an existing one.
// ---------------------------------------------------------------------------

const TAG_VOCAB = [
  "div",
  "span",
  "section",
  "article",
  "aside",
  "nav",
  "header",
  "footer",
  "main",
  "search",
  "form",
  "fieldset",
  "dialog",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "figure",
  "figcaption",
  "blockquote",
  "details",
  "summary",
  "address",
  "menu",
  "p",
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "img",
  "picture",
  "iframe",
  "video",
  "audio",
  "canvas",
  "object",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "time",
  "pre",
  "code",
  "body",
  "html",
];

const ROLE_VOCAB = [
  "banner",
  "contentinfo",
  "navigation",
  "complementary",
  "main",
  "search",
  "form",
  "region",
  "dialog",
  "alertdialog",
  "list",
  "listitem",
  "menu",
  "menubar",
  "menuitem",
  "tablist",
  "tab",
  "tabpanel",
  "article",
  "button",
  "link",
  "img",
  "presentation",
  "none",
  "group",
  "heading",
  "toolbar",
  "alert",
  "status",
  "tooltip",
];

const TAG_INDEX = indexOf(TAG_VOCAB);
const ROLE_INDEX = indexOf(ROLE_VOCAB);

function indexOf(vocab: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  // 0 is reserved for out-of-vocabulary.
  for (let i = 0; i < vocab.length; i++) map.set(vocab[i]!, i + 1);
  return map;
}

// ---------------------------------------------------------------------------
// Curated class/id vocabulary: 65 words that carry region meaning on their own.
// These get an explicit binary feature EACH, in addition to the hashed bag, so
// the model can lean on "this node's class says footer" without needing to
// resolve a hash collision.
// ---------------------------------------------------------------------------

export const CURATED_VOCAB = [
  "footer",
  "header",
  "nav",
  "navbar",
  "menu",
  "sidebar",
  "aside",
  "hero",
  "banner",
  "cookie",
  "consent",
  "modal",
  "dialog",
  "overlay",
  "popup",
  "card",
  "product",
  "price",
  "article",
  "post",
  "comment",
  "breadcrumb",
  "pagination",
  "search",
  "cart",
  "checkout",
  "newsletter",
  "subscribe",
  "social",
  "share",
  "content",
  "main",
  "wrapper",
  "container",
  "section",
  "grid",
  "list",
  "item",
  "widget",
  "sticky",
  "toolbar",
  "masthead",
  "logo",
  "copyright",
  "legal",
  "login",
  "account",
  "related",
  "featured",
  "promo",
  "ad",
  "gallery",
  "carousel",
  "tabs",
  "accordion",
  "form",
  "filter",
  "toc",
  "byline",
  "author",
  "date",
  "category",
  "review",
  "rating",
  "block",
];

const CURATED_INDEX = new Map(CURATED_VOCAB.map((w, i) => [w, i]));

/**
 * Words a region label can be read off directly. Under `mask` each of
 * these is dropped from the curated features and the hashed bag with p = 0.5,
 * seeded by (nodeId, token) — so class="site-footer" stays a usable signal
 * without being the whole answer.
 */
export const LABEL_WORDS = new Set([
  "footer",
  "header",
  "nav",
  "navbar",
  "navigation",
  "sidebar",
  "aside",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "dialog",
  "form",
]);

// ---------------------------------------------------------------------------
// Patterns. Deliberately short and multilingual-light: every entry here is a
// maintenance cost, and a long list of half-remembered translations reads as
// coverage it does not have. English + the four next-most-common European
// languages on the web, nothing else.
// ---------------------------------------------------------------------------

export const PATTERNS = {
  /** A copyright notice, with or without a year. */
  copyright: /©|\(c\)\s*(19|20)\d{2}|copyright|derechos reservados|tous droits|urheberrecht/i,
  /** A four-digit year on its own, which a footer almost always carries. */
  year: /\b(19|20)\d{2}\b/,
  /** Cookie / consent / privacy chrome. */
  consent: /cookie|consent|gdpr|datenschutz|akzeptier|privacidad|confidentialit/i,
  /** A price: a currency symbol next to a digit, or a digit next to a code. The digit run is
   *  bounded: an open-ended `[\d.,]*` rescans a long digit run from every start (polynomial). */
  price: /[$£€¥₹]\s?\d|\d[\d.,]{0,24}\s?(usd|eur|gbp|jpy|inr|cad|aud|chf|sek|nok|pln)\b/i,
  /** A date in any of the three shapes a CMS emits. */
  date: /\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(19|20)\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.](19|20)?\d{2}\b/i,
  /** A byline: an attribution word followed by a CAPITALISED name. The case
   *  alternatives are spelled out rather than using the `i` flag, because `i`
   *  plus `u` case-folds \p{Lu} too and "by the way" would then match. */
  byline: /\b(?:[Bb][Yy]|[Vv]on|[Pp]ar|[Pp]or)\s+\p{Lu}/u,
  /** Commerce intent. */
  cart: /\b(add to cart|add to bag|buy now|checkout|basket|warenkorb|panier|carrito)\b/i,
  /** A search affordance named in an attribute. */
  search: /search|suche|buscar|recherche|cerca/i,
  /** "5 min read" and its neighbours. */
  readingTime: /\b\d+\s*(min|minute|minutes)\s*(read|lesezeit|de lecture)\b/i,
  /** Reader comments. */
  comments: /\b(comments?|kommentare|comentarios|commentaires|disqus)\b/i,
  /** Pagination chrome. */
  pagination: /\b(next page|previous page|older posts|newer posts|page \d+ of \d+)\b/i,
  /** Breadcrumb chrome. */
  breadcrumb: /breadcrumb/i,
};

/** Social hosts, matched as a substring of an href. The host never leaves the
 *  featurizer: only the count of links that matched does. */
const SOCIAL_HOSTS = [
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "reddit.com",
  "github.com",
  "mastodon.",
  "threads.net",
  "wa.me",
  "t.me",
];

/** Registrable host -> short tag, for the anchor host tokens (h:, v2.3.0). Two-label keys: `m.facebook.com` and
 *  `api.whatsapp.com` reduce to their last two labels before the lookup. mailto: and tel: get their own tags. */
const ANCHOR_HOST_TAGS: ReadonlyMap<string, string> = new Map([
  ["facebook.com", "facebook"],
  ["fb.com", "facebook"],
  ["fb.me", "facebook"],
  ["twitter.com", "twitter"],
  ["x.com", "twitter"],
  ["linkedin.com", "linkedin"],
  ["lnkd.in", "linkedin"],
  ["pinterest.com", "pinterest"],
  ["pin.it", "pinterest"],
  ["whatsapp.com", "whatsapp"],
  ["wa.me", "whatsapp"],
  ["telegram.me", "telegram"],
  ["telegram.org", "telegram"],
  ["t.me", "telegram"],
  ["reddit.com", "reddit"],
  ["instagram.com", "instagram"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
]);

/** The short host tag of an href, "" when it is none of the listed hosts. */
function anchorHostTag(href: string): string {
  if (/^mailto:/i.test(href)) return "mailto";
  if (/^tel:/i.test(href)) return "tel";
  if (/^whatsapp:/i.test(href)) return "whatsapp";
  const host = hostOf(href.startsWith("//") ? `https:${href}` : href);
  if (host === "") return "";
  return ANCHOR_HOST_TAGS.get(host.split(".").slice(-2).join(".")) ?? "";
}

/** The `r:` values of one anchor, bounded at store time: the first MAX_REL_SCAN characters, lowercased, split on whitespace, letters and
 *  hyphens only, 2 to MAX_REL_LENGTH characters, at most MAX_REL_VALUES of them. A megabyte `rel` costs one 200-character slice. */
function relValues(rel: string | null): string[] {
  const out: string[] = [];
  if (!rel) return out;
  for (const raw of rel.slice(0, MAX_REL_SCAN).toLowerCase().split(/\s+/)) {
    const value = raw.replace(/[^a-z-]/g, "");
    if (value.length < 2 || value.length > MAX_REL_LENGTH) continue;
    out.push(value);
    if (out.length >= MAX_REL_VALUES) break;
  }
  return out;
}

const WORD_PATTERN = /\p{L}{2,24}/gu;

/** The first `max` words (letters only, two or more, lowercased) of a string. */
function textWords(text: string, max: number): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const match of text.slice(0, MAX_WORD_SCAN).toLowerCase().matchAll(WORD_PATTERN)) {
    out.push(match[0]);
    if (out.length >= max) break;
  }
  return out;
}

/** URL path segments worth a flag of their own on the page vector. */
const PATH_SLUGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["blog", ["blog", "blogs", "posts"]],
  ["news", ["news", "press", "newsroom"]],
  ["docs", ["docs", "doc", "documentation", "guide", "guides", "manual", "reference", "api"]],
  ["product", ["product", "products", "item", "shop", "store", "p"]],
  ["category", ["category", "categories", "collection", "collections", "tag", "tags"]],
  ["pricing", ["pricing", "plans", "price"]],
  ["about", ["about", "about-us", "company", "team"]],
  ["contact", ["contact", "contact-us", "support", "help"]],
  ["legal", ["legal", "privacy", "terms", "tos", "policy", "policies", "imprint", "impressum"]],
  ["account", ["account", "login", "signin", "signup", "register", "cart", "checkout"]],
  ["search", ["search", "s", "q"]],
];

// ---------------------------------------------------------------------------
// The token hash. FNV-1a, 32-bit, over the UTF-16 code units of the token, then
// modulo TOKEN_BUCKETS. Written with Math.imul so every JS runtime agrees
// bit-for-bit; featurize.test.ts pins golden values.
//
//   h = 2166136261
//   for each code unit c:  h = imul(h ^ c, 16777619)
//   bucket = (h >>> 0) % 512
//
// Tokens are ASCII after normalisation (digits stripped, lowercased), so code
// units and UTF-8 bytes agree for every token that survives `tokenize`. The v2.3.0
// text words (t:, a:) are Unicode letters, so for those the hash is over UTF-16 code
// units only: a port to another runtime must hash the same units, not UTF-8 bytes.
// ---------------------------------------------------------------------------

export function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

export function tokenBucket(token: string): number {
  return fnv1a32(token) % TOKEN_BUCKETS;
}

/** p = 0.5, deterministic in (nodeId, token). Bit 0 of the same hash. */
function dropsUnderMask(nodeId: number, token: string, always = false): boolean {
  return always || (fnv1a32(`${nodeId}\u0000${token}`) & 1) === 0;
}

/**
 * Split a class or id attribute into tokens: on whitespace, `-`, `_`, `:`, `/`,
 * `.`, and at camelCase boundaries; lowercased; digits stripped; anything under
 * two characters dropped. Deduped, source order, capped.
 */
export function tokenize(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[\s\-_:/.[\]()]+/)) {
    if (!raw) continue;
    // camelCase / PascalCase boundary, then strip digits.
    for (const piece of raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")) {
      const token = piece.toLowerCase().replace(/[^a-z]/g, "");
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= MAX_TOKENS_PER_ELEMENT) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FeaturizeOptions {
  /** Produce the masked vector in `features` instead of the true one. */
  mask?: boolean;
  /**
   * With `mask`, drop EVERY label-word token instead of half of them.
   *
   * Training uses p = 0.5 so the model still learns that class="site-footer"
   * is evidence. This is the other end of that: the honest estimate for a page
   * whose class names say nothing at all, which is the div-soup case the
   * classifier exists for. It is a TEST-time option and is never used to build
   * training rows; the feature SCHEMA is unchanged, so it does not move
   * FEATURIZER_VERSION.
   */
  maskAll?: boolean;
  /** Also produce the masked vector alongside the true one. */
  emitMasked?: boolean;
  /** Candidate cap, for tests. Defaults to MAX_CANDIDATES. */
  maxCandidates?: number;
  /**
   * When given, receives every walked element in nodeId order (index =
   * nodeId), filled by the same walk that assigns the ids. For consumers that
   * map a DOM element back to a node (see `elementPlacer`) without a
   * second walk that could drift. Not a feature: the schema is unchanged.
   */
  elementsOut?: unknown[];
  /**
   * When given, receives the raw `class` and `id` values the walk read and
   * each element's subtree size, in nodeId order. A markup rule can then scan
   * the whole page without reading every attribute again, and jump past a
   * subtree it has settled (comments-rule.ts). Not a feature.
   */
  attributesOut?: WalkAttributes;
}

export interface WalkAttributes {
  classAttr: ReadonlyArray<string | null>;
  idAttr: ReadonlyArray<string | null>;
  /** Walked elements in each one's subtree, itself included: its descendants
   *  are the next `subtreeSize[i] - 1` nodeIds. */
  subtreeSize: ArrayLike<number>;
}

export interface NodeFeatures {
  /** Preorder index among non-skipped elements. Stable for a given document,
   *  and the seed for the masked token dropout. */
  nodeId: number;
  /** True tag, for labelling and analysis. NOT a feature. */
  tag: string;
  /** Explicit role attribute, lowercased, or "". For labelling. NOT a feature. */
  role: string;
  /** The element's `id` attribute, or "". Lets a consumer point at the node and
   *  lets the fixtures name their expectations. NOT a feature (the id's TOKENS
   *  are, through the hashed bag; the literal string is not). */
  elementId: string;
  /** nodeId of the nearest candidate ancestor, or -1. For containment labels. */
  parentCandidateId: number;
  /** nodeId of the parent element (candidate or not), or -1. */
  parentId: number;
  depth: number;
  /** Dense numeric vector, ordered by NODE_FEATURE_NAMES. */
  features: number[];
  /** Sorted, unique hashed token buckets of the class/id stream (prefixes s: and p:), exactly the v2.2.0 stream. The region
   *  head reads this and only this, so it is bit-identical to what it was trained on. */
  tokens: number[];
  /** Sorted, unique buckets of the text/attribute stream (t:, st:, a:, r:, h:, since v2.3.0). The section head reads the union
   *  of `tokens` and `textTokens` (see `mergeTokens`). */
  textTokens: number[];
  masked: boolean;
  /** Present when `emitMasked` was set and `mask` was not. */
  maskedFeatures?: number[];
  maskedTokens?: number[];
  maskedTextTokens?: number[];
}

/** Sorted, unique union of two sorted bucket lists: the section head's token input. */
export function mergeTokens(a: number[], b: number[]): number[] {
  if (b.length === 0) return a;
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i]! : Infinity;
    const y = j < b.length ? b[j]! : Infinity;
    const v = Math.min(x, y);
    out.push(v);
    if (x === v) i++;
    if (y === v) j++;
  }
  return out;
}

export interface PageFeatures {
  /** Dense numeric vector, ordered by PAGE_FEATURE_NAMES. */
  features: number[];
  tokens: number[];
  /** Total elements walked, for throughput accounting. Not a feature. */
  elementCount: number;
  /** True when the document declares fewer than two distinct landmark kinds:
   *  the div-soup pool the classifier exists for. Not a feature. */
  divSoup: boolean;
  /** Distinct landmark kinds found. For stats only. Not a feature. */
  landmarkKinds: string[];
}

export interface FeaturizedPage {
  page: PageFeatures;
  nodes: NodeFeatures[];
}

// ---------------------------------------------------------------------------
// Internal element record. Arrays-of-fields rather than objects: one page can
// carry 100k elements and the reverse fold touches every field of every one.
// ---------------------------------------------------------------------------

interface Walk {
  count: number;
  tag: string[];
  role: string[];
  elementId: string[];
  parent: Int32Array;
  depth: Int32Array;
  /** Element children, in document order. Filled once the walk is complete. */
  children: number[][];
  /** This element's OWN text runs, joined and whitespace-normalised. */
  ownText: string[];
  /** Anchors with an href, as element indexes in ascending (document) order, with their lowercased rel and host tag
   *  (v2.3.0, token channel only). */
  anchors: number[];
  anchorRel: string[][];
  anchorHost: string[];
  /** aria-label values by element index; only elements that carry one (v2.3.0). */
  ariaLabel: Map<number, string>;
  /** Tag plus the first six child tags: the shape a card grid repeats. */
  shapeKey: string[];
  /** Raw class/id attributes. Tokenised LAZILY, at emit time, for the <= 400
   *  candidates and their parents rather than for every element on the page:
   *  tokenising all 22k elements of a large page was the largest single cost
   *  in the walk, and at most 800 of them are ever read. */
  classAttr: Array<string | null>;
  idAttr: Array<string | null>;
  siblingIndex: Int32Array;
  /** Nearest <article>/<section> ancestor index, or -1. */
  sectionAncestor: Int32Array;
  /** The ancestor that is a direct element child of <body>, or -1. */
  bodyBlock: Int32Array;
  /** Text inside <li> descendants: a list-heavy block is a menu or a sidebar,
   *  not prose, and link density alone does not separate them. */
  listItemTextLen: Int32Array;
  isLink: Uint8Array;

  // Subtree accumulators, folded child -> parent in the reverse pass.
  elements: Int32Array;
  textLen: Int32Array;
  linkTextLen: Int32Array;
  links: Int32Array;
  internalLinks: Int32Array;
  externalLinks: Int32Array;
  socialLinks: Int32Array;
  contactLinks: Int32Array;
  headings: Int32Array;
  minHeading: Int32Array;
  listItems: Int32Array;
  images: Int32Array;
  videos: Int32Array;
  iframes: Int32Array;
  forms: Int32Array;
  inputs: Int32Array;
  buttons: Int32Array;
  paragraphs: Int32Array;
  paragraphTextLen: Int32Array;
  searchInputs: Int32Array;
  ariaAttrs: Int32Array;
  tabindexes: Int32Array;
  dialogHints: Int32Array;
  timeElements: Int32Array;
  tables: Int32Array;
  codeBlocks: Int32Array;
  // Pattern flags: counted per element, read as "> 0" after the fold.
  copyrightHits: Int32Array;
  yearHits: Int32Array;
  consentHits: Int32Array;
  priceHits: Int32Array;
  dateHits: Int32Array;
  bylineHits: Int32Array;
  cartHits: Int32Array;
  commentHits: Int32Array;
  paginationHits: Int32Array;
  breadcrumbHits: Int32Array;
  readingTimeHits: Int32Array;
}

interface ElementLike {
  nodeType: number;
  localName?: string;
  nodeName: string;
  firstChild: ElementLike | null;
  nextSibling: ElementLike | null;
  data?: string;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
}

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;

function allocate(capacity: number): Walk {
  return {
    count: 0,
    tag: [],
    role: [],
    elementId: [],
    parent: new Int32Array(capacity),
    depth: new Int32Array(capacity),
    children: [],
    shapeKey: [],
    ownText: [],
    anchors: [],
    anchorRel: [],
    anchorHost: [],
    ariaLabel: new Map(),
    classAttr: [],
    idAttr: [],
    siblingIndex: new Int32Array(capacity),
    sectionAncestor: new Int32Array(capacity).fill(-1),
    bodyBlock: new Int32Array(capacity).fill(-1),
    listItemTextLen: new Int32Array(capacity),
    isLink: new Uint8Array(capacity),
    elements: new Int32Array(capacity),
    textLen: new Int32Array(capacity),
    linkTextLen: new Int32Array(capacity),
    links: new Int32Array(capacity),
    internalLinks: new Int32Array(capacity),
    externalLinks: new Int32Array(capacity),
    socialLinks: new Int32Array(capacity),
    contactLinks: new Int32Array(capacity),
    headings: new Int32Array(capacity),
    minHeading: new Int32Array(capacity).fill(7),
    listItems: new Int32Array(capacity),
    images: new Int32Array(capacity),
    videos: new Int32Array(capacity),
    iframes: new Int32Array(capacity),
    forms: new Int32Array(capacity),
    inputs: new Int32Array(capacity),
    buttons: new Int32Array(capacity),
    paragraphs: new Int32Array(capacity),
    paragraphTextLen: new Int32Array(capacity),
    searchInputs: new Int32Array(capacity),
    ariaAttrs: new Int32Array(capacity),
    tabindexes: new Int32Array(capacity),
    dialogHints: new Int32Array(capacity),
    timeElements: new Int32Array(capacity),
    tables: new Int32Array(capacity),
    codeBlocks: new Int32Array(capacity),
    copyrightHits: new Int32Array(capacity),
    yearHits: new Int32Array(capacity),
    consentHits: new Int32Array(capacity),
    priceHits: new Int32Array(capacity),
    dateHits: new Int32Array(capacity),
    bylineHits: new Int32Array(capacity),
    cartHits: new Int32Array(capacity),
    commentHits: new Int32Array(capacity),
    paginationHits: new Int32Array(capacity),
    breadcrumbHits: new Int32Array(capacity),
    readingTimeHits: new Int32Array(capacity),
  };
}

/** Collapse runs of whitespace; "" for a blank run. */
function normalizeText(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed;
}

/** Internal without parsing: a scheme-relative or absolute href whose host
 *  differs from the page host is external, everything else is internal. */
function isInternalHref(href: string, host: string): boolean {
  if (href.startsWith("#") || href.startsWith("?") || href.startsWith("/")) {
    // "//host/path" is protocol-relative, not a path.
    if (!href.startsWith("//")) return true;
    return hostOf(`https:${href}`) === host;
  }
  if (/^https?:/i.test(href)) return hostOf(href) === host;
  // mailto:, tel:, javascript:, data: — not navigation within the site.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  return true;
}

function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  if (!match) return "";
  const authority = match[1]!;
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const colon = hostPort.lastIndexOf(":");
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  return host.toLowerCase().replace(/^www\./, "");
}

// ---------------------------------------------------------------------------
// Pass 1: walk
// ---------------------------------------------------------------------------

function walkDocument(body: ElementLike, host: string, elementsOut?: unknown[]): Walk {
  const walk = allocate(1024);
  let capacity = 1024;

  const grow = (needed: number): void => {
    if (needed < capacity) return;
    const next = Math.max(capacity * 2, needed + 1);
    const unwritten = needed;
    const keys = [
      "parent",
      "depth",
      "siblingIndex",
      "sectionAncestor",
      "bodyBlock",
      "listItemTextLen",
      "elements",
      "textLen",
      "linkTextLen",
      "links",
      "internalLinks",
      "externalLinks",
      "socialLinks",
      "contactLinks",
      "headings",
      "minHeading",
      "listItems",
      "images",
      "videos",
      "iframes",
      "forms",
      "inputs",
      "buttons",
      "paragraphs",
      "paragraphTextLen",
      "searchInputs",
      "ariaAttrs",
      "tabindexes",
      "dialogHints",
      "timeElements",
      "tables",
      "codeBlocks",
      "copyrightHits",
      "yearHits",
      "consentHits",
      "priceHits",
      "dateHits",
      "bylineHits",
      "cartHits",
      "commentHits",
      "paginationHits",
      "breadcrumbHits",
      "readingTimeHits",
    ] as const;
    for (const key of keys) {
      const grown = new Int32Array(next);
      grown.set(walk[key]);
      // Positions from `unwritten` up have not been filled yet; minHeading's
      // "no heading here" sentinel is 7, not 0.
      if (key === "minHeading") grown.fill(7, unwritten);
      if (key === "sectionAncestor" || key === "bodyBlock") grown.fill(-1, unwritten);
      (walk as unknown as Record<string, Int32Array>)[key] = grown;
    }
    const links = new Uint8Array(next);
    links.set(walk.isLink);
    walk.isLink = links;
    capacity = next;
  };

  // Explicit stack: recursion blows up on deep CMS markup and this has to hold
  // for any page.
  const stack: Array<{
    node: ElementLike;
    parent: number;
    depth: number;
    sibling: number;
    /** Nearest ancestor <article>/<section>, or -1. NOT aside/nav: those are
     *  landmark tags, and a feature reading them would leak the region label
     *  past the mask. article and section are not landmarks, so they are free. */
    section: number;
    /** The ancestor that is a direct element child of <body>, or -1. */
    bodyBlock: number;
  }> = [{ node: body, parent: -1, depth: 0, sibling: 0, section: -1, bodyBlock: -1 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const el = frame.node;
    const tag = (el.localName ?? el.nodeName.toLowerCase()).toLowerCase();
    if (SKIP_SUBTREE.has(tag)) continue;

    const index = walk.count++;
    grow(index);
    elementsOut?.push(el);
    walk.tag.push(tag);
    walk.parent[index] = frame.parent;
    walk.depth[index] = frame.depth;
    walk.siblingIndex[index] = frame.sibling;
    walk.sectionAncestor[index] = frame.section;
    walk.bodyBlock[index] = frame.parent === 0 ? index : frame.bodyBlock;
    walk.elements[index] = 1;

    const role = (el.getAttribute("role") ?? "").trim().toLowerCase();
    walk.role.push(role);
    walk.classAttr.push(el.getAttribute("class"));
    const rawId = el.getAttribute("id");
    walk.idAttr.push(rawId);
    walk.elementId.push(rawId ?? "");

    // Own text and the element children, in one pass over the child nodes.
    let own = "";
    const children: ElementLike[] = [];
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === NODE_TEXT) {
        const text = normalizeText(child.data ?? "");
        if (text) own = own ? `${own} ${text}` : text;
      } else if (child.nodeType === NODE_ELEMENT) {
        const childTag = (child.localName ?? child.nodeName.toLowerCase()).toLowerCase();
        if (SKIP_SUBTREE.has(childTag)) continue;
        children.push(child);
      }
    }
    walk.ownText.push(own);
    walk.textLen[index] = own.length;

    // Per-element signals that do not need the subtree.
    countAttributes(walk, index, el, tag, role);
    countTag(walk, index, el, tag, host);

    // Children are pushed in reverse so they pop in document order. That makes
    // the walk a strict preorder DFS, which is what lets `subtreeEnd` be
    // computed as i + subtreeElements - 1 rather than tracked per node.
    const childSection = tag === "article" || tag === "section" ? index : frame.section;
    const childBodyBlock = frame.parent === 0 ? index : frame.bodyBlock;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({
        node: children[i]!,
        parent: index,
        depth: frame.depth + 1,
        sibling: i,
        section: childSection,
        bodyBlock: childBodyBlock,
      });
    }
  }

  // Link-up: every element knows its parent, so the ordered child lists fall
  // out of one pass over the parent array (document order is index order).
  const childLists: number[][] = Array.from({ length: walk.count }, () => [] as number[]);
  for (let i = 1; i < walk.count; i++) childLists[walk.parent[i]!]!.push(i);
  walk.children = childLists;

  // Shape keys, built ONCE per element rather than once per (parent, child)
  // pair: the sibling-run scan below then compares strings instead of
  // rebuilding one for every child of every node, which was the single
  // largest cost in this file when it was measured.
  for (let i = 0; i < walk.count; i++) {
    const kids = childLists[i]!;
    let shape = walk.tag[i]!;
    shape += ">";
    for (let k = 0; k < kids.length && k < 6; k++) {
      if (k > 0) shape += ",";
      shape += walk.tag[kids[k]!]!;
    }
    walk.shapeKey.push(shape);
  }

  return walk;
}

function countAttributes(
  walk: Walk,
  index: number,
  el: ElementLike,
  tag: string,
  role: string,
): void {
  let aria = 0;
  for (const name of el.getAttributeNames()) {
    if (name.startsWith("aria-")) {
      aria++;
      if (name === "aria-label") {
        const label = el.getAttribute(name);
        if (label) walk.ariaLabel.set(index, label.slice(0, MAX_WORD_SCAN));
      }
    }
  }
  walk.ariaAttrs[index] = aria;
  if (el.getAttribute("tabindex") !== null) walk.tabindexes[index] = 1;
  if (
    tag === "dialog" ||
    role === "dialog" ||
    role === "alertdialog" ||
    el.getAttribute("aria-modal") !== null
  ) {
    walk.dialogHints[index] = 1;
  }
}

function countTag(walk: Walk, index: number, el: ElementLike, tag: string, host: string): void {
  switch (tag) {
    case "a": {
      const href = el.getAttribute("href");
      if (href === null) break;
      walk.isLink[index] = 1;
      walk.links[index] = 1;
      const trimmed = href.trim();
      walk.anchors.push(index);
      walk.anchorRel.push(relValues(el.getAttribute("rel")));
      walk.anchorHost.push(anchorHostTag(trimmed.slice(0, MAX_HREF_SCAN)));
      if (/^(mailto|tel|sms):/i.test(trimmed)) {
        walk.contactLinks[index] = 1;
        walk.externalLinks[index] = 1;
        break;
      }
      if (isInternalHref(trimmed, host)) walk.internalLinks[index] = 1;
      else walk.externalLinks[index] = 1;
      const lower = trimmed.toLowerCase();
      for (const social of SOCIAL_HOSTS) {
        if (lower.includes(social)) {
          walk.socialLinks[index] = 1;
          break;
        }
      }
      break;
    }
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      walk.headings[index] = 1;
      walk.minHeading[index] = Number(tag[1]);
      break;
    }
    case "li":
      walk.listItems[index] = 1;
      break;
    case "img":
    case "picture":
      walk.images[index] = 1;
      break;
    case "video":
      walk.videos[index] = 1;
      break;
    case "audio":
      // Counted with video: both are "this node is a media player", and an
      // audio-only class has too little support to separate it.
      walk.videos[index] = 1;
      break;
    case "iframe":
    case "object":
      walk.iframes[index] = 1;
      break;
    case "form":
      walk.forms[index] = 1;
      break;
    case "textarea":
    case "select":
      walk.inputs[index] = 1;
      break;
    case "input": {
      walk.inputs[index] = 1;
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button") walk.buttons[index] = 1;
      const named =
        `${el.getAttribute("name") ?? ""} ${el.getAttribute("placeholder") ?? ""} ` +
        `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("id") ?? ""}`;
      if (type === "search" || PATTERNS.search.test(named)) walk.searchInputs[index] = 1;
      break;
    }
    case "button":
      walk.buttons[index] = 1;
      break;
    case "p":
      walk.paragraphs[index] = 1;
      break;
    case "time": {
      walk.timeElements[index] = 1;
      // The most reliable date on an article is the machine-readable one, and
      // <time datetime="2026-03-04">March</time> carries nothing a text scan
      // would find. Read the attribute, not the label.
      const machine = el.getAttribute("datetime") ?? "";
      if (/^\d{4}-\d{2}/.test(machine)) walk.dateHits[index] = 1;
      break;
    }
    case "table":
      walk.tables[index] = 1;
      break;
    case "pre":
    case "code":
      walk.codeBlocks[index] = 1;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Pass 2: pattern flags on local text, then fold subtrees into parents
// ---------------------------------------------------------------------------

/**
 * Pattern flags, on each element's OWN text plus the own text of its direct
 * children.
 *
 * Only elements that HAVE own text are scanned. An element whose text lives
 * entirely in its children contributes nothing of its own, and the flag reaches
 * it through the subtree fold anyway — so scanning it would re-scan the same
 * characters once per ancestor, which is the quadratic version of this pass.
 * The one thing that costs: a pattern split across two sibling elements with no
 * text on the parent ("<span>$</span><span>24</span>") is missed. A pattern
 * split between a parent and a child ("By <a>Ada</a>") is not, which is the
 * case that actually occurs.
 *
 * The digit and symbol guards in front of the expensive expressions are worth
 * roughly a third of this pass on a text-heavy page.
 */
function flagPatterns(walk: Walk): void {
  for (let i = 0; i < walk.count; i++) {
    const own = walk.ownText[i]!;
    if (!own) continue;
    let text = own;
    const kids = walk.children[i]!;
    for (let k = 0; k < kids.length && text.length < MAX_LOCAL_TEXT; k++) {
      const childText = walk.ownText[kids[k]!]!;
      if (childText) text += ` ${childText}`;
    }
    if (text.length > MAX_LOCAL_TEXT) text = text.slice(0, MAX_LOCAL_TEXT);

    const hasDigit = DIGIT.test(text);
    if (hasDigit) {
      if (PATTERNS.year.test(text)) walk.yearHits[i] = 1;
      if (PATTERNS.price.test(text)) walk.priceHits[i] = 1;
      if (PATTERNS.date.test(text)) walk.dateHits[i] = 1;
      if (PATTERNS.pagination.test(text)) walk.paginationHits[i] = 1;
      if (PATTERNS.readingTime.test(text)) walk.readingTimeHits[i] = 1;
    }
    if (hasDigit || text.includes("\u00a9")) {
      if (PATTERNS.copyright.test(text)) walk.copyrightHits[i] = 1;
    }
    if (CURRENCY.test(text) && !walk.priceHits[i]) {
      if (PATTERNS.price.test(text)) walk.priceHits[i] = 1;
    }
    if (PATTERNS.consent.test(text)) walk.consentHits[i] = 1;
    if (PATTERNS.byline.test(text)) walk.bylineHits[i] = 1;
    if (PATTERNS.cart.test(text)) walk.cartHits[i] = 1;
    if (PATTERNS.comments.test(text)) walk.commentHits[i] = 1;
    if (PATTERNS.breadcrumb.test(text)) walk.breadcrumbHits[i] = 1;
  }
}

/** Cheap guards in front of the expensive expressions above. */
const DIGIT = /\d/;
const CURRENCY = /[$\u00a3\u20ac\u00a5\u20b9]/;

const SUM_FIELDS = [
  "elements",
  "textLen",
  "links",
  "internalLinks",
  "externalLinks",
  "socialLinks",
  "contactLinks",
  "headings",
  "listItems",
  "images",
  "videos",
  "iframes",
  "forms",
  "inputs",
  "buttons",
  "paragraphs",
  "searchInputs",
  "ariaAttrs",
  "tabindexes",
  "dialogHints",
  "timeElements",
  "tables",
  "codeBlocks",
  "copyrightHits",
  "yearHits",
  "consentHits",
  "priceHits",
  "dateHits",
  "bylineHits",
  "cartHits",
  "commentHits",
  "paginationHits",
  "breadcrumbHits",
  "readingTimeHits",
] as const;

function foldSubtrees(walk: Walk): void {
  const fields = SUM_FIELDS.map((name) => walk[name]);
  // Reverse document order: every descendant has a higher index than its
  // ancestor, so a node's totals are final by the time it is folded upward.
  for (let i = walk.count - 1; i >= 1; i--) {
    const parent = walk.parent[i]!;
    if (parent < 0) continue;
    for (const field of fields) field[parent]! += field[i]!;
    if (walk.minHeading[i]! < walk.minHeading[parent]!) {
      walk.minHeading[parent] = walk.minHeading[i]!;
    }
    // A link's anchor text is its whole subtree text; a nested link is absorbed
    // by the outer one rather than counted twice.
    if (walk.isLink[i]) walk.linkTextLen[i] = walk.textLen[i]!;
    walk.linkTextLen[parent]! += walk.linkTextLen[i]!;
    // A paragraph contributes its own subtree text to its own total too, so
    // avgParagraphLength is right when the candidate IS the paragraph.
    if (walk.tag[i] === "p") walk.paragraphTextLen[i]! += walk.textLen[i]!;
    walk.paragraphTextLen[parent]! += walk.paragraphTextLen[i]!;
    // OVERWRITE, not add: a list item's text is its whole subtree, and lists
    // nest. A mega menu is <li> inside <li> inside <li>, and adding at each
    // level counted the same characters once per level -- which produced a
    // "share" of 1.79 on exactly the nav elements this feature was meant to
    // identify. Assigning absorbs the nested items into the outermost one, the
    // same way linkTextLen absorbs a nested link.
    if (walk.tag[i] === "li") walk.listItemTextLen[i] = walk.textLen[i]!;
    walk.listItemTextLen[parent]! += walk.listItemTextLen[i]!;
  }
  if (walk.count > 0 && walk.isLink[0]) walk.linkTextLen[0] = walk.textLen[0]!;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

function isCandidate(walk: Walk, i: number, childCount: number): boolean {
  const tag = walk.tag[i]!;
  if (tag === "body" || tag === "html") return false;
  if (MEDIA_TAGS.has(tag)) return true;
  if (walk.role[i]) return true;
  if (!REGION_TAGS.has(tag)) return false;
  if (!SIZE_GATED_TAGS.has(tag)) return true;
  return childCount >= 2 || walk.textLen[i]! >= 20;
}

/**
 * Which candidates survive the per-page cap, in three priority tiers:
 *
 *   0. landmarks — they ARE a region label source, so dropping one drops a
 *      training row and, worse, makes the page look like it has fewer
 *      landmarks than it does;
 *   1. sectioning content and the body's own children — they decide whether a
 *      <header> is site chrome or an article's own, and they are the page's
 *      top-level structure;
 *   2. everything else.
 *
 * Within a tier: biggest subtree first, document order breaks every tie. No
 * randomness anywhere, so two runs over the same bytes select the same nodes.
 */
function selectCandidates(walk: Walk, childCounts: Int32Array, cap: number): number[] {
  const tiers: number[][] = [[], [], []];
  for (let i = 0; i < walk.count; i++) {
    if (!isCandidate(walk, i, childCounts[i]!)) continue;
    const tag = walk.tag[i]!;
    const role = walk.role[i]!;
    const parent = walk.parent[i]!;
    const parentTag = parent >= 0 ? walk.tag[parent]! : "";
    if (LANDMARK_TAGS.has(tag) || LANDMARK_ROLES.has(role)) tiers[0]!.push(i);
    else if (SECTIONING_TAGS.has(tag) || parentTag === "body") tiers[1]!.push(i);
    else tiers[2]!.push(i);
  }
  const total = tiers[0]!.length + tiers[1]!.length + tiers[2]!.length;
  if (total <= cap) return tiers.flat().sort((a, b) => a - b);

  const bySize = (a: number, b: number): number => walk.elements[b]! - walk.elements[a]! || a - b;
  const kept: number[] = [];
  for (const tier of tiers) {
    if (kept.length >= cap) break;
    tier.sort(bySize);
    for (const i of tier) {
      if (kept.length >= cap) break;
      kept.push(i);
    }
  }
  return kept.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Feature emission
// ---------------------------------------------------------------------------

export const NODE_FEATURE_NAMES: string[] = [
  // structure
  "depth",
  "startPos",
  "endPos",
  "subtreeElements",
  "subtreeElementFraction",
  "textLength",
  "textFraction",
  "directChildCount",
  "distinctChildTags",
  "maxRepeatedSiblingRun",
  "siblingIndex",
  "siblingCount",
  "siblingFraction",
  "isFirstElementChild",
  "isLastElementChild",
  "isBodyChild",
  "isFirstBodyChild",
  "isLastBodyChild",
  // Ancestor and sibling context (v2.1.0). Added because the confusion matrix
  // said article_chrome loses 55% of its nodes to content_block and sidebar
  // loses 33%, and neither pair is separable from a node's own statistics:
  // both are about WHERE the node sits relative to the section it belongs to
  // and to the page's other top-level blocks. None of these reads a landmark
  // tag or role, so the mask is unaffected.
  "sectionAncestorDistance",
  "sectionAncestorTextShare",
  "sectionAncestorElementShare",
  "isFirstChildOfSection",
  "isLastChildOfSection",
  "siblingSectionCount",
  "bodyBlockSizeRatio",
  "bodyBlockIndexShare",
  "listItemTextShare",
  "firstChildIsHeading",
  // links
  "linkCount",
  "linkDensity",
  "internalLinkShare",
  "externalLinkShare",
  "socialLinkCount",
  "contactLinkCount",
  // text shape
  "headingCount",
  "minHeadingLevel",
  "listItemCount",
  "paragraphCount",
  "avgParagraphLength",
  // media and controls
  "imageCount",
  "videoCount",
  "iframeCount",
  "formCount",
  "inputCount",
  "buttonCount",
  "tableCount",
  "codeBlockCount",
  "timeElementCount",
  "searchInputCount",
  // accessibility hints
  "ariaAttrCount",
  "tabindexCount",
  "dialogHintCount",
  // text patterns
  "hasCopyright",
  "hasYear",
  "hasConsentWords",
  "hasPrice",
  "hasDate",
  "hasByline",
  "hasCartWords",
  "hasCommentWords",
  "hasPaginationWords",
  "hasBreadcrumbWords",
  "hasReadingTime",
  // categorical
  "tagId",
  "roleId",
  "parentTagId",
  "grandparentTagId",
  // curated vocabulary, self then parent
  ...CURATED_VOCAB.map((w) => `self_${w}`),
  ...CURATED_VOCAB.map((w) => `parent_${w}`),
];

/**
 * The curated-vocabulary block is contiguous and sits at the END of the node
 * vector, so its bits are written by index rather than by name. Building all
 * 187 values in one object and then reading them back by string key added ~130
 * dynamic property writes per node, which put the object into dictionary mode
 * and made emission the most expensive thing in this file.
 */
const SELF_VOCAB_BASE = NODE_FEATURE_NAMES.length - 2 * CURATED_VOCAB.length;
const PARENT_VOCAB_BASE = NODE_FEATURE_NAMES.length - CURATED_VOCAB.length;

export const PAGE_FEATURE_NAMES: string[] = [
  // url shape
  "urlPathDepth",
  "urlSegmentCount",
  "urlIsRoot",
  "urlHasDate",
  "urlHasNumericId",
  "urlHasQuery",
  "urlLastSegmentLength",
  "urlLastSegmentWords",
  "urlHasFileExtension",
  ...PATH_SLUGS.map(([name]) => `urlSlug_${name}`),
  // document shape
  "titleLength",
  "h1Length",
  "totalTextLength",
  "elementCount",
  "maxDepth",
  "paragraphCount",
  "avgParagraphLength",
  "maxParagraphLength",
  "h1Count",
  "h2Count",
  "h3Count",
  "h4Count",
  "h5Count",
  "h6Count",
  "linkCount",
  "linkDensity",
  "internalLinkShare",
  "externalLinkShare",
  "socialLinkCount",
  "contactLinkCount",
  "formCount",
  "inputCount",
  "buttonCount",
  "searchInputCount",
  "imageCount",
  "videoCount",
  "iframeCount",
  "tableCount",
  "codeBlockCount",
  "listCount",
  "listItemCount",
  "timeElementCount",
  // landmarks (structure, not the page-type label source)
  "headerCount",
  "footerCount",
  "navCount",
  "asideCount",
  "mainCount",
  "articleCount",
  "sectionCount",
  "dialogCount",
  "landmarkKindCount",
  // page-level patterns
  "priceHitCount",
  "dateHitCount",
  "bylineHitCount",
  "cartHitCount",
  "consentHitCount",
  "commentHitCount",
  "paginationHitCount",
  "breadcrumbHitCount",
  "copyrightHitCount",
  "hasReadingTime",
  "hasAuthorRel",
  // body token vocabulary
  ...CURATED_VOCAB.map((w) => `body_${w}`),
];

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Hops from a node up to its nearest <article>/<section> ancestor; 0 when it
 *  has none, which is also the value for a node sitting directly in one's
 *  place, so the two are told apart by sectionAncestorTextShare being 0. */
function sectionDistance(walk: Walk, i: number): number {
  const target = walk.sectionAncestor[i]!;
  if (target < 0) return 0;
  let hops = 0;
  let current = walk.parent[i]!;
  while (current >= 0 && hops < 64) {
    hops++;
    if (current === target) return hops;
    current = walk.parent[current]!;
  }
  return hops;
}

interface EmitContext {
  walk: Walk;
  childCounts: Int32Array;
  distinctChildTags: Int32Array;
  maxRepeatedRun: Int32Array;
  subtreeEnd: Int32Array;
  /** article/section children per element, for the sibling-section count. */
  sectionChildCount: Int32Array;
  /** 1 when an element's first element child is a heading. */
  firstChildHeading: Uint8Array;
  /** Subtree elements of the largest direct element child of <body>. */
  largestBodyBlock: number;
  /** Number of direct element children of <body>. */
  bodyChildCount: number;
  /** Lazily built class+id tokens, keyed by element index. */
  tokenCache: Array<string[] | undefined>;
  pageElements: number;
  pageText: number;
}

/** Tokens for one element, computed once and cached. Only candidates and their
 *  parents ever ask, which is <= 800 elements rather than every element. */
function tokensOf(ctx: EmitContext, i: number): string[] {
  const cached = ctx.tokenCache[i];
  if (cached !== undefined) return cached;
  const built = tokenize(ctx.walk.classAttr[i]!).concat(tokenize(ctx.walk.idAttr[i]!));
  ctx.tokenCache[i] = built;
  return built;
}

function emitNodeVector(ctx: EmitContext, i: number, mask: boolean, maskAll = false): number[] {
  const { walk } = ctx;
  const parent = walk.parent[i]!;
  const grandparent = parent >= 0 ? walk.parent[parent]! : -1;
  const parentTag = parent >= 0 ? walk.tag[parent]! : "";
  const grandparentTag = grandparent >= 0 ? walk.tag[grandparent]! : "";
  const siblings = parent >= 0 ? ctx.childCounts[parent]! : 1;
  const textLen = walk.textLen[i]!;
  const section = walk.sectionAncestor[i]!;
  const block = walk.bodyBlock[i]!;

  // Masking: the node's own landmark tag and role, and any landmark ancestor
  // tag, become an ordinary div with no role. Nothing else in the vector is
  // derived from a landmark tag, which is what makes the masked <footer> and
  // masked <div> vectors identical.
  const tag = mask && LANDMARK_TAGS.has(walk.tag[i]!) ? "div" : walk.tag[i]!;
  const rawRole = walk.role[i]! || IMPLICIT_ROLE[walk.tag[i]!] || "";
  const role = mask && LANDMARK_ROLES.has(rawRole) ? "" : rawRole;
  const maskTag = (candidate: string): string =>
    mask && LANDMARK_TAGS.has(candidate) ? "div" : candidate;

  const values: Record<string, number> = {
    depth: walk.depth[i]!,
    startPos: ratio(i, ctx.pageElements),
    endPos: ratio(ctx.subtreeEnd[i]!, ctx.pageElements),
    subtreeElements: walk.elements[i]!,
    subtreeElementFraction: ratio(walk.elements[i]!, ctx.pageElements),
    textLength: textLen,
    textFraction: ratio(textLen, ctx.pageText),
    directChildCount: ctx.childCounts[i]!,
    distinctChildTags: ctx.distinctChildTags[i]!,
    maxRepeatedSiblingRun: ctx.maxRepeatedRun[i]!,
    siblingIndex: walk.siblingIndex[i]!,
    siblingCount: siblings,
    siblingFraction: ratio(walk.siblingIndex[i]!, Math.max(1, siblings - 1)),
    isFirstElementChild: walk.siblingIndex[i]! === 0 ? 1 : 0,
    isLastElementChild: walk.siblingIndex[i]! === siblings - 1 ? 1 : 0,
    isBodyChild: parentTag === "body" ? 1 : 0,
    isFirstBodyChild: parentTag === "body" && walk.siblingIndex[i]! === 0 ? 1 : 0,
    isLastBodyChild: parentTag === "body" && walk.siblingIndex[i]! === siblings - 1 ? 1 : 0,
    sectionAncestorDistance: sectionDistance(walk, i),
    sectionAncestorTextShare: section >= 0 ? ratio(textLen, walk.textLen[section]!) : 0,
    sectionAncestorElementShare:
      section >= 0 ? ratio(walk.elements[i]!, walk.elements[section]!) : 0,
    isFirstChildOfSection:
      section >= 0 && parent === section && walk.siblingIndex[i]! === 0 ? 1 : 0,
    isLastChildOfSection:
      section >= 0 && parent === section && walk.siblingIndex[i]! === ctx.childCounts[section]! - 1
        ? 1
        : 0,
    siblingSectionCount: parent >= 0 ? ctx.sectionChildCount[parent]! : 0,
    bodyBlockSizeRatio: block >= 0 ? ratio(walk.elements[block]!, ctx.largestBodyBlock) : 0,
    bodyBlockIndexShare:
      block >= 0 ? ratio(walk.siblingIndex[block]!, Math.max(1, ctx.bodyChildCount - 1)) : 0,
    listItemTextShare: ratio(walk.listItemTextLen[i]!, textLen),
    firstChildIsHeading: ctx.firstChildHeading[i]!,
    linkCount: walk.links[i]!,
    linkDensity: ratio(walk.linkTextLen[i]!, textLen),
    internalLinkShare: ratio(walk.internalLinks[i]!, walk.links[i]!),
    externalLinkShare: ratio(walk.externalLinks[i]!, walk.links[i]!),
    socialLinkCount: walk.socialLinks[i]!,
    contactLinkCount: walk.contactLinks[i]!,
    headingCount: walk.headings[i]!,
    minHeadingLevel: walk.minHeading[i]! === 7 ? 0 : walk.minHeading[i]!,
    listItemCount: walk.listItems[i]!,
    paragraphCount: walk.paragraphs[i]!,
    avgParagraphLength: ratio(walk.paragraphTextLen[i]!, walk.paragraphs[i]!),
    imageCount: walk.images[i]!,
    videoCount: walk.videos[i]!,
    iframeCount: walk.iframes[i]!,
    formCount: walk.forms[i]!,
    inputCount: walk.inputs[i]!,
    buttonCount: walk.buttons[i]!,
    tableCount: walk.tables[i]!,
    codeBlockCount: walk.codeBlocks[i]!,
    timeElementCount: walk.timeElements[i]!,
    searchInputCount: walk.searchInputs[i]!,
    ariaAttrCount: walk.ariaAttrs[i]!,
    tabindexCount: walk.tabindexes[i]!,
    dialogHintCount: walk.dialogHints[i]!,
    hasCopyright: walk.copyrightHits[i]! > 0 ? 1 : 0,
    hasYear: walk.yearHits[i]! > 0 ? 1 : 0,
    hasConsentWords: walk.consentHits[i]! > 0 ? 1 : 0,
    hasPrice: walk.priceHits[i]! > 0 ? 1 : 0,
    hasDate: walk.dateHits[i]! > 0 ? 1 : 0,
    hasByline: walk.bylineHits[i]! > 0 ? 1 : 0,
    hasCartWords: walk.cartHits[i]! > 0 ? 1 : 0,
    hasCommentWords: walk.commentHits[i]! > 0 ? 1 : 0,
    hasPaginationWords: walk.paginationHits[i]! > 0 ? 1 : 0,
    hasBreadcrumbWords: walk.breadcrumbHits[i]! > 0 ? 1 : 0,
    hasReadingTime: walk.readingTimeHits[i]! > 0 ? 1 : 0,
    tagId: TAG_INDEX.get(tag) ?? 0,
    roleId: ROLE_INDEX.get(role) ?? 0,
    parentTagId: TAG_INDEX.get(maskTag(parentTag)) ?? 0,
    grandparentTagId: TAG_INDEX.get(maskTag(grandparentTag)) ?? 0,
  };

  const out: number[] = Array.from({ length: NODE_FEATURE_NAMES.length }, () => 0);
  for (let f = 0; f < SELF_VOCAB_BASE; f++) out[f] = values[NODE_FEATURE_NAMES[f]!] ?? 0;

  for (const token of tokensOf(ctx, i)) {
    setVocabBit(out, token, SELF_VOCAB_BASE, mask, i, "", maskAll);
  }
  if (parent >= 0) {
    for (const token of tokensOf(ctx, parent)) {
      setVocabBit(out, token, PARENT_VOCAB_BASE, mask, i, "p:", maskAll);
    }
  }

  return out;
}

/** Set one curated-vocabulary bit, honouring the masked dropout. */
function setVocabBit(
  out: number[],
  token: string,
  base: number,
  mask: boolean,
  nodeId: number,
  seedPrefix: string,
  maskAll: boolean,
): void {
  if (mask && LABEL_WORDS.has(token) && dropsUnderMask(nodeId, `${seedPrefix}${token}`, maskAll)) {
    return;
  }
  const slot = CURATED_INDEX.get(token);
  if (slot !== undefined) out[base + slot] = 1;
}

function emitNodeTokens(
  ctx: EmitContext,
  i: number,
  mask: boolean,
  maskAll = false,
): { tokens: number[]; textTokens: number[] } {
  const { walk } = ctx;
  const parent = walk.parent[i]!;
  // Two streams in the same 512 buckets: the class/id stream is exactly what v2.2.0 emitted (the region head trained on it), the
  // text/attribute stream is the v2.3.0 addition (the section head reads the union).
  const legacy = new Set<number>();
  const text = new Set<number>();
  const add = (token: string, prefix: "s:" | "p:" | "t:" | "st:" | "a:" | "r:" | "h:"): void => {
    const seed = prefix === "s:" ? token : `${prefix}${token}`;
    if (mask && LABEL_WORDS.has(token) && dropsUnderMask(i, seed, maskAll)) return;
    (prefix === "s:" || prefix === "p:" ? legacy : text).add(tokenBucket(`${prefix}${token}`));
  };
  for (const token of tokensOf(ctx, i)) add(token, "s:");
  if (parent >= 0) {
    for (const token of tokensOf(ctx, parent)) add(token, "p:");
  }
  // v2.3.0 text/attribute channel. The label-word mask applies exactly as for class/id tokens: a word such as
  // "navigation" in an aria-label says the same thing as the class name, so it drops with the same coin per prefix.
  for (const word of textWords(walk.ownText[i]!, MAX_TEXT_WORDS)) add(word, "t:");
  for (const word of textWords(walk.ariaLabel.get(i) ?? "", MAX_TEXT_WORDS)) add(word, "a:");
  // The subtree is the contiguous index range [i, end]; the first MAX_SUBTREE_ELEMENTS of it feed the subtree words and
  // the anchor hosts, so a container whose text lives in its grandchildren still says what it is.
  const end = ctx.subtreeEnd[i]!;
  const windowEnd = Math.min(end, i + MAX_SUBTREE_ELEMENTS - 1);
  for (let j = i, words = 0; j <= windowEnd && words < MAX_TEXT_WORDS; j++) {
    const text = walk.ownText[j]!;
    if (text === "") continue;
    for (const word of textWords(text, MAX_TEXT_WORDS - words)) {
      add(word, "st:");
      words++;
    }
  }
  // The anchors inside this subtree (the node itself counts) in document order: rel values from the first
  // MAX_TOKEN_ANCHORS, host tags from those inside the element window.
  let lo = 0;
  let hi = walk.anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (walk.anchors[mid]! < i) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo, taken = 0; k < walk.anchors.length && walk.anchors[k]! <= end; k++, taken++) {
    const inWindow = walk.anchors[k]! <= windowEnd;
    if (taken >= MAX_TOKEN_ANCHORS && !inWindow) break;
    if (taken < MAX_TOKEN_ANCHORS) {
      for (const value of walk.anchorRel[k]!) add(value, "r:");
    }
    const host = walk.anchorHost[k]!;
    if (inWindow && host !== "") add(host, "h:");
  }
  const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
  return { tokens: sorted(legacy), textTokens: sorted(text) };
}

// ---------------------------------------------------------------------------
// Page vector
// ---------------------------------------------------------------------------

function emitPageVector(
  walk: Walk,
  ctx: EmitContext,
  url: string,
  title: string,
  h1: string,
  hasAuthorRel: boolean,
): { features: number[]; tokens: number[]; landmarkKinds: string[] } {
  const { path, segments, query } = splitUrl(url);
  const last = segments.length > 0 ? segments[segments.length - 1]! : "";
  const values: Record<string, number> = {
    urlPathDepth: segments.length,
    urlSegmentCount: segments.length,
    urlIsRoot: path === "/" || path === "" ? 1 : 0,
    urlHasDate: /\/(19|20)\d{2}\/(0?[1-9]|1[0-2])(\/|$)/.test(path) ? 1 : 0,
    urlHasNumericId: /(^|\/|-)\d{2,}(\/|$|[-.])/.test(path) ? 1 : 0,
    urlHasQuery: query ? 1 : 0,
    urlLastSegmentLength: last.length,
    urlLastSegmentWords: last ? last.split(/[-_]/).filter(Boolean).length : 0,
    urlHasFileExtension: /\.[a-z0-9]{2,5}$/i.test(last) ? 1 : 0,
    titleLength: title.length,
    h1Length: h1.length,
    totalTextLength: walk.count > 0 ? walk.textLen[0]! : 0,
    elementCount: walk.count,
    maxDepth: 0,
    paragraphCount: walk.count > 0 ? walk.paragraphs[0]! : 0,
    avgParagraphLength: walk.count > 0 ? ratio(walk.paragraphTextLen[0]!, walk.paragraphs[0]!) : 0,
    maxParagraphLength: 0,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    linkCount: walk.count > 0 ? walk.links[0]! : 0,
    linkDensity: walk.count > 0 ? ratio(walk.linkTextLen[0]!, walk.textLen[0]!) : 0,
    internalLinkShare: walk.count > 0 ? ratio(walk.internalLinks[0]!, walk.links[0]!) : 0,
    externalLinkShare: walk.count > 0 ? ratio(walk.externalLinks[0]!, walk.links[0]!) : 0,
    socialLinkCount: walk.count > 0 ? walk.socialLinks[0]! : 0,
    contactLinkCount: walk.count > 0 ? walk.contactLinks[0]! : 0,
    formCount: walk.count > 0 ? walk.forms[0]! : 0,
    inputCount: walk.count > 0 ? walk.inputs[0]! : 0,
    buttonCount: walk.count > 0 ? walk.buttons[0]! : 0,
    searchInputCount: walk.count > 0 ? walk.searchInputs[0]! : 0,
    imageCount: walk.count > 0 ? walk.images[0]! : 0,
    videoCount: walk.count > 0 ? walk.videos[0]! : 0,
    iframeCount: walk.count > 0 ? walk.iframes[0]! : 0,
    tableCount: walk.count > 0 ? walk.tables[0]! : 0,
    codeBlockCount: walk.count > 0 ? walk.codeBlocks[0]! : 0,
    listCount: 0,
    listItemCount: walk.count > 0 ? walk.listItems[0]! : 0,
    timeElementCount: walk.count > 0 ? walk.timeElements[0]! : 0,
    headerCount: 0,
    footerCount: 0,
    navCount: 0,
    asideCount: 0,
    mainCount: 0,
    articleCount: 0,
    sectionCount: 0,
    dialogCount: 0,
    landmarkKindCount: 0,
    priceHitCount: walk.count > 0 ? walk.priceHits[0]! : 0,
    dateHitCount: walk.count > 0 ? walk.dateHits[0]! : 0,
    bylineHitCount: walk.count > 0 ? walk.bylineHits[0]! : 0,
    cartHitCount: walk.count > 0 ? walk.cartHits[0]! : 0,
    consentHitCount: walk.count > 0 ? walk.consentHits[0]! : 0,
    commentHitCount: walk.count > 0 ? walk.commentHits[0]! : 0,
    paginationHitCount: walk.count > 0 ? walk.paginationHits[0]! : 0,
    breadcrumbHitCount: walk.count > 0 ? walk.breadcrumbHits[0]! : 0,
    copyrightHitCount: walk.count > 0 ? walk.copyrightHits[0]! : 0,
    hasReadingTime: walk.count > 0 && walk.readingTimeHits[0]! > 0 ? 1 : 0,
    hasAuthorRel: hasAuthorRel ? 1 : 0,
  };
  for (const [name, slugs] of PATH_SLUGS) {
    values[`urlSlug_${name}`] = segments.some((segment) => slugs.includes(segment)) ? 1 : 0;
  }

  const landmarkKinds = new Set<string>();
  let maxDepth = 0;
  let maxParagraph = 0;
  for (let i = 0; i < walk.count; i++) {
    const tag = walk.tag[i]!;
    if (walk.depth[i]! > maxDepth) maxDepth = walk.depth[i]!;
    if (tag === "p" && walk.textLen[i]! > maxParagraph) maxParagraph = walk.textLen[i]!;
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        values[`${tag}Count`] = (values[`${tag}Count`] ?? 0) + 1;
        break;
      case "ul":
      case "ol":
        values.listCount = (values.listCount ?? 0) + 1;
        break;
      case "header":
      case "footer":
      case "nav":
      case "aside":
      case "main":
      case "dialog":
        values[`${tag}Count`] = (values[`${tag}Count`] ?? 0) + 1;
        landmarkKinds.add(tag);
        break;
      case "article":
      case "section":
        values[`${tag}Count`] = (values[`${tag}Count`] ?? 0) + 1;
        break;
      default:
        break;
    }
    const role = walk.role[i]!;
    if (LANDMARK_ROLES.has(role)) landmarkKinds.add(role);
  }
  values.maxDepth = maxDepth;
  values.maxParagraphLength = maxParagraph;
  values.landmarkKindCount = landmarkKinds.size;

  // Body class/id tokens: WordPress and Shopify both stamp the page template
  // there, which is the strongest page-type signal that is not schema.
  const bodyTokens =
    walk.count > 0 ? tokenize(walk.classAttr[0]!).concat(tokenize(walk.idAttr[0]!)) : [];
  for (const word of CURATED_VOCAB) values[`body_${word}`] = 0;
  const buckets = new Set<number>();
  for (const token of bodyTokens) {
    if (CURATED_INDEX.has(token)) values[`body_${token}`] = 1;
    buckets.add(tokenBucket(`b:${token}`));
  }

  return {
    features: PAGE_FEATURE_NAMES.map((name) => values[name] ?? 0),
    tokens: [...buckets].sort((a, b) => a - b),
    landmarkKinds: [...landmarkKinds].sort(),
  };
}

function splitUrl(url: string): { path: string; segments: string[]; query: string } {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = withoutScheme.indexOf("/");
  const rest = slash === -1 ? "/" : withoutScheme.slice(slash);
  const hash = rest.indexOf("#");
  const noHash = hash === -1 ? rest : rest.slice(0, hash);
  const questionMark = noHash.indexOf("?");
  const path = questionMark === -1 ? noHash : noHash.slice(0, questionMark);
  const query = questionMark === -1 ? "" : noHash.slice(questionMark + 1);
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return { path, segments, query };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parse with the SAME entry the CLI uses, so inference sees identical DOMs. */
export function featurizePage(
  html: string,
  url: string,
  options: FeaturizeOptions = {},
): FeaturizedPage {
  const { document } = parseHTML(html);
  return featurizeDocument(document as unknown as ParsedDocument, url, options);
}

interface ParsedDocument {
  body: ElementLike | null;
  documentElement: ElementLike | null;
  title?: string;
  querySelector(selector: string): ElementLike | null;
}

/**
 * The document's body, or its root element, or null.
 *
 * linkedom's `body` getter destructures `documentElement.firstElementChild`,
 * so on a document that has no documentElement at all -- an empty response, a
 * PDF served as text/html, a truncated blob -- it THROWS rather than returning
 * null. A crawler meets those, so reading it defensively is not paranoia.
 */
function safeRoot(document: ParsedDocument): ElementLike | null {
  try {
    return document.body ?? document.documentElement ?? null;
  } catch {
    return null;
  }
}

export function featurizeDocument(
  document: ParsedDocument,
  url: string,
  options: FeaturizeOptions = {},
): FeaturizedPage {
  if (options.elementsOut) options.elementsOut.length = 0;
  if (options.attributesOut) {
    options.attributesOut.classAttr = [];
    options.attributesOut.idAttr = [];
    options.attributesOut.subtreeSize = [];
  }
  const root = safeRoot(document);
  const host = hostOf(url);
  const empty: FeaturizedPage = {
    page: {
      features: PAGE_FEATURE_NAMES.map(() => 0),
      tokens: [],
      elementCount: 0,
      divSoup: true,
      landmarkKinds: [],
    },
    nodes: [],
  };
  if (!root) return empty;

  const walk = walkDocument(root, host, options.elementsOut);
  if (walk.count === 0) return empty;
  flagPatterns(walk);
  foldSubtrees(walk);
  if (options.attributesOut) {
    options.attributesOut.classAttr = walk.classAttr;
    options.attributesOut.idAttr = walk.idAttr;
    // Folded: `elements` now counts each subtree (see subtreeEnd below).
    options.attributesOut.subtreeSize = walk.elements;
  }

  // Child-derived shape features, and the subtree end index used for endPos.
  const childCounts = new Int32Array(walk.count);
  const distinctChildTags = new Int32Array(walk.count);
  const maxRepeatedRun = new Int32Array(walk.count);
  const subtreeEnd = new Int32Array(walk.count);
  const sectionChildCount = new Int32Array(walk.count);
  const firstChildHeading = new Uint8Array(walk.count);
  const tags = new Set<string>();
  for (let i = 0; i < walk.count; i++) {
    const kids = walk.children[i]!;
    childCounts[i] = kids.length;
    const firstKid = kids[0];
    if (firstKid !== undefined) {
      const kidTag = walk.tag[firstKid]!;
      if (kidTag.length === 2 && kidTag[0] === "h" && kidTag[1]! >= "1" && kidTag[1]! <= "6") {
        firstChildHeading[i] = 1;
      }
    }
    let sections = 0;
    for (const kid of kids) {
      const kidTag = walk.tag[kid]!;
      if (kidTag === "article" || kidTag === "section") sections++;
    }
    sectionChildCount[i] = sections;
    subtreeEnd[i] = i + walk.elements[i]! - 1;
    tags.clear();
    let run = kids.length > 0 ? 1 : 0;
    let best = run;
    let previous = "";
    for (let k = 0; k < kids.length; k++) {
      const kid = kids[k]!;
      tags.add(walk.tag[kid]!);
      // Shape = the child's tag plus the tags of ITS children: a card grid is
      // five <li> that each hold an <img>, an <h3> and an <a>.
      const shape = walk.shapeKey[kid]!;
      if (k > 0) run = shape === previous ? run + 1 : 1;
      if (run > best) best = run;
      previous = shape;
    }
    distinctChildTags[i] = tags.size;
    maxRepeatedRun[i] = best;
  }

  const pageElements = walk.count;
  const pageText = walk.textLen[0]!;
  // Body-level block statistics: a sidebar is a small block sitting beside a
  // much larger one, which is measurable without knowing either one's tag.
  let largestBodyBlock = 0;
  let bodyChildCount = 0;
  for (const child of walk.children[0] ?? []) {
    bodyChildCount++;
    if (walk.elements[child]! > largestBodyBlock) largestBodyBlock = walk.elements[child]!;
  }

  const ctx: EmitContext = {
    walk,
    childCounts,
    distinctChildTags,
    maxRepeatedRun,
    subtreeEnd,
    sectionChildCount,
    firstChildHeading,
    largestBodyBlock,
    bodyChildCount,
    tokenCache: Array.from({ length: walk.count }),
    pageElements,
    pageText,
  };

  const title = (document.title ?? "").trim();
  const h1El = document.querySelector("h1");
  const h1 = h1El ? normalizeText(textOf(h1El)) : "";
  const hasAuthorRel = document.querySelector('[rel~="author"]') !== null;
  const pageVector = emitPageVector(walk, ctx, url, title, h1, hasAuthorRel);

  const cap = options.maxCandidates ?? MAX_CANDIDATES;
  const selected = selectCandidates(walk, childCounts, cap);
  const selectedSet = new Set(selected);

  const nodes: NodeFeatures[] = selected.map((i) => {
    let ancestor = walk.parent[i]!;
    while (ancestor >= 0 && !selectedSet.has(ancestor)) ancestor = walk.parent[ancestor]!;
    const emitted = emitNodeTokens(ctx, i, options.mask === true, options.maskAll === true);
    const node: NodeFeatures = {
      nodeId: i,
      tag: walk.tag[i]!,
      role: walk.role[i]!,
      elementId: walk.elementId[i]!,
      parentCandidateId: ancestor,
      parentId: walk.parent[i]!,
      depth: walk.depth[i]!,
      features: emitNodeVector(ctx, i, options.mask === true, options.maskAll === true),
      tokens: emitted.tokens,
      textTokens: emitted.textTokens,
      masked: options.mask === true,
    };
    if (options.emitMasked && !options.mask) {
      node.maskedFeatures = emitNodeVector(ctx, i, true, options.maskAll === true);
      const maskedEmitted = emitNodeTokens(ctx, i, true, options.maskAll === true);
      node.maskedTokens = maskedEmitted.tokens;
      node.maskedTextTokens = maskedEmitted.textTokens;
    }
    return node;
  });

  return {
    page: {
      features: pageVector.features,
      tokens: pageVector.tokens,
      elementCount: walk.count,
      divSoup: pageVector.landmarkKinds.length < 2,
      landmarkKinds: pageVector.landmarkKinds,
    },
    nodes,
  };
}

function textOf(el: ElementLike): string {
  let out = "";
  const stack: ElementLike[] = [el];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === NODE_TEXT) {
      out += node.data ?? "";
      continue;
    }
    const children: ElementLike[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return out;
}

/** The ordered schema both the dataset and the trained artifact carry. */
export function featureSchema(): Record<string, unknown> {
  return {
    featurizerVersion: FEATURIZER_VERSION,
    nodeFeatures: NODE_FEATURE_NAMES,
    pageFeatures: PAGE_FEATURE_NAMES,
    nodeFeatureCount: NODE_FEATURE_NAMES.length,
    pageFeatureCount: PAGE_FEATURE_NAMES.length,
    tokenBuckets: TOKEN_BUCKETS,
    tokenHash: {
      algorithm: "fnv1a-32",
      offsetBasis: 2166136261,
      prime: 16777619,
      note: "bucket = fnv1a32(prefixedToken) % 512; prefixes s: self, p: parent, b: body; v2.3.0 adds a second node stream (textTokens): t: own-text word, st: subtree word, a: aria-label word, r: anchor rel, h: anchor host tag",
    },
    curatedVocab: CURATED_VOCAB,
    tagVocab: TAG_VOCAB,
    roleVocab: ROLE_VOCAB,
    labelWords: [...LABEL_WORDS].sort(),
    maxCandidates: MAX_CANDIDATES,
    maxTokensPerElement: MAX_TOKENS_PER_ELEMENT,
  };
}
