// links/anchor-mismatch - anchor text that has nothing to do with the page it points at (#110)
//
// `links/anchor-text` looks at one page's OUTGOING links and asks whether the text is empty or
// generic. This rule asks the question that matters for topicality: does the anchor text pointing
// AT a page share anything with that page's title, H1 or slug?
//
// The unit is the (source page, target page) pair, never the link: twelve links with the same
// text on one page are one observation, and a page that links the same target in a card, a
// heading and a button contributes the combined text of all three.
//
// FALSE-POSITIVE TRAPS, and how each is handled:
//
//   * CHROME. Nav, header, footer and aside links are template text (`LinkData.isChrome`) and
//     never enter the comparison. `undefined` (a crawl stored before #109) counts as contextual.
//   * GLUED CHILD NODES. The parser joins a link's child nodes with a space, so a card wrapping a
//     heading and a description reads "Carpentry Structural & finish carpentry See details", not
//     one unmatchable word.
//   * PLURALS. Tokens match by equality or by a shared prefix of at least 3 characters with at
//     most 3 characters left over, so "Fridges" matches "/repairs/fridge".
//   * SHORT BRANDS. Two-character tokens are real tokens ("LG" matches "/brands/lg"); they match
//     by equality only. A single character is never a token.
//   * UTILITY PAGES. Privacy, terms, contact, legal and similar targets are linked with
//     boilerplate text by design, and the front door is linked as "Home" or by its logo: none is
//     ever a target here.
//   * NOTHING TO COMPARE. A target with no title, no H1 and no slug words, or a pair whose anchor
//     text is empty or only stop words, cannot be judged. Those are counted in `details.notJudged`
//     rather than dropped silently. So is any pair whose text has no whitespace-delimited Latin,
//     Cyrillic or Greek word (CJK, Thai, Indic): shared words cannot be told apart there. When
//     nothing at all was judged the check is skipped, never a vacuous pass.
//   * HYPHENATED COMPOUNDS. "Online-Shop" and "Onlineshop" are one word: a hyphenated run also
//     yields its joined form as a token, on both the anchor and the target side (#1598).
//   * COMPOUND CONSTITUENTS. An anchor word of 5+ characters that ends a target word with 3+
//     characters in front of it matches ("Handschuhe" in "Fahrradhandschuhe"): German and Dutch build nouns by
//     prefixing, so the anchor is often the head noun of the title's compound (#1626).
//   * LISTING LABELS. "Alle Artikel" or "View all posts" pointing at a blog, news or article
//     listing names the listing by context, not by the title's words: such a pair is not judged
//     (#1626).
//   * DIACRITICS. Words are folded (NFD, marks stripped), so `Café` meets `Cafe menu`.
//
// Both paths feed `evaluateAnchorGraph` the same `AnchorGraph` (built by the same
// `AnchorGraphBuilder`), so the output is byte-identical.

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import {
  type AnchorGraph,
  type AnchorGraphPage,
  type AnchorGraphPair,
  type LinkData,
} from "@squirrelscan/core-contracts";

import { MAX_ANCHOR_PART_LENGTH, MAX_ANCHOR_PARTS } from "@squirrelscan/parser";
import { getPathname } from "@squirrelscan/utils";
import { normalizePageUrl } from "@squirrelscan/utils/url";
import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";

import { frontDoorTest } from "../shared/front-door";
import { isLegalPage } from "./no-contextual-inbound";

const CHECK_NAME = "anchor-mismatch";

const SKIP_CHECK: CheckResult = {
  name: CHECK_NAME,
  status: "skipped",
  message: "Insufficient pages for anchor text analysis",
};

// Hard bounds so a large crawl cannot grow the pair map without limit. The overflow is counted.
const MAX_PAIRS = 50_000;
const MAX_TOKENS_PER_PAIR = 64;
// Across every pair: bounds the token strings the builder holds (about 50 bytes each).
const MAX_TOTAL_TOKENS = 500_000;
// Characters retained in those tokens, so long words cannot outgrow the count budget.
const MAX_TOTAL_TOKEN_CHARS = 4_000_000;
const MAX_TOKENS_PER_PAGE = 64;
const MAX_TEXTS_PER_PAIR = 8;
const MAX_H1 = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_DROPPED_KEYS = 100_000;
const MAX_TEXT_LENGTH = 120;
// Items listed on the finding; `details.total` carries the real count.
const MAX_ITEMS = 100;

