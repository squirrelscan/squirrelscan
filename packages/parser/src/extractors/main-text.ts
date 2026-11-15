// Main text and markdown from a parsed page (#2359).
//
// `getMainContent` (./content.ts) takes the first match of a selector list, else the whole body, so
// navigation, footers, cookie banners, ads and chat widgets end up in "the page's text". This
// extractor walks the DOM once and keeps only what a reader would call the page's content, as
// blocks (headings, paragraphs, lists, tables, code, quotes) that each carry the region and section
// label they sat in, so a later rule can report per section.
//
// Two sources decide what to drop, in this order:
//   1. a placer (the #2307 DOM classifier, injected as a plain function: the parser never imports
//      the classifier, the classifier imports the parser), asked once per container or block;
//   2. the markup, when the placer is absent or abstains: landmarks, plus conservative class/id
//      tokens for the furniture the classifier may not name (cookie banners, ad slots, chat widgets,
//      newsletter boxes, share bars).
//
// Nothing here mutates the document, and the walk is iterative: pages can nest 100k elements deep.

import type { ClassifierSource } from "@squirrelscan/core-contracts";
import type { Document, Element, Node } from "linkedom";

import type { PlacedLabel } from "./link-section";

// ---------------------------------------------------------------------------
// The exact label sets. Exported so a consumer can read what "main text" means.
// ---------------------------------------------------------------------------

/** Region labels that are the page's content. Anything else the placer names is not kept. */
export const MAIN_TEXT_KEPT_REGIONS: ReadonlySet<string> = new Set([
  "main_content",
  "content_block",
]);

/**
 * Region labels dropped with their whole subtree: the site's furniture (`site_chrome` is the model's
 * "one of the four, unsure which"), plus dialogs, search boxes, forms and `article_chrome` (the
 * title/byline/share rows around an article body). One exception, `article_chrome` only: its
 * headings survive (see `decide`), because the page's h1 sits in that header.
 */
export const MAIN_TEXT_DROPPED_REGIONS: ReadonlySet<string> = new Set([
  "site_header",
  "navigation",
  "footer",
  "sidebar",
  "site_chrome",
  "dialog",
  "search",
  "form",
  "article_chrome",
]);

/**
 * Section purposes dropped with their subtree. Exactly the six the issue names, nothing more.
 * `chat_widget` is not a class the classifier emits today (the markup patterns below cover it); the
 * label is accepted here so a placer that learns it needs no change. Comment threads, related
 * content, breadcrumbs, pagination and bylines are KEPT and labelled: they are text a reader sees
 * and a rule may want to judge or skip per section.
 */
export const MAIN_TEXT_DROPPED_SECTIONS: ReadonlySet<string> = new Set([
  "ad",
  "cookie_consent",
  "chat_widget",
  "newsletter_signup",
  "social_share",
  "promo_banner",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A label on a block: who gave it, how sure, and the classifier node that answered (null for markup). */
export interface ContentLabel {
  label: string;
  source: ClassifierSource;
  confidence: number;
  nodeId: number | null;
}

export type ContentBlockKind = "heading" | "paragraph" | "list" | "table" | "code" | "quote";

export interface ContentBlock {
  kind: ContentBlockKind;
  /** Plain text. Code is verbatim; everything else has whitespace collapsed. */
  text: string;
  markdown: string;
  /** Headings only: 1 to 6. */
  level?: number;
  /** Code only: from `class="language-x"` or `lang-x`. */
  language?: string;
  /** True for code blocks, so text rules (word count, reading level, spelling) can skip them. */
  code: boolean;
  region: ContentLabel | null;
  section: ContentLabel | null;
}

/**
 * A label from a placer. `hops` is the element steps from the asked element up to the node that
 * answered (0 = the element itself); a placer that does not report it is treated as inherited.
 */
export type PlacedContentLabel = PlacedLabel & { nodeId?: number | null; hops?: number };

/** One answer of a placer, structurally what `elementPlacer` returns. */
export interface ContentPlacement {
  region: PlacedContentLabel | null;
  section: PlacedContentLabel | null;
  /** Fail closed: the element sits in a structure of unknown extent, so it is dropped. */
  truncated?: boolean;
}

/** Place one element, or null when the classifier has nothing to say. */
export type ContentPlacer = (element: Element) => ContentPlacement | null;

export interface MainTextOptions {
  place?: ContentPlacer;
}

export interface MainTextExtraction {
  /** Kept blocks' text joined with a blank line. Includes code blocks. */
  text: string;
  /** Kept blocks' markdown joined with a blank line. */
  markdown: string;
  /** `text` without the code blocks: what prose rules should read. */
  proseText: string;
  blocks: ContentBlock[];
  /** "classifier" when a placer was given and answered for at least one element, else "markup". */
  placer: "classifier" | "markup";
}

// ---------------------------------------------------------------------------
// Markup rules
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Never text a reader reads. `button`, `input`, `select`, `textarea`, `option` are UI controls whose
// text ("Subscribe", "Accept all") is furniture, not copy.
const SKIP_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "video",
  "audio",
  "head",
  "img",
  "picture",
  "hr",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "optgroup",
  "object",
  "embed",
  "map",
]);