// Utility targets linked with boilerplate text by design, beyond the legal pages.
const UTILITY_PATH_PATTERNS: readonly RegExp[] = [
  ...EEAT_PAGE_PATTERNS.contact,
  /\/cookies?(?:-policy|-settings|-notice)?(?:\/|\.html?)?$/i,
  /\/accessibility(?:-statement)?(?:\/|\.html?)?$/i,
  /\/sitemap(?:\/|\.html?)?$/i,
  /\/(?:login|log-in|signin|sign-in|signup|sign-up|register|logout|account|cart|checkout|search)(?:\/|\.html?)?$/i,
];

function isUtilityPage(url: string): boolean {
  const path = getPathname(url);
  return isLegalPage(url) || UTILITY_PATH_PATTERNS.some((re) => re.test(path));
}

// Words that carry no topic. Kept short on purpose: "click", "here", "more" and "read" are NOT
// here, because an anchor made only of them is exactly the mismatch to report.
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "is",
  "it",
  "as",
  "be",
  "your",
  "you",
  "our",
  "we",
  "my",
  "me",
  "how",
  "what",
  "this",
  "that",
]);

// Words in a script that is written with spaces between words. CJK, Thai and the Indic scripts
// are not: splitting them on whitespace gives whole phrases or fragments, so a pair with such text
// cannot be judged by shared words and is counted as not judged instead.
const SPACED_WORD = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]+$/u;

// Letters that do not decompose under NFD, folded to their usual ASCII spelling.
const LATIN_FOLDS: Readonly<Record<string, string>> = {
  ø: "o",
  ł: "l",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

function foldLatin(text: string): string {
  return text.replace(/[øłßæœđðþı]/g, (c) => LATIN_FOLDS[c] ?? c);
}

// Any letter outside Latin, Cyrillic and Greek: text in a script whose words this rule cannot
// split on whitespace (Chinese, Japanese, Thai) or compare by prefix. A side that has one is not
// judged at all, so a mixed pair never warns on the Latin words alone.
const FOREIGN_LETTER = /(?![\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}])\p{L}/u;

export function hasForeignScript(text: string): boolean {
  return FOREIGN_LETTER.test(text);
}

// A paginated target (/page/2, ?page=3) is linked as "Next" or "2" by design.
const PAGINATION_PATH = /\/page\/\d+\/?$/i;
// `p` is deliberately absent: `?p=123` is WordPress's default permalink, a real page.
const PAGINATION_QUERY = /^(?:page|paged|pagenum)$/i;

function isPaginationTarget(target: string): boolean {
  try {
    const u = new URL(target);
    if (PAGINATION_PATH.test(u.pathname)) return true;
    for (const [k, v] of u.searchParams)
      if (PAGINATION_QUERY.test(k) && /^\d+$/.test(v)) return true;
  } catch {
    // An unparseable target never reaches here (the builder resolved it), so nothing to skip.
  }
  return false;
}

/**
 * Folded word tokens of at least two characters, stop words removed. Diacritics are folded
 * (NFD, marks stripped) so `Café` meets `Cafe`. Only whitespace-delimited Latin, Cyrillic and
 * Greek words are tokens; text in other scripts yields none.
 */
export function meaningfulTokens(text: string): string[] {
  return tokenize(text).tokens;
}

// A word longer than this is not a word: it is dropped, and the loss is reported so the
// comparison is never trusted as complete.
const MAX_TOKEN_LENGTH = 64;

/**
 * Tokens as {@link meaningfulTokens}; the closed forms of hyphenated compounds, kept apart
 * because they match by equality only; and whether an over-long word was dropped.
 */
export function tokenize(
  text: string,
  options: { slug?: boolean } = {},
): { tokens: string[]; joined: string[]; lost: boolean } {
  const tokens: string[] = [];
  let lost = false;
  const folded = foldLatin(
    text
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase(),
  );
  for (const raw of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_WORDS.has(raw) || !SPACED_WORD.test(raw)) continue;
    if (raw.length > MAX_TOKEN_LENGTH) {
      lost = true;
      continue;
    }
    tokens.push(raw);
  }
  const joined = [...new Set(hyphenJoins(folded, options.slug === true))];
  return { tokens, joined, lost };
}