const SR_ONLY = new Set(["visually-hidden", "sr-only", "screen-reader-text"]);

// Elements whose text flows into the surrounding paragraph. Anything else (div, section, custom
// elements, table parts outside a data table) is a container and breaks the paragraph.
const INLINE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

const HEADING = /^h([1-6])$/;
// Blocks serialised whole (their subtree is flattened) rather than walked.
const LEAF_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "pre",
  "ul",
  "ol",
  "table",
  "blockquote",
  "dt",
  "dd",
  "figcaption",
  "summary",
  "li",
]);

const ALWAYS_DROP_LANDMARK_TAGS: ReadonlySet<string> = new Set([
  "nav",
  "aside",
  "dialog",
  "search",
]);
const ALWAYS_DROP_ROLES: ReadonlySet<string> = new Set([
  "navigation",
  "complementary",
  "dialog",
  "alertdialog",
  "search",
]);
const SCOPED_ROLES: ReadonlySet<string> = new Set(["banner", "contentinfo"]);

// Whole-token class/id patterns. Whole tokens, never substrings: `header`, `shadow`, `download`,
// `breadcrumb` and `heading` must not read as an ad or a chat widget. A class attribute is split on
// whitespace and each token is tested whole; an id is one token.
const FURNITURE_TOKEN = new RegExp(
  "^(?:" +
    [
      // cookie consent
      "cookie[-_]?(?:banner|consent|notice|bar|popup|modal|wall|dialog|prompt|alert|warning|message)",
      "cookies[-_]?(?:banner|consent|notice|bar|popup|modal)",
      "cookieconsent\\S*",
      "cookiebot\\S*",
      "cybotcookiebot\\S*",
      "onetrust(?:[-_]\\S*)?",
      "ot-sdk-container",
      "gdpr[-_]?(?:banner|consent|notice|cookie|popup|modal)",
      "cc[-_]?(?:window|banner|revoke)",
      "consent[-_]?(?:banner|manager|popup|modal|bar)",
      "cmp[-_]?(?:banner|container)",
      "didomi-(?:popup|notice|host)\\S*",
      "qc-cmp\\S*",
      "osano-cm\\S*",
      // ads
      "ads?",
      "adv",
      "adsbygoogle",
      "advert(?:isement|ising)?s?",
      "ads?[-_](?:slot|container|banner|wrapper|wrap|unit|box|block|placeholder|holder|zone|space|label|leaderboard|inline|top|bottom|sidebar|mpu|rail|break)s?",
      "adslot",
      "adunit",
      "adbox",
      "adbanner",
      "adwrapper",
      "adcontainer",
      "advert[-_](?:slot|container|banner|wrapper|unit|box|block)",
      "dfp[-_]?ad\\S*",
      "div-gpt-ad\\S*",
      "gpt[-_]ad\\S*",
      "google[-_]?ad\\S*",
      "sponsored[-_](?:ad|content|link|post|banner)s?",
      "taboola\\S*",
      "outbrain\\S*",
      "banner[-_]ad",
      // chat widgets
      "intercom[-_]?\\S*",
      "drift-(?:widget|frame|conductor|iframe|chat)\\S*",
      "driftt\\S*",
      "crisp-client",
      "crisp-(?:chatbox|widget)\\S*",
      "tawk\\S*",
      "zewidget\\S*",
      "ze-snippet",
      "zendesk-(?:widget|chat|messenger)\\S*",
      "livechat\\S*",
      "lc-widget",
      "hubspot-messages\\S*",
      "hs-messages\\S*",
      "hubspot-conversations\\S*",
      "chat[-_]?(?:widget|bubble|launcher|window|popup|container)",
      "chatbot[-_]?(?:widget|container|launcher)",
      "freshchat\\S*",
      "fc-widget\\S*",
      "olark\\S*",
      "tidio\\S*",
      "fb-customerchat",
      // newsletter signup
      "newsletter",
      "newsletter[-_](?:signup|sign-up|form|box|widget|banner|cta|subscribe|subscription|popup|modal|optin|section|block|wrapper|container)",
      "subscribe[-_](?:box|form|banner|widget|cta|section|popup|modal|bar)",
      "email[-_](?:signup|capture|optin|subscribe)\\S*",
      "signup[-_](?:box|form|banner|widget|cta)",
      "mc4wp\\S*",
      "mailchimp\\S*",
      // social share
      "share[-_]?(?:bar|buttons?|links?|widget|icons?|container|tools|this)",
      "share",
      "sharing",
      "social[-_]?(?:share|sharing|buttons?|links|icons|bar|follow|widget)",
      "sharedaddy",
      "addtoany\\S*",
      "a2a_\\S*",
      "addthis\\S*",
      "at-share\\S*",
      "shareaholic\\S*",
      "sharethis\\S*",
      // promo banners
      "promo[-_]?(?:banner|bar|popup|modal)",
      "announcement[-_]bar",
      // site chrome in a page with no landmarks. Not the bare words `header` or `footer` (an
      // article card can have a `.header`), and not `page-header` (Bootstrap puts the h1 in it).
      "site[-_](?:header|footer|nav|menu|masthead)",
      "global[-_](?:header|footer|nav)",
      "page[-_]footer",
      "main[-_]footer",
      "masthead",
      "colophon",
      "navbar\\S*",
      "(?:main|primary|top|mobile)[-_](?:nav|navigation|menu)",
      "nav[-_]menu",
      "sidebar",
      "side[-_]bar",
      "widget[-_]area",
    ].join("|") +
    ")$",
);

const furnitureTokenCache = new Map<string, boolean>();
function isFurnitureToken(token: string): boolean {
  let hit = furnitureTokenCache.get(token);
  if (hit === undefined) {
    hit = FURNITURE_TOKEN.test(token);
    // Bound the cache: tokens come from the page.
    if (furnitureTokenCache.size < 5000) furnitureTokenCache.set(token, hit);
  }
  return hit;
}

// A hostile `class` can be megabytes; the tokens that matter are near the front.
const MAX_ATTR_SCAN = 4096;

/** Does this element's class or id name sitewide furniture or an ad/consent/chat/signup/share box? */
export function hasFurnitureToken(el: Element): boolean {
  const cls = el.getAttribute?.("class");
  if (cls) {
    const scan = (cls.length > MAX_ATTR_SCAN ? cls.slice(0, MAX_ATTR_SCAN) : cls).toLowerCase();
    for (const token of scan.split(/\s+/)) {
      if (token && isFurnitureToken(token)) return true;
    }
  }
  const id = el.getAttribute?.("id");
  if (id && id.length <= 200 && isFurnitureToken(id.toLowerCase())) return true;
  return false;
}

// A comment THREAD container, as in link-section.ts. Kept and labelled, never dropped.
const COMMENTS_TOKEN =
  /^(?:comments|comment-?list|comment-?thread|comment-?section|comments-?area|disqus_thread|fb-comments|commento)$/;

function isCommentsContainer(el: Element): boolean {
  const id = el.getAttribute?.("id");
  if (id && id.length <= 200 && COMMENTS_TOKEN.test(id.toLowerCase())) return true;
  const cls = el.getAttribute?.("class");
  if (cls) {
    const scan = (cls.length > MAX_ATTR_SCAN ? cls.slice(0, MAX_ATTR_SCAN) : cls).toLowerCase();
    for (const token of scan.split(/\s+/)) if (token && COMMENTS_TOKEN.test(token)) return true;
  }
  return false;
}