// A hyphenated compound ("Online-Shop") and its closed form ("Onlineshop") are one word in
// German and often elsewhere. The parts stay tokens; the joined form is kept in a separate list so
// either spelling meets the other, and it is compared by equality only (a joined form is a
// spelling of one word, not a stem that tolerates a suffix). The whole run is the only joined form
// of an anchor, title or heading: a hyphenated compound is one word, so a partial join would
// invent one. In a URL slug (`online-shop-agentur`) the hyphen is a separator, so each adjacent
// pair is joined too. A run over the part cap gets no whole-run form: a truncated run is not a
// compound. Single-letter parts count ("E-Mail" joins to
// "email") and stop words are not filtered, because the joined form is a spelling, not a topic.
const HYPHEN = /[-\u2010\u2011]/;
const MAX_JOIN_PARTS = 8;
// Distinct joined forms kept per text; the rest are not needed to bound the work.
const MAX_JOINS = 4096;

// One linear pass: a run is a maximal list of non-empty alphanumeric parts separated by a single
// hyphen (a doubled or a non-word separator ends it). A regex with an unbounded leading word
// retries at every position of a long hyphen-free word, which is quadratic.
function hyphenJoins(folded: string, adjacent: boolean): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      const forms: string[] = [];
      if (run.length <= MAX_JOIN_PARTS) forms.push(run.join(""));
      if (adjacent && run.length > 2) {
        for (let i = 0; i + 1 < run.length && i < 2 * MAX_JOIN_PARTS; i++)
          forms.push(run[i]! + run[i + 1]!);
      }
      for (const form of forms) {
        if (form.length >= 3 && form.length <= MAX_TOKEN_LENGTH && SPACED_WORD.test(form))
          out.push(form);
      }
    }
    run = [];
  };
  for (const chunk of folded.split(/[^\p{L}\p{N}\-\u2010\u2011]+/u)) {
    if (out.length >= MAX_JOINS) break;
    if (!chunk.includes("-") && !chunk.includes("\u2010") && !chunk.includes("\u2011")) continue;
    for (const part of chunk.split(HYPHEN)) {
      if (part === "") flush();
      else run.push(part);
    }
    flush();
  }
  return out;
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Equal, or one is a prefix of the other (3+ shared characters, 3 or fewer left over). */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.length - short.length <= 3 && long.startsWith(short);
}

// Not language-gated: the graph carries no page language, so English look-alikes ("Press" in
// "Compress images", "Stand" in "Understand taxes") also match. Accepted as a known limitation;
// the 5-character floor and the 3-character prefix keep it rare.
// An anchor word that ends a longer target word with at least three characters in front of it:
// the head noun of the target's closed compound ("Handschuhe" in "Fahrradhandschuhe"). Five
// characters keeps short endings ("care", "ware") from matching by chance. One direction only:
// a target word inside a longer anchor word is the glued-card case, judged separately.
const MIN_COMPOUND_PART = 5;
const MIN_COMPOUND_PREFIX = 3;

function sharesCompoundPart(anchor: readonly string[], target: readonly string[]): boolean {
  return anchor.some(
    (a) =>
      a.length >= MIN_COMPOUND_PART &&
      target.some((t) => t.length - a.length >= MIN_COMPOUND_PREFIX && t.endsWith(a)),
  );
}

// Words that name a listing of articles, folded like tokens (NFD, no marks, ß -> ss).
const LISTING_NOUNS: ReadonlySet<string> = new Set([
  "article",
  "articles",
  "artikel",
  "articulos",
  "articulo",
  "artigos",
  "post",
  "posts",
  "beitrage",
  "beitrag",
  "blog",
  "news",
  "stories",
  "nachrichten",
  "neuigkeiten",
  "noticias",
  "actualites",
  "archive",
  "archiv",
]);