function isHidden(el: Element): boolean {
  const hidden = el.getAttribute?.("hidden");
  if (hidden !== null && hidden !== undefined && hidden.trim().toLowerCase() !== "until-found") {
    return true;
  }
  if (el.getAttribute?.("aria-hidden") === "true") return true;
  const style = el.getAttribute?.("style");
  if (style && /(?:^|;)\s*display\s*:\s*none\b/i.test(style)) return true;
  const cls = el.getAttribute?.("class");
  if (cls) {
    const scan = cls.length > MAX_ATTR_SCAN ? cls.slice(0, MAX_ATTR_SCAN) : cls;
    for (const token of scan.split(/\s+/)) if (SR_ONLY.has(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Context carried down the walk
// ---------------------------------------------------------------------------

interface Ctx {
  /** Inside main/article/role=main: a header or footer here is the block's own, not the site's. */
  inContent: boolean;
  region: ContentLabel | null;
  section: ContentLabel | null;
}

const ROOT_CTX: Ctx = { inContent: false, region: null, section: null };
const MARKUP_MAIN: ContentLabel = {
  label: "main_content",
  source: "rules",
  confidence: 1,
  nodeId: null,
};
const MARKUP_COMMENTS: ContentLabel = {
  label: "comments",
  source: "rules",
  confidence: 1,
  nodeId: null,
};

function deriveCtx(ctx: Ctx, tag: string, el: Element): Ctx {
  let next = ctx;
  if (
    !ctx.inContent &&
    (tag === "main" || tag === "article" || el.getAttribute("role") === "main")
  ) {
    next = { inContent: true, region: MARKUP_MAIN, section: ctx.section };
  }
  if (next.section === null && isCommentsContainer(el)) {
    next = { inContent: true, region: next.region, section: MARKUP_COMMENTS };
  }
  return next;
}

/** Landmarks by the same semantics as `makeSectionResolver` (link-section.ts). */
function isDroppedLandmark(el: Element, tag: string, ctx: Ctx): boolean {
  if (ALWAYS_DROP_LANDMARK_TAGS.has(tag)) return true;
  const role = el.getAttribute("role")?.toLowerCase();
  if (role && ALWAYS_DROP_ROLES.has(role)) return true;
  // header/footer (and their roles) only scope to the site outside main/article.
  if (tag === "header" || tag === "footer") return !ctx.inContent;
  if (role && SCOPED_ROLES.has(role)) return !ctx.inContent;
  return false;
}

function toLabel(placed: PlacedContentLabel | null): ContentLabel | null {
  if (!placed || placed.label === "unknown") return null;
  return {
    label: placed.label,
    source: placed.source,
    confidence: placed.confidence,
    nodeId: placed.nodeId ?? null,
  };
}

// The placer walks ancestors on every call, so past this depth asking per element is quadratic on a
// hostile page. Deeper elements use the markup rules (which carry their context down the walk).
const PLACER_MAX_DEPTH = 512;

// ---------------------------------------------------------------------------
// Serialisers for leaf blocks
// ---------------------------------------------------------------------------

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const CLOSE = Symbol("close");
const CODE_CLOSE = Symbol("code-close");
const SPACE_CLOSE = Symbol("space-close");
type StackItem = Node | typeof CLOSE | typeof CODE_CLOSE | typeof SPACE_CLOSE;

/** Is the element dropped inside a leaf block (no placer here: the block was already placed)? */
function isDroppedInline(el: Element, tag: string): boolean {
  if (SKIP_TAGS.has(tag) || isHidden(el)) return true;
  if (ALWAYS_DROP_LANDMARK_TAGS.has(tag)) return true;
  return hasFurnitureToken(el);
}

/**
 * Flatten `root`'s content to one line of text and markdown. Links become their text (no URLs: this
 * is a text-focused extraction), images are skipped, inline `<code>` becomes backticks in the
 * markdown, and block-level children read as word breaks.
 */
function inlineOf(root: Element, skipLists: boolean): { text: string; md: string } {
  const text: string[] = [];
  const md: string[] = [];
  const stack: StackItem[] = [];
  const initial = root.childNodes;
  for (let i = initial.length - 1; i >= 0; i--) stack.push(initial[i] as Node);
  while (stack.length > 0) {
    const entry = stack.pop() as StackItem;
    if (entry === CODE_CLOSE) {
      md.push("`");
      continue;
    }
    if (entry === SPACE_CLOSE) {
      text.push(" ");
      md.push(" ");
      continue;
    }
    if (typeof entry === "symbol") continue;
    const node = entry;
    if (node.nodeType === TEXT_NODE) {
      const data = (node as { data?: string }).data ?? "";
      text.push(data);
      md.push(data);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? "";
    if (tag === "br" || tag === "wbr") {
      text.push(" ");
      md.push(" ");
      continue;
    }
    if (isDroppedInline(el, tag) || (skipLists && (tag === "ul" || tag === "ol"))) {
      text.push(" ");
      md.push(" ");
      continue;
    }
    if (tag === "code") {
      md.push("`");
      stack.push(CODE_CLOSE);
    } else if (!INLINE_TAGS.has(tag)) {
      text.push(" ");
      md.push(" ");
      stack.push(SPACE_CLOSE);
    }
    const children = el.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Node);
  }
  return { text: collapse(text.join("")), md: collapse(md.join("")) };
}

const MAX_LIST_DEPTH = 6;

function listBlock(root: Element): { text: string; md: string } | null {
  const textLines: string[] = [];
  const mdLines: string[] = [];
  const itemsOf = (list: Element): Element[] =>
    [...(list.children as unknown as Element[])].filter((c) => c.tagName?.toLowerCase() === "li");
  interface Frame {
    items: Element[];
    i: number;
    ordered: boolean;
    depth: number;
  }
  const frames: Frame[] = [
    { items: itemsOf(root), i: 0, ordered: root.tagName?.toLowerCase() === "ol", depth: 0 },
  ];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.i >= frame.items.length) {
      frames.pop();
      continue;
    }
    const index = frame.i++;
    const li = frame.items[index]!;
    if (isHidden(li)) continue;
    const flatten = frame.depth >= MAX_LIST_DEPTH;
    const line = inlineOf(li, !flatten);
    if (line.text) {
      textLines.push(line.text);
      const bullet = frame.ordered ? `${index + 1}. ` : "- ";
      mdLines.push(`${"  ".repeat(frame.depth)}${bullet}${line.md}`);
    }
    if (flatten) continue;
    // Nested lists run right after their item; pushed in reverse so the first one is on top.
    const nested = [...(li.children as unknown as Element[])].filter((c) => {
      const t = c.tagName?.toLowerCase();
      return (t === "ul" || t === "ol") && !isHidden(c) && !hasFurnitureToken(c);
    });
    for (let n = nested.length - 1; n >= 0; n--) {
      const list = nested[n]!;
      frames.push({
        items: itemsOf(list),
        i: 0,
        ordered: list.tagName?.toLowerCase() === "ol",
        depth: frame.depth + 1,
      });
    }
  }
  if (textLines.length === 0) return null;
  return { text: textLines.join("\n"), md: mdLines.join("\n") };
}

/** A table that lays out a page rather than holding data: walk through it as containers. */
function isLayoutTable(el: Element): boolean {
  const role = el.getAttribute("role")?.toLowerCase();
  if (role === "presentation" || role === "none") return true;
  return el.querySelector("table table, h1, h2, h3, h4, h5, h6, p, ul, ol") !== null;
}

function tableBlock(root: Element): { text: string; md: string } | null {
  const rows: Element[] = [];
  const stack: Node[] = [];
  const initial = root.childNodes;
  for (let i = initial.length - 1; i >= 0; i--) stack.push(initial[i] as Node);
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType !== ELEMENT_NODE) continue;
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    if (tag === "tr") {
      if (!isHidden(el)) rows.push(el);
    } else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      if (isHidden(el)) continue;
      const children = el.childNodes;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Node);
    }
  }
  const grid: string[][] = [];
  for (const tr of rows) {
    const cells: string[] = [];
    for (const cell of [...(tr.children as unknown as Element[])]) {
      const tag = cell.tagName?.toLowerCase();
      if ((tag !== "td" && tag !== "th") || isHidden(cell)) continue;
      cells.push(inlineOf(cell, false).text);
    }
    if (cells.some((c) => c.length > 0)) grid.push(cells);
  }
  if (grid.length === 0) return null;
  // A loop, not Math.max(...): a spread of a huge table's rows overflows the call stack.
  let width = 0;
  for (const r of grid) if (r.length > width) width = r.length;
  const pad = (r: string[]): string[] => [...r, ...Array<string>(width - r.length).fill("")];
  // Escape backslashes as well as pipes, so a cell ending in a backslash cannot escape the column separator.
  const cell = (c: string): string => c.replace(/[\\|]/g, "\\$&");
  const line = (r: string[]): string => `| ${pad(r).map(cell).join(" | ")} |`;
  const md = [
    line(grid[0]!),
    `| ${Array<string>(width).fill("---").join(" | ")} |`,
    ...grid.slice(1).map(line),
  ].join("\n");
  return { text: grid.map((r) => r.filter(Boolean).join(" | ")).join("\n"), md };
}

const LANGUAGE_CLASS = /^(?:language|lang)-([a-z0-9_+#.-]+)$/i;

function languageOf(pre: Element): string | undefined {
  const candidates: Element[] = [pre];
  const first = pre.firstElementChild;
  if (first && first.tagName?.toLowerCase() === "code") candidates.push(first as Element);
  for (const el of candidates) {
    const cls = el.getAttribute("class");
    if (!cls) continue;
    for (const token of cls.slice(0, MAX_ATTR_SCAN).split(/\s+/)) {
      const m = LANGUAGE_CLASS.exec(token);
      if (m) return m[1]!.toLowerCase();
    }
  }
  return undefined;
}

function codeText(root: Element): string {
  const out: string[] = [];
  const stack: Node[] = [];
  const initial = root.childNodes;
  for (let i = initial.length - 1; i >= 0; i--) stack.push(initial[i] as Node);
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === TEXT_NODE) {
      out.push((node as { data?: string }).data ?? "");
    } else if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;
      const tag = el.tagName?.toLowerCase() ?? "";
      if (tag === "br") {
        out.push("\n");
        continue;
      }
      if (tag === "script" || tag === "style" || tag === "template" || tag === "svg") continue;
      const children = el.childNodes;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Node);
    }
  }
  // A leading newline after <pre> is not part of the code (HTML drops it), a trailing one is noise.
  return out
    .join("")
    .replace(/^\r?\n/, "")
    .trimEnd();
}