// Words that only say "go to the list": quantifiers and navigation verbs.
const LISTING_LABEL_WORDS: ReadonlySet<string> = new Set([
  "all",
  "alle",
  "alles",
  "view",
  "show",
  "see",
  "browse",
  "more",
  "mehr",
  "read",
  "lesen",
  "latest",
  "recent",
  "neueste",
  "todos",
  "todas",
  "tous",
  "toutes",
  "ver",
]);

/** An anchor made only of listing words, with at least one naming a listing ("Alle Artikel"). */
function isListingLabel(anchor: readonly string[]): boolean {
  return (
    anchor.some((t) => LISTING_NOUNS.has(t)) &&
    anchor.every((t) => LISTING_NOUNS.has(t) || LISTING_LABEL_WORDS.has(t))
  );
}

// A listing is the LAST path segment, optionally followed by a page number (`/blog/page/2`,
// `/blog/2`) or a trailing slash. A noun earlier in the path ("/blog/how-to-fix-roof") is one
// article under a section, and every word of the segment must be a listing word, so
// "/products/blog-widget" is not a listing either.
function isListingTarget(target: string): boolean {
  const segments = safeDecode(getPathname(target))
    .split("/")
    .filter((seg) => seg !== "");
  if (segments.length > 0 && /^\d+$/.test(segments[segments.length - 1]!)) {
    segments.pop();
    if (segments[segments.length - 1]?.toLowerCase() === "page") segments.pop();
  }
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  const tokens = tokenize(last.replace(/\.html?$/i, "")).tokens;
  return (
    tokens.some((t) => LISTING_NOUNS.has(t)) &&
    tokens.every((t) => LISTING_NOUNS.has(t) || LISTING_LABEL_WORDS.has(t))
  );
}

function isJudgeableTarget(page: AnchorGraphPage): boolean {
  if (page.status === null || page.status < 200 || page.status > 299) return false;
  return !page.contentType || /html/i.test(page.contentType);
}

// Glued text may be separate words fused by CSS the parse cannot see ("Fridge" + "repairs" read
// "Fridgerepairs"): a target word that sits inside an anchor word counts as shared.
function sharesInsideGlue(anchor: readonly string[], target: readonly string[]): boolean {
  return target.some((t) => t.length >= 3 && anchor.some((a) => a.includes(t)));
}

function sharesToken(anchor: readonly string[], target: readonly string[]): boolean {
  return anchor.some((a) => target.some((t) => tokensMatch(a, t)));
}

// A joined form ("foobar" from Foo-Bar) is a spelling of one word: it must equal a word, or a
// joined form, of the other side. It gets no prefix or suffix allowance.
function sharesJoined(
  anchor: readonly string[],
  anchorJoined: readonly string[],
  target: readonly string[],
  targetJoined: readonly string[],
): boolean {
  return (
    anchorJoined.some((j) => target.includes(j) || targetJoined.includes(j)) ||
    anchor.some((a) => targetJoined.includes(a))
  );
}

function clipTitle(text: string | null): string | null {
  return text !== null && text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH) : text;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT_LENGTH ? `${t.slice(0, MAX_TEXT_LENGTH - 1)}…` : t;
}

/** A link that can carry anchor text to another crawled page: internal, followed, contextual. */
function isContextualGraphLink(link: LinkData): boolean {
  if (!link.isInternal || !link.url || link.isNofollow || link.isChrome) return false;
  // rel=next/prev is pagination; a fragment link ("Authentication" -> /docs/api#authentication)
  // names a section, not the page.
  if (link.rel?.some((r) => r === "next" || r === "prev")) return false;
  const hash = link.url.indexOf("#");
  return !(hash >= 0 && hash < link.url.length - 1);
}

/**
 * Accumulates the anchor graph one page at a time, so the streaming path keeps one page batch
 * resident. The legacy path feeds it every page; the result is identical either way.
 */
export interface AnchorPageInput {
  title?: string | null;
  h1?: readonly string[];
  links?: readonly LinkData[];
  /** HTTP status of the page; a target is judged only on 2xx. Unknown counts as not judged. */
  status?: number | null;
  /** Content type of the response; a target is judged only when it is HTML (absent is accepted). */
  contentType?: string | null;
}