function fenceFor(code: string): string {
  let longest = 0;
  for (const m of code.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

interface Frame {
  node: StackItem;
  ctx: Ctx;
  depth: number;
  /** Nearest container element, whose placement labels loose text. */
  owner: Element | null;
}

/**
 * Turn a parsed document into main text, markdown and labelled blocks.
 *
 * With `options.place` the classifier decides (see the module comment); without it, or wherever it
 * abstains, the markup rules do. A placer that throws is an abstention. A `truncated` answer drops
 * the element (fail closed).
 */
export function extractMainText(doc: Document, options: MainTextOptions = {}): MainTextExtraction {
  const place = options.place;
  const blocks: ContentBlock[] = [];
  const cache = new WeakMap<Element, ContentPlacement | null>();
  let placerAnswered = false;
  // Classifier nodes whose chrome label the markup overruled (see `decide`). A descendant's placement
  // inherits its nearest labelled ancestor's answer, so the same node id comes back for the subtree.
  const overruled = new Set<number>();

  const ask = (el: Element): ContentPlacement | null => {
    if (!place) return null;
    if (cache.has(el)) return cache.get(el) ?? null;
    let answer: ContentPlacement | null = null;
    try {
      answer = place(el) ?? null;
    } catch {
      answer = null;
    }
    cache.set(el, answer);
    return answer;
  };

  /** The placer's answer for `el` when it is a real one (labels, or truncated), else null. */
  const answerFor = (el: Element, depth: number): ContentPlacement | null => {
    if (!place || depth > PLACER_MAX_DEPTH) return null;
    const p = ask(el);
    if (!p) return null;
    if (p.truncated) return p;
    if (
      (p.region && p.region.label !== "unknown") ||
      (p.section && p.section.label !== "unknown")
    ) {
      return p;
    }
    return null;
  };

  const labelsOf = (
    answer: ContentPlacement | null,
    ctx: Ctx,
  ): { region: ContentLabel | null; section: ContentLabel | null } => {
    if (!answer) return { region: ctx.region, section: ctx.section };
    const id = answer.region?.nodeId;
    const region = id != null && overruled.has(id) ? ctx.region : toLabel(answer.region);
    return { region, section: toLabel(answer.section) };
  };

  /**
   * Keep or drop one element (container, block or inline). Returns the placer's answer when it kept
   * the element on its own say-so, `"markup"` when the markup kept it, or null to drop.
   */
  const decide = (
    el: Element,
    tag: string,
    ctx: Ctx,
    depth: number,
    inline: boolean,
  ): ContentPlacement | "markup" | null => {
    if (!inline) {
      const answer = answerFor(el, depth);
      if (answer) {
        placerAnswered = true;
        if (answer.truncated) return null;
        const region = answer.region?.label;
        const section = answer.section?.label;
        // article_chrome is the title/byline/share rows around an article body. Its text is dropped, but
        // the headings in it are kept: the classifier files `<header class="entry-header">` there and
        // the page's h1 lives in that header. Containers pass through so the headings are reached.
        if (region === "article_chrome") {
          if (LEAF_BLOCK_TAGS.has(tag) && !HEADING.test(tag)) return null;
        }
        const regionDrop =
          region !== undefined &&
          region !== "article_chrome" &&
          MAIN_TEXT_DROPPED_REGIONS.has(region);
        // An ASP.NET-style page-wide <form> is labelled `form` but holds the content: it is a wrapper,
        // not a form, when it contains the page's main landmark. Its children are judged on their own.
        const wrapper =
          regionDrop &&
          region === "form" &&
          tag === "form" &&
          el.querySelector("main, [role='main'], article") !== null;
        // Markup wins over a MODEL chrome label on an element the markup itself declares to be the
        // content (the classifier README's precedence). Seen on a page whose whole article was one
        // short line: the model called its <article> a site header and the page read as empty.
        const answerNode = answer.region?.nodeId;
        const overrule =
          regionDrop &&
          !wrapper &&
          answer.region?.source === "model" &&
          answerNode != null &&
          (overruled.has(answerNode) ||
            tag === "main" ||
            tag === "article" ||
            el.getAttribute("role") === "main");
        if (overrule) overruled.add(answerNode!);
        if (regionDrop && !wrapper && !overrule) return null;
        if (section !== undefined && MAIN_TEXT_DROPPED_SECTIONS.has(section)) return null;
        if (!wrapper && !overrule) {
          // Markup wins for landmarks. The classifier labels at most 400 candidate nodes, so a `nav`
          // or `aside` that was not one inherits its ancestor's `main_content` (hops > 0) and would
          // be kept. Only a region answer for this very element (hops 0) exempts it, which is how a
          // header the classifier itself calls content or article chrome stays.
          if (answer.region?.hops !== 0 && isDroppedLandmark(el, tag, ctx)) return null;
          // The classifier names no chat widget class, so the furniture tokens still apply to what it
          // kept (an unlabelled chat div inherits its content ancestor's region).
          if (hasFurnitureToken(el)) return null;
          return answer;
        }
        // Overruled or a form wrapper: no placer answer to carry, the markup rules decide.
      }
      if (isDroppedLandmark(el, tag, ctx)) return null;
    }
    if (hasFurnitureToken(el)) return null;
    return "markup";
  };

  // An element the placer itself (hops 0) labelled content is content context for what is below it,
  // as `<main>` and `<article>` are in the markup: the article's own header and footer are kept
  // rather than read as the site's banner.
  const withPlacedContext = (ctx: Ctx, verdict: ContentPlacement | "markup"): Ctx => {
    if (ctx.inContent || verdict === "markup") return ctx;
    const r = verdict.region;
    if (r && r.hops === 0 && MAIN_TEXT_KEPT_REGIONS.has(r.label))
      return { ...ctx, inContent: true };
    return ctx;
  };

  const body = doc.body ?? doc.documentElement;
  if (!body) {
    return { text: "", markdown: "", proseText: "", blocks, placer: "markup" };
  }

  // Loose text and inline runs between blocks accumulate here and flush as a paragraph.
  let pendingText: string[] = [];
  let pendingMd: string[] = [];
  let pendingCtx: Ctx = ROOT_CTX;
  let pendingOwner: Element | null = null;
  let pendingDepth = 0;
  let pendingStarted = false;

  const flush = (): void => {
    if (pendingStarted) {
      const text = collapse(pendingText.join(""));
      if (text) {
        const answer = pendingOwner ? answerFor(pendingOwner, pendingDepth) : null;
        const labels = labelsOf(answer && !answer.truncated ? answer : null, pendingCtx);
        // Loose text in article chrome (a byline, a share row) is dropped like its paragraphs.
        if (answer?.truncated || answer?.region?.label === "article_chrome") {
          pendingText = [];
          pendingMd = [];
          pendingStarted = false;
          return;
        }
        blocks.push({
          kind: "paragraph",
          text,
          markdown: collapse(pendingMd.join("")),
          code: false,
          ...labels,
        });
      }
    }
    pendingText = [];
    pendingMd = [];
    pendingStarted = false;
  };

  const emit = (
    kind: ContentBlockKind,
    serialised: { text: string; md: string },
    answer: ContentPlacement | "markup",
    ctx: Ctx,
    extra: { level?: number; language?: string } = {},
  ): void => {
    const labels = labelsOf(answer === "markup" ? null : answer, ctx);
    blocks.push({
      kind,
      text: serialised.text,
      markdown: serialised.md,
      ...(extra.level !== undefined ? { level: extra.level } : {}),
      ...(extra.language !== undefined ? { language: extra.language } : {}),
      code: kind === "code",
      ...labels,
    });
  };

  const stack: Frame[] = [];
  const top = body.childNodes;
  for (let i = top.length - 1; i >= 0; i--) {
    stack.push({ node: top[i] as Node, ctx: ROOT_CTX, depth: 0, owner: body as Element });
  }

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const entry = frame.node;
    if (entry === CLOSE) {
      flush();
      continue;
    }
    if (entry === CODE_CLOSE) {
      if (pendingStarted) pendingMd.push("`");
      continue;
    }
    if (typeof entry === "symbol") continue;
    const node = entry;

    if (node.nodeType === TEXT_NODE) {
      const data = (node as { data?: string }).data ?? "";
      if (!pendingStarted) {
        if (data.trim() === "") continue;
        pendingStarted = true;
        pendingCtx = frame.ctx;
        pendingOwner = frame.owner;
        pendingDepth = frame.depth;
      }
      pendingText.push(data);
      pendingMd.push(data);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? "";
    if (SKIP_TAGS.has(tag) || isHidden(el)) continue;

    if (tag === "br" || tag === "wbr") {
      if (pendingStarted) {
        pendingText.push(" ");
        pendingMd.push(" ");
      }
      continue;
    }

    if (INLINE_TAGS.has(tag)) {
      // Inline elements are transparent; only the furniture tokens can drop one (an `ins.adsbygoogle`
      // or a share-bar span between sentences).
      if (decide(el, tag, frame.ctx, frame.depth, true) === null) continue;
      if (tag === "code" && pendingStarted) {
        pendingMd.push("`");
        stack.push({ node: CODE_CLOSE, ctx: frame.ctx, depth: frame.depth, owner: frame.owner });
      }
      const children = el.childNodes;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({
          node: children[i] as Node,
          ctx: frame.ctx,
          depth: frame.depth,
          owner: frame.owner,
        });
      }
      continue;
    }

    const layoutTable = tag === "table" && isLayoutTable(el);
    if (LEAF_BLOCK_TAGS.has(tag) && !layoutTable) {
      flush();
      const ctx = deriveCtx(frame.ctx, tag, el);
      const verdict = decide(el, tag, ctx, frame.depth, false);
      if (verdict === null) continue;
      const heading = HEADING.exec(tag);
      if (heading) {
        const level = Number(heading[1]);
        const s = inlineOf(el, false);
        if (s.text)
          emit("heading", { text: s.text, md: `${"#".repeat(level)} ${s.md}` }, verdict, ctx, {
            level,
          });
      } else if (tag === "pre") {
        const code = codeText(el);
        if (code.trim()) {
          const fence = fenceFor(code);
          const language = languageOf(el);
          emit(
            "code",
            { text: code, md: `${fence}${language ?? ""}\n${code}\n${fence}` },
            verdict,
            ctx,
            language ? { language } : {},
          );
        }
      } else if (tag === "ul" || tag === "ol") {
        const s = listBlock(el);
        if (s) emit("list", s, verdict, ctx);
      } else if (tag === "table") {
        const s = tableBlock(el);
        if (s) emit("table", s, verdict, ctx);
      } else if (tag === "blockquote") {
        const s = inlineOf(el, false);
        if (s.text) emit("quote", { text: s.text, md: `> ${s.md}` }, verdict, ctx);
      } else {
        const s = inlineOf(el, false);
        if (s.text) emit("paragraph", s, verdict, ctx);
      }
      continue;
    }

    // A container (div, section, main, a data-less table part, a custom element, ...).
    flush();
    const markupCtx = deriveCtx(frame.ctx, tag, el);
    const verdict = decide(el, tag, markupCtx, frame.depth, false);
    if (verdict === null) continue;
    const ctx = withPlacedContext(markupCtx, verdict);
    stack.push({ node: CLOSE, ctx, depth: frame.depth, owner: frame.owner });
    const children = el.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i] as Node, ctx, depth: frame.depth + 1, owner: el });
    }
  }
  flush();

  return {
    text: blocks.map((b) => b.text).join("\n\n"),
    markdown: blocks.map((b) => b.markdown).join("\n\n"),
    proseText: blocks
      .filter((b) => !b.code)
      .map((b) => b.text)
      .join("\n\n"),
    blocks,
    placer: placerAnswered ? "classifier" : "markup",
  };
}