// Keys a clipped-for-display text by its FULL folded identity, so two long anchors that share a
// 120-character prefix stay two anchors.
function textKey(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < folded.length; i++) {
    h ^= folded.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${folded.length}:${(h >>> 0).toString(36)}`;
}

interface PairState {
  texts: string[];
  keys: string[];
  tokens: string[];
  partTokens: string[];
  joined: string[];
  truncated: boolean;
  unspaced: boolean;
  glued: boolean;
}

export class AnchorGraphBuilder {
  private readonly pages = new Map<string, AnchorGraphPage>();
  // One entry per (target, source) pair, collapsed as links arrive so memory is bounded by the pair
  // and token caps, not the link count.
  private readonly pairs = new Map<string, Map<string, PairState>>();
  private pairCount = 0;
  private tokenCount = 0;
  private tokenChars = 0;
  private pageTokenCount = 0;
  private pageTokenChars = 0;
  // Distinct refused pairs, so three links to one refused pair count once. Bounded: past the bound
  // a refusal is counted without dedupe.
  private readonly droppedKeys = new Set<string>();
  private droppedOverflow = 0;
  // Anchor words repeat across thousands of pairs: one string each.
  private readonly words = new Map<string, string>();

  /**
   * @param crawled normalized keys of the crawled pages, when known up front: links to anything
   *   else are ignored at once, so an uncrawled target never uses the pair cap. Without it every
   *   target is kept and filtered at build time.
   */
  constructor(
    private readonly maxPairs: number = MAX_PAIRS,
    private readonly maxTotalTokens: number = MAX_TOTAL_TOKENS,
    private readonly crawled?: ReadonlySet<string>,
    private readonly maxTotalTokenChars: number = MAX_TOTAL_TOKEN_CHARS,
  ) {}

  private intern(word: string): string {
    const known = this.words.get(word);
    if (known !== undefined) return known;
    if (this.words.size < 200_000) this.words.set(word, word);
    return word;
  }

  /** Record one crawled page's facts, and fold its contextual links into pairs. */
  addPage(url: string, input: AnchorPageInput): void {
    // Query-preserving, like the stored pages: `/p?id=1` and `/p?id=2` are two pages.
    const key = normalizePageUrl(url);
    // The target side tokenises the FULL title and every H1; only the displayed copies are clipped.
    const heading = [input.title ?? "", ...(input.h1 ?? [])].join(" ").trim();
    const headingTokens: string[] = [];
    const headingJoined: string[] = [];
    let headingTruncated = false;
    if (heading !== "" && !hasForeignScript(heading)) {
      const found = tokenize(heading);
      headingTruncated = found.lost;
      for (const [into, words] of [
        [headingTokens, found.tokens],
        [headingJoined, found.joined],
      ] as const) {
        for (const token of words) {
          if (into.includes(token)) continue;
          if (
            into.length >= MAX_TOKENS_PER_PAGE ||
            this.pageTokenCount >= this.maxTotalTokens ||
            this.pageTokenChars + token.length > this.maxTotalTokenChars
          ) {
            headingTruncated = true;
            continue;
          }
          into.push(this.intern(token));
          this.pageTokenCount += 1;
          this.pageTokenChars += token.length;
        }
      }
    }
    this.pages.set(key, {
      title: clipTitle(input.title?.trim() || null),
      h1: (input.h1 ?? []).slice(0, MAX_H1).map((t) => clipTitle(t.trim()) ?? ""),
      status: input.status ?? null,
      contentType: input.contentType ?? null,
      hasHeading: heading !== "",
      headingForeign: heading !== "" && hasForeignScript(heading),
      headingTokens,
      headingJoined,
      headingTruncated,
    });
    for (const link of input.links ?? []) {
      if (!isContextualGraphLink(link)) continue;
      let target: string;
      try {
        const resolved = new URL(link.url, url).href;
        // Before keying: pagination is marked by the query.
        if (isPaginationTarget(resolved)) continue;
        target = normalizePageUrl(resolved);
      } catch {
        continue;
      }
      if (target === key || (this.crawled && !this.crawled.has(target))) continue;
      let bySource = this.pairs.get(target);
      let pair = bySource?.get(key);
      if (!pair) {
        // Capacity first: a refused pair must not leave an empty target bucket behind.
        if (this.pairCount >= this.maxPairs) {
          const dropKey = `${target}\u0000${key}`;
          if (this.droppedKeys.has(dropKey)) continue;
          if (this.droppedKeys.size < MAX_DROPPED_KEYS) this.droppedKeys.add(dropKey);
          else this.droppedOverflow += 1;
          continue;
        }
        if (!bySource) this.pairs.set(target, (bySource = new Map()));
        bySource.set(
          key,
          (pair = {
            texts: [],
            keys: [],
            tokens: [],
            partTokens: [],
            joined: [],
            truncated: false,
            unspaced: false,
            glued: false,
          }),
        );
        this.pairCount += 1;
      }
      const text = link.text ?? "";
      if (hasForeignScript(text)) pair.unspaced = true;
      if (link.textGlued) pair.glued = true;
      // Tokenised BEFORE clipping: a long card's matching word may sit past the clip.
      const found = tokenize(text);
      if (found.lost) pair.truncated = true;
      this.addPairTokens(pair, pair.tokens, found.tokens, true);
      this.addPairTokens(pair, pair.joined, found.joined, true);
      if (link.textGlued && link.textParts) {
        for (const part of link.textParts) {
          const piece = tokenize(part);
          this.addPairTokens(pair, pair.partTokens, piece.tokens, false);
          this.addPairTokens(pair, pair.joined, piece.joined, false);
          // A part cut at the stored length lost its tail: the missing words could be the match.
          if (part.length >= MAX_ANCHOR_PART_LENGTH) pair.truncated = true;
        }
        // A full list may have dropped later parts.
        if (link.textParts.length >= MAX_ANCHOR_PARTS) pair.truncated = true;
      }
      // A blank anchor (empty, or only stop words) is not a distinct anchor text: recording it
      // would hide the "only contextual anchor text" escalation.
      if (found.tokens.length === 0 && !found.lost && !hasForeignScript(text)) continue;
      // Identity from the full text, display from the clipped one.
      const id = textKey(text);
      if (pair.keys.length < MAX_TEXTS_PER_PAIR && !pair.keys.includes(id)) {
        pair.keys.push(id);
        pair.texts.push(clip(text));
      }
    }
  }

  private addPairTokens(
    pair: PairState,
    into: string[],
    tokens: readonly string[],
    markTruncated: boolean,
  ): void {
    for (const token of tokens) {
      if (into.includes(token)) continue;
      if (
        into.length >= MAX_TOKENS_PER_PAIR ||
        this.tokenCount >= this.maxTotalTokens ||
        this.tokenChars + token.length > this.maxTotalTokenChars
      ) {
        // A comparison on a cut-off word list can only be trusted when it found a match.
        if (markTruncated) pair.truncated = true;
        continue;
      }
      into.push(this.intern(token));
      this.tokenCount += 1;
      this.tokenChars += token.length;
    }
  }

  build(): AnchorGraph {
    const pairs: AnchorGraphPair[] = [];
    for (const target of [...this.pairs.keys()].sort()) {
      const bySource = this.pairs.get(target)!;
      this.pairs.delete(target);
      if (!this.pages.has(target)) continue;
      for (const source of [...bySource.keys()].sort()) {
        const pair = bySource.get(source)!;
        // Released as it is moved out; the arrays are handed over, not copied.
        bySource.delete(source);
        pairs.push({
          source,
          target,
          texts: pair.texts,
          textKeys: pair.keys,
          tokens: pair.tokens,
          partTokens: pair.partTokens,
          joined: pair.joined,
          truncated: pair.truncated,
          unspaced: pair.unspaced,
          glued: pair.glued,
        });
      }
    }
    // Only refused pairs whose target is a crawled page count.
    let droppedPairs = this.droppedOverflow;
    for (const k of this.droppedKeys) {
      if (this.pages.has(k.slice(0, k.indexOf("\u0000")))) droppedPairs += 1;
    }
    return { pages: this.pages, pairs, droppedPairs };
  }
}

interface Mismatch {
  source: string;
  target: string;
  anchor: string;
  title: string | null;
  onlyAnchor: boolean;
}

/**
 * The shared front-door test treats any URL whose path is `/` as the homepage. Here a target with
 * a query string is a different page (WordPress `/?p=123`, `/?page_id=5`), so it is the front door
 * only when it is exactly the base or an entry URL, query included.
 */
function anchorFrontDoorTest(
  baseUrl: string,
  entryUrls: readonly string[],
): (url: string) => boolean {
  const shared = frontDoorTest(baseUrl, entryUrls);
  const exact = new Set([baseUrl, ...entryUrls].map((u) => normalizePageUrl(u)));
  return (url) => {
    let hasQuery = false;
    try {
      hasQuery = new URL(url).search !== "";
    } catch {
      // Not an absolute URL: the shared test decides.
    }
    return hasQuery ? exact.has(normalizePageUrl(url)) : shared(url);
  };
}

/** Judge every pair; shared by both paths. */
export function evaluateAnchorGraph(
  graph: AnchorGraph,
  baseUrl: string,
  entryUrls: readonly string[],
  capped: boolean,
): CheckResult {
  const isFrontDoor = anchorFrontDoorTest(baseUrl, entryUrls);
  interface TargetWords {
    tokens: string[];
    joined: string[];
    truncated: boolean;
  }
  const targetTokens = new Map<string, TargetWords | null>();
  // Null: not a target at all (front door, utility page) or one that cannot be judged.
  const tokensFor = (target: string): TargetWords | null => {
    const cached = targetTokens.get(target);
    if (cached !== undefined) return cached;
    let words: TargetWords | null = null;
    const page = graph.pages.get(target);
    if (page && !isFrontDoor(target) && !isUtilityPage(target) && isJudgeableTarget(page)) {
      // A title or H1 in an unspaced script, or one that gives no word at all, leaves only the
      // slug to compare against: too thin to warn on.
      const noWord = page.hasHeading && page.headingTokens.length === 0 && !page.headingTruncated;
      if (!page.headingForeign && !noWord) {
        const slug = tokenize(safeDecode(getPathname(target)), { slug: true });
        const all = [...page.headingTokens, ...slug.tokens];
        // A bare id (`/p/123`) is no topic: with no title or H1 there is nothing to compare.
        if (all.some((t) => /\p{L}/u.test(t)))
          words = {
            tokens: all,
            joined: [...(page.headingJoined ?? []), ...slug.joined],
            truncated: page.headingTruncated,
          };
      }
    }
    targetTokens.set(target, words);
    return words;
  };

  // Every distinct anchor text each target receives, for the "only anchor text" escalation.
  const textsByTarget = new Map<string, Set<string>>();
  for (const pair of graph.pairs) {
    let set = textsByTarget.get(pair.target);
    if (!set) textsByTarget.set(pair.target, (set = new Set()));
    for (const k of pair.textKeys) set.add(k);
  }

  const mismatches: Mismatch[] = [];
  let judged = 0;
  let notJudged = 0;
  for (const pair of graph.pairs) {
    const targetWords = tokensFor(pair.target);
    const target = targetWords?.tokens ?? null;
    // Utility pages and the front door are not targets at all: not counted either way.
    if (!target) {
      if (!isFrontDoor(pair.target) && !isUtilityPage(pair.target)) notJudged += 1;
      continue;
    }
    const anchor = pair.tokens;
    if (anchor.length === 0 || pair.unspaced) {
      notJudged += 1;
      continue;
    }
    const anchorJoined = pair.joined ?? [];
    const targetJoined = targetWords!.joined;
    if (
      sharesToken(anchor, target) ||
      sharesJoined(anchor, anchorJoined, target, targetJoined) ||
      sharesCompoundPart(anchor, target) ||
      (pair.glued &&
        (sharesInsideGlue(anchor, target) ||
          sharesToken(pair.partTokens, target) ||
          sharesJoined(pair.partTokens, anchorJoined, target, targetJoined)))
    ) {
      judged += 1;
      continue;
    }
    // A generic listing label on a listing page: the context names the target, not the words.
    if (isListingLabel(anchor) && isListingTarget(pair.target)) {
      notJudged += 1;
      continue;
    }
    // No shared word, but the anchor's word list was cut off: not a definitive mismatch.
    if (pair.truncated || targetWords!.truncated) {
      notJudged += 1;
      continue;
    }
    judged += 1;
    const distinct = textsByTarget.get(pair.target);
    mismatches.push({
      source: pair.source,
      target: pair.target,
      anchor: pair.texts.filter((t) => t.trim()).join(" / "),
      title: graph.pages.get(pair.target)?.title ?? null,
      onlyAnchor: !capped && graph.droppedPairs === 0 && distinct?.size === 1,
    });
  }

  const details = { judged, notJudged, droppedPairs: graph.droppedPairs };
  if (mismatches.length === 0) {
    // Nothing was compared: a pass here would lift the links score for no evidence.
    if (judged === 0) {
      return {
        name: CHECK_NAME,
        status: "skipped",
        message: "No link pair had anchor text and a target to compare",
        details,
      };
    }
    return {
      name: CHECK_NAME,
      status: "pass",
      message: "Anchor text shares a word with the page it points at",
      details,
    };
  }

  const only = new Set(mismatches.filter((m) => m.onlyAnchor).map((m) => m.target));
  const targets = new Set(mismatches.map((m) => m.target));
  const escalation =
    only.size > 0
      ? `; for ${only.size} of them it is the only contextual anchor text the page receives`
      : "";
  return {
    name: CHECK_NAME,
    status: "warn",
    message: `${mismatches.length} link pair(s) to ${targets.size} page(s) use anchor text that shares no word with the target${escalation}`,
    items: mismatches.slice(0, MAX_ITEMS).map((m) => ({
      id: `${m.source} -> ${m.target}`,
      // #1729: the id names a PAIR, which is not a page; without sourcePages the
      // affected-pages aggregation read it as one ("/faq%20-%3E%20https://...").
      sourcePages: [m.source],
      label: `"${m.anchor}" -> ${m.target}${m.title ? ` (title: "${m.title}")` : ""}${m.onlyAnchor ? ", the only contextual anchor text this page receives" : ""}`,
    })),
    details: { ...details, total: mismatches.length, onlyAnchorTargets: only.size },
    value: mismatches
      .slice(0, 5)
      .map((m) => `"${m.anchor}" -> ${getPathname(m.target)}`)
      .join("\n"),
  };
}

export const anchorMismatchRule: Rule = {
  meta: {
    id: "links/anchor-mismatch",
    name: "Anchor Text Mismatch",
    description:
      "Detects contextual links whose anchor text shares no word with the title, H1 or URL slug of the page they point at",
    solution:
      "Anchor text tells search engines and readers what the target page is about. When every link to a page says something unrelated (for example 'how I work' or 'our services' on a page about wholesale orders), the page earns no topical signal from its inbound links. Rewrite the anchor to name the destination using the words its title or heading uses. Links in the navigation, header, footer and sidebar are ignored, and so are privacy, terms and contact pages.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 3,
    optionsSchema: z.object({}),
  },

  run(ctx: RuleContext): RuleResult {
    const limits = ctx.site?.crawlLimits;
    const capped = Boolean(limits && limits.pagesCrawled >= limits.maxPages);
    const baseUrl = ctx.site?.baseUrl || "";
    const entryUrls = ctx.site?.entryUrls ?? [];

    if (ctx.siteQuery) {
      const graph = ctx.siteQuery.anchorGraph?.();
      if (!graph || graph.pages.size < 2) return { checks: [SKIP_CHECK] };
      return { checks: [evaluateAnchorGraph(graph, baseUrl, entryUrls, capped)] };
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length < 2) return { checks: [SKIP_CHECK] };

    const builder = new AnchorGraphBuilder(
      undefined,
      undefined,
      new Set(pages.map((page) => normalizePageUrl(page.url))),
    );
    for (const page of pages) {
      builder.addPage(page.url, {
        title: page.parsed.meta?.title,
        h1: page.parsed.h1?.texts,
        links: page.parsed.links,
        status: page.statusCode,
        contentType: page.headers?.["content-type"] ?? page.headers?.["Content-Type"],
      });
    }
    return { checks: [evaluateAnchorGraph(builder.build(), baseUrl, entryUrls, capped)] };
  },
};
