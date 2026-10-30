// content/keyword-stuffing - Excessive keyword repetition detection

import { getDomainWithoutSuffix } from "tldts";
import { z } from "zod";

import { primaryLangSubtag } from "../shared/generic-link-phrases";
import type { Rule, RuleContext, RuleResult, CheckResult, ParsedPage } from "../types";
import { getRenderedProseText, getRenderedProseTextWhere } from "./text-content";

export const optionsSchema = z.object({
  density_threshold: z.number().default(3).describe("Keyword density percentage threshold"),
  min_occurrences: z.number().default(5).describe("Minimum word occurrences to flag"),
  whitelist: z
    .array(z.string())
    .default([])
    .describe("Words to ignore; the site's own brand name is already ignored"),
});

// Prefixes and suffixes launch domains wrap around a product name
// (getacme.com, acmehq.com, tryacme.app).
const DOMAIN_PREFIXES = ["get", "try", "use", "join", "hey", "with", "go"];
const DOMAIN_SUFFIXES = ["hq", "app", "labs", "lab", "ai", "io", "inc"];

// English applies on every page to preserve the rule's existing behaviour
// when lang is absent or unknown. A recognised page language adds its own
// grammatical filler, using the same primary-subtag parsing as link-text.
function wordSet(...groups: string[]): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => group.split(" ")));
}

const COMMON_WORDS = wordSet(
  "the and that have for not with you this but from they will would there their what about which when make can like been more some than them other into could just also",
  // Function words / generic verbs (#695) that read as high density on
  // ordinary pages, never as a real SEO target.
  "your our his her its who whom whose get here very such same each any all most much many even still yet",
  // `out` (#1315): "out of stock", "check out" on every product page.
  "out",
);

// Price-note boilerplate repeated beside every product on English shops
// (#1182), not copy written to target a search term. Unlike COMMON_WORDS,
// these terms are meaningful copy in other languages (#1232).
const ENGLISH_PRICE_NOTE_WORDS = wordSet("incl vat");

const LANGUAGE_STOP_WORDS = new Map<string, ReadonlySet<string>>([
  [
    "de",
    wordSet(
      "aber alle allem allen aller alles als also ander andere anderem anderen anderer anderes auch auf aus bei bin bis bist damit dann das dass dein deine dem den denn der des die dies diese",
      "ein eine einem einen einer eines etwas hat haben hier ich ihr ihre ist jede kein keine man mehr mein meine mit nach nicht noch nun nur oder sein seine sind solche und uns unser",
      "vom von war waren was wenn wer wie wir wird zum zur inkl mwst zzgl versandkosten",
      // Formal and informal address and common pronouns (#1315): "Sie" in every sentence of a
      // service page, "für" everywhere. Words under three characters are never tokens.
      "sie für dich dir deinen deinem deiner deines ihn ihm ihnen ihren ihrem ihrer",
    ),
  ],
  [
    "es",
    wordSet(
      "algo algunas algunos ante antes aquel aqui bajo bien cada como con contra cual cuando del desde donde durante ella ellas ellos entre era eran esta estas este estos fue fueron",
      "hacia hasta hay las los mas mientras muy nada nos nosotros otra otras otro otros para pero poco por porque que quien ser sin sobre son sus tanto tiene todo todos una unas uno unos",
    ),
  ],
  [
    "fr",
    wordSet(
      "alors aucun aussi autre aux avec avoir car ceci cela ces cette comme dans des donc elle elles encore entre est eux faire fois ils les leur leurs mais mes moins mon nos notre nous",
      "par parce pas peut plus pourquoi quand que quel quelle qui sans ses son sont sous sur tous tout tres une vos votre vous",
    ),
  ],
  [
    "pt",
    wordSet(
      "ainda algo algumas alguns assim ate bem cada como com contra das dela dele deles depois desde dos durante ela elas ele eles entre essa essas esse esses esta estas este estes foi foram",
      "isso isto mais mas mesmo muito nao nas nos nossa nosso numa onde outra outras outro outros para pela pelas pelo pelos por porque qual quando que quem sem ser seus sua suas sobre sao tem todo todos uma umas uns voce voces",
    ),
  ],
  [
    "it",
    wordSet(
      "alcune alcuni altro anche ancora avere che chi come con contro cui dagli dai dal dalla dalle degli dei del della delle dentro deve dove due era erano essere fare fra gli hanno lei loro",
      "mai molto nei nel nella nelle noi non ogni per pero piu quale quando questa queste questi questo sara senza sia siamo sono sua sue sul sulla tra tutti tutto una uno voi",
    ),
  ],
  [
    "nl",
    wordSet(
      "aan alle als bij dan dat deze die dit door een had hebben heeft hem het hier hij hoe hun kan maar meer met mij moet naar niet nog ook ons onze over tot uit van veel voor want",
      "waren was wat wel werd worden zal zijn zonder zou",
    ),
  ],
]);

const MAX_WORD_CODE_POINTS = 64;
const MAX_MAIN_LANDMARK_CANDIDATES = 8;
const LETTER = /^\p{L}$/u;
const LATIN_LETTER = /^\p{Script=Latin}$/u;
const MARK = /^\p{M}$/u;
const UNSEGMENTED_EAST_ASIAN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Lowercase Unicode words without fragmenting umlauts, ß or decomposed letters.
 * Normalize one bounded token at a time: compatibility normalization can
 * expand one site-controlled character many times, so normalizing the whole
 * page first would let a compact input multiply the work. Han, Kana and Hangul
 * runs are skipped because punctuation boundaries are not word boundaries in
 * those scripts and this rule has no language segmenter (#1182).
 */
export function keywordTokens(text: string): string[] {
  const words: string[] = [];
  let rawWord = "";
  let codePoints = 0;
  let overflow = false;

  const finishWord = () => {
    if (!overflow && codePoints >= 3) {
      const normalized = rawWord.normalize("NFKC").toLowerCase();
      let normalizedLength = 0;
      let valid = !UNSEGMENTED_EAST_ASIAN.test(normalized);
      for (const char of normalized) {
        normalizedLength += 1;
        if (
          normalizedLength > MAX_WORD_CODE_POINTS ||
          (!LETTER.test(char) && !(normalizedLength > 1 && MARK.test(char)))
        ) {
          valid = false;
          break;
        }
      }
      if (valid && normalizedLength >= 3) words.push(normalized);
    }
    rawWord = "";
    codePoints = 0;
    overflow = false;
  };

  for (const char of text) {
    if (LETTER.test(char) || (codePoints > 0 && MARK.test(char))) {
      codePoints += 1;
      if (codePoints <= MAX_WORD_CODE_POINTS) rawWord += char;
      else overflow = true;
    } else {
      finishWord();
    }
  }
  finishWord();
  return words;
}

/** Whether most measured letters use scripts for which the rule has no word list. */
function hasUnsupportedScriptMajority(words: readonly string[]): boolean {
  let latinLetters = 0;
  let unsupportedLetters = 0;
  for (const word of words) {
    for (const char of word) {
      if (!LETTER.test(char)) continue;
      if (LATIN_LETTER.test(char)) latinLetters += 1;
      else unsupportedLetters += 1;
    }
  }
  return unsupportedLetters > latinLetters;
}

const CHROME_TAGS = new Set(["header", "nav", "footer", "aside"]);
const CHROME_ROLES = new Set(["banner", "navigation", "contentinfo", "complementary"]);
const CONTENT_REGION_TAGS = new Set(["article", "section"]);

function isPageChrome(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  if (tag && CHROME_TAGS.has(tag)) return true;
  const role = el.getAttribute?.("role")?.toLowerCase();
  return role ? CHROME_ROLES.has(role) : false;
}

function isContentRegion(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  return tag ? CONTENT_REGION_TAGS.has(tag) : false;
}

/** Site chrome excludes an article's own header, footer, navigation and aside. */
function isSiteChrome(el: Element, root: Element): boolean {
  if (!isPageChrome(el)) return false;
  let current = el.parentElement;
  while (current && current !== root) {
    if (isContentRegion(current)) return false;
    current = current.parentElement;
  }
  return true;
}

function createSiteChromeAncestorTest(root: Element): (element: Element) => boolean {
  const known = new WeakMap<Element, boolean>();
  return (element) => {
    const passed: Element[] = [];
    let current: Element | null = element;
    let answer = false;
    while (current && current !== root) {
      const cached = known.get(current);
      if (cached !== undefined) {
        answer = cached;
        break;
      }
      passed.push(current);
      if (isSiteChrome(current, root)) {
        answer = true;
        break;
      }
      current = current.parentElement;
    }
    for (const el of passed) known.set(el, answer);
    return answer;
  };
}

/** Smallest number of links, and of different labels, for a block to read as a link list (menu, footer columns). */
const LINK_LIST_MIN_LINKS = 6;
const LINK_LIST_MIN_LABELS = 4;
/** Share of a block's text that is link text for it to be a link list. */
const LINK_LIST_TEXT_SHARE = 0.85;
const LINK_LIST_MAX_ANCHORS = 3000;
const LINK_LIST_MAX_DEPTH = 8;

/** A word shared by at least this share of a block's link labels makes it a keyword cloud, not a menu (a menu of varied categories shares far less). */
const LINK_CLOUD_SHARE = 0.3;
/** Labels looked at per block to tell a keyword cloud from a menu. */
const LINK_CLOUD_SAMPLE = 60;

/**
 * A block of links is a menu only on a real interaction or landmark signal: it, or a wrapper up to
 * three levels above it, has `role` menu, menubar or navigation, or carries the attributes a JS
 * dropdown sets (`aria-haspopup`, `aria-expanded`). Class and id names (`nav`, `menu`) and a plain
 * `ul > li` are NOT signals: anyone can write them, and a keyword spammer would.
 */
function hasMenuSignal(element: Element, body: Element, cache: WeakMap<Element, boolean>): boolean {
  const known = cache.get(element);
  if (known !== undefined) return known;
  let answer = false;
  let current: Element | null = element;
  for (let depth = 0; current && current !== body && depth < 4; depth++, current = current.parentElement) {
    const role = current.getAttribute?.("role")?.toLowerCase();
    if (role === "menu" || role === "menubar" || role === "navigation") {
      answer = true;
      break;
    }
    if (current.hasAttribute?.("aria-haspopup") || current.hasAttribute?.("aria-expanded")) {
      answer = true;
      break;
    }
  }
  cache.set(element, answer);
  return answer;
}

/** True when one word is in most of the labels: "emergency plumber london", "emergency plumber leeds", ... */
function isKeywordCloud(labels: readonly string[]): boolean {
  if (labels.length === 0) return false;
  const counts = new Map<string, number>();
  for (const label of labels) {
    for (const word of new Set(keywordTokens(label))) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let top = 0;
  for (const n of counts.values()) if (n > top) top = n;
  return top >= labels.length * LINK_CLOUD_SHARE;
}

/**
 * Blocks that are mostly link text: a mega menu or footer columns built from plain
 * `div`s, which the landmark test cannot see (#1315). Their link labels are site
 * navigation repeated on every page, not copy. Only used when the page has no main
 * copy of its own to measure. Requires several DIFFERENT labels, a real menu signal (see
 * {@link hasMenuSignal}) and no keyword-cloud pattern (see {@link isKeywordCloud}), so a block that
 * repeats one anchor ("emergency plumber" x20), or a cloud of keyword links, still counts.
 */
function createLinkListTest(body: Element): (element: Element) => boolean {
  type Stats = { links: number; chars: number; labels: Set<string>; sample: string[] };
  const stats = new Map<Element, Stats>();
  let seen = 0;
  for (const a of body.querySelectorAll("a")) {
    if (++seen > LINK_LIST_MAX_ANCHORS) break;
    const label = (a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!label) continue;
    let current: Element | null = a.parentElement;
    for (let depth = 0; current && current !== body && depth < LINK_LIST_MAX_DEPTH; depth++, current = current.parentElement) {
      let entry = stats.get(current);
      if (!entry) {
        entry = { links: 0, chars: 0, labels: new Set(), sample: [] };
        stats.set(current, entry);
      }
      entry.links += 1;
      entry.chars += label.replace(/\s/g, "").length;
      if (entry.labels.size < LINK_LIST_MIN_LABELS) entry.labels.add(label);
      if (entry.sample.length < LINK_CLOUD_SAMPLE) entry.sample.push(label);
    }
  }
  const lists = new WeakSet<Element>();
  const signals = new WeakMap<Element, boolean>();
  for (const [element, entry] of stats) {
    // Cheapest tests first: counts, then the signal (attributes only, cached), then the keyword cloud, and
    // only then the text of the element (a giant ancestor's text is not read for every candidate).
    if (entry.links < LINK_LIST_MIN_LINKS || entry.labels.size < LINK_LIST_MIN_LABELS) continue;
    if (!hasMenuSignal(element, body, signals) || isKeywordCloud(entry.sample)) continue;
    const textChars = (element.textContent || "").replace(/\s/g, "").length;
    if (textChars > 0 && entry.chars >= textChars * LINK_LIST_TEXT_SHARE) lists.add(element);
  }
  const known = new WeakMap<Element, boolean>();
  return (element) => {
    const passed: Element[] = [];
    let current: Element | null = element;
    let answer = false;
    while (current && current !== body) {
      const cached = known.get(current);
      if (cached !== undefined) {
        answer = cached;
        break;
      }
      passed.push(current);
      if (lists.has(current)) {
        answer = true;
        break;
      }
      current = current.parentElement;
    }
    for (const el of passed) known.set(el, answer);
    return answer;
  };
}

interface ContentSelection {
  readonly root: Element;
  readonly words: string[];
  readonly isInExcludedChrome: ((element: Element) => boolean) | null;
}

function selectMainContent(
  doc: NonNullable<ParsedPage["document"]>,
  body: Element,
): ContentSelection {
  const isInSiteChrome = createSiteChromeAncestorTest(body);
  let largest: { readonly root: Element; readonly words: string[] } | undefined;
  let measuredMainLandmarks = 0;

  // Invalid pages sometimes carry several main landmarks. Prefer the one with
  // the most rendered copy among a bounded number of candidates, and fall back
  // to the body when none reaches the rule's 100-word measurement floor. The
  // bound keeps nested hostile landmarks from rescanning the same subtree.
  for (const root of doc.querySelectorAll('main, [role="main"]')) {
    if (isInSiteChrome(root)) continue;
    if (measuredMainLandmarks >= MAX_MAIN_LANDMARK_CANDIDATES) break;
    measuredMainLandmarks += 1;
    const words = keywordTokens(getRenderedProseText(root));
    if (!largest || words.length > largest.words.length) largest = { root, words };
  }
  if (largest && largest.words.length >= 100) {
    return { ...largest, isInExcludedChrome: null };
  }

  // One substantial article is the page's primary copy. A listing with several
  // articles, or a small article beside the real copy, keeps the body fallback.
  const articles = doc.querySelectorAll("article");
  if (articles.length === 1 && !isInSiteChrome(articles[0])) {
    const root = articles[0];
    const words = keywordTokens(getRenderedProseText(root));
    if (words.length >= 100) return { root, words, isInExcludedChrome: null };
  }

  const isInLinkList = createLinkListTest(body);
  const isExcluded = (element: Element): boolean => isInSiteChrome(element) || isInLinkList(element);
  const words = keywordTokens(getRenderedProseTextWhere(body, isExcluded));
  return { root: body, words, isInExcludedChrome: isExcluded };
}

/**
 * The site's own brand / product name as lowercase word tokens, from the page's
 * registrable domain label plus any `og:site_name` / `application-name` token
 * that also appears in that label. A one-product landing page repeats its own
 * name because that is what the page is for, so these never count as stuffing.
 *
 * Anchored on the domain on purpose: a site name is page-controlled text, and a
 * spam page could set it to the keyword it stuffs. A name token only counts when
 * the site's own domain carries it too.
 */
export function brandTerms(
  pageUrl: string,
  doc: NonNullable<ParsedPage["document"]>
): Set<string> {
  const terms = new Set<string>();
  let label = "";
  try {
    label = (getDomainWithoutSuffix(new URL(pageUrl).hostname) || "").toLowerCase();
  } catch {
    return terms;
  }
  // Only a single-word label is a brand token: "cheap-plumber-london" names
  // keywords, not a brand, and never matched one [a-z]{3,} token anyway.
  if (!/^[a-z]{3,}$/.test(label)) return terms;
  terms.add(label);
  for (const prefix of DOMAIN_PREFIXES) {
    if (label.startsWith(prefix) && label.length - prefix.length >= 3) {
      terms.add(label.slice(prefix.length));
    }
  }
  for (const suffix of DOMAIN_SUFFIXES) {
    if (label.endsWith(suffix) && label.length - suffix.length >= 3) {
      terms.add(label.slice(0, -suffix.length));
    }
  }

  const names = [
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content"),
    doc.querySelector('meta[name="application-name"]')?.getAttribute("content"),
  ];
  for (const name of names) {
    for (const word of name?.toLowerCase().match(/[a-z]{3,}/g) || []) {
      if (label.includes(word)) terms.add(word);
    }
  }
  return terms;
}

/** Leaf-ish elements whose whole text is a short component string. */
const CARD_TEXT_SELECTOR = "p, span, div, li, dd, dt, small";
const CARD_TEXT_MAX_CHARS = 160;
const CARD_MIN_PARENTS = 3;
/** Candidate leaf texts looked at per page, and the elements scanned to find them. Both are bounds. */
const CARD_MAX_ELEMENTS = 4000;
const CARD_MAX_SCANNED = 40_000;
/**
 * The shapes of numbers a card varies: an amount beside a currency symbol or code, a percentage, "4 of 5" / "4/5",
 * and a count of stars or reviews. A bare number is NOT one, a decimal included ("plumber 49.99"): doorway spam
 * numbers and prices its lines, and must never read as a card.
 */
const CARD_NUMBER =
  /[$\u20ac\u00a3\u00a5]\s?\d[\d.,]*|\d[\d.,]*\s?(?:[$\u20ac\u00a3\u00a5%]|(?:eur|usd|gbp|chf)\b)|\b\d\s*(?:of|von|\/)\s*\d+\b|\b\d+\s*(?:stars?|sterne|sternen|reviews?|bewertungen)\b/gi;
/** The card deduction never removes more than this share of the measured words... */
const CARD_MAX_SHARE = 0.2;
/** ...never takes a word below this share of the density threshold (half of it: 1.5% by default)... */
const CARD_FLOOR_SHARE = 0.5;
/** ...and never touches a word that is this share (%) of the measured words before any deduction. */
const CARD_RAW_DENSITY_LIMIT = 10;

/**
 * Rating and price microcopy repeated once per card (#1315): "Average rating 4.5 of 5 stars", "from 12,90 EUR in
 * instalments". `text -> occurrences` for every text that, with its rating- or price-shaped numbers replaced, is
 * the whole text of a leaf element in at least {@link CARD_MIN_PARENTS} different parent wrappers AND whose
 * numbers differ between occurrences. Text with no such number is never deducted, nor is one whose only numbers
 * are bare ("emergency plumber london 17", "plumber 49.99"). The deduction is bounded, because a spammer can dress
 * a phrase in a price: at most {@link CARD_MAX_SHARE} of the page's words in total (the largest texts first, clamped),
 * never below {@link CARD_FLOOR_SHARE} of the density threshold for any one word, and not at all for a word that is
 * {@link CARD_RAW_DENSITY_LIMIT}% or more of the page before it.
 * The trade-offs: non-numeric card microcopy ("In stock"), a price identical on every card and a bare count
 * ("12 reviews" is covered, "12 items" is not) still count toward density. The total deducted is capped at
 * {@link CARD_MAX_SHARE} of the page's words.
 *
 * Linear in the page: each leaf is read once, with no parent text read at all.
 */
function repeatedCardText(root: Element, excluded: ((element: Element) => boolean) | null): Map<string, number> {
  const byText = new Map<string, { count: number; parents: Set<Element>; raws: Set<string> }>();
  let scanned = 0;
  let candidates = 0;
  for (const el of root.querySelectorAll(CARD_TEXT_SELECTOR)) {
    // Every leaf looked at counts toward the bounds, kept or not.
    if (++scanned > CARD_MAX_SCANNED || candidates >= CARD_MAX_ELEMENTS) break;
    if (el.children.length > 0) continue;
    candidates += 1;
    if (excluded?.(el)) continue;
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (raw.length < 8 || raw.length > CARD_TEXT_MAX_CHARS) continue;
    CARD_NUMBER.lastIndex = 0;
    if (!CARD_NUMBER.test(raw)) continue;
    CARD_NUMBER.lastIndex = 0;
    // The number is masked but its letters stay ("eur", "stars", "reviews"): they are words of the page
    // too, so a repeated "from 12,90 EUR" deducts "eur" with the rest of the card.
    const key = raw.toLowerCase().replace(CARD_NUMBER, (m) => {
      const letters = m.replace(/[^\p{L}]+/gu, " ").trim();
      return letters ? `# ${letters}` : "#";
    });
    let entry = byText.get(key);
    if (!entry) {
      entry = { count: 0, parents: new Set(), raws: new Set() };
      byText.set(key, entry);
    }
    entry.count += 1;
    if (el.parentElement) entry.parents.add(el.parentElement);
    if (entry.raws.size < 2) entry.raws.add(raw.toLowerCase());
  }
  const out = new Map<string, number>();
  for (const [text, entry] of byText) {
    if (entry.parents.size >= CARD_MIN_PARENTS && entry.raws.size >= 2) out.set(text, entry.count);
  }
  return out;
}

export const keywordStuffingRule: Rule = {
  meta: {
    id: "content/keyword-stuffing",
    name: "Keyword Stuffing",
    description: "Detects excessive keyword repetition in content",
    solution:
      "Keyword stuffing is repeating words unnaturally to manipulate rankings. Search engines penalize this practice. Write naturally for users first. Use keywords where they fit naturally. Aim for 1-2% keyword density at most. Use synonyms and related terms instead of repeating the exact same phrase. Focus on providing value, not gaming algorithms.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Get text content
    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "keyword-stuffing",
        status: "skipped",
        message: "No body content to analyze",
      });
      return { checks };
    }

    const pageLanguage = primaryLangSubtag(doc.documentElement?.getAttribute("lang"));
    const pageStopWords = LANGUAGE_STOP_WORDS.get(pageLanguage);
    const usesEnglishPriceNotes = pageLanguage === "" || pageLanguage === "en";

    // Prefer substantial main copy. Otherwise retain body copy but drop only
    // site-wide chrome, not headers and footers inside articles or sections.
    // Both paths are non-mutating because every rule shares this document.
    const { root: contentRoot, words, isInExcludedChrome } = selectMainContent(doc, body);

    // A lang attribute is page-controlled and must not turn off a scored rule.
    // Skip only when the measured copy itself is predominantly written in a
    // script for which the rule has no function-word list (#1232).
    if (hasUnsupportedScriptMajority(words)) {
      checks.push({
        name: "keyword-stuffing",
        status: "skipped",
        message: "Most content uses a script without a function-word list",
      });
      return { checks };
    }

    if (words.length < 100) {
      checks.push({
        name: "keyword-stuffing",
        status: "info",
        message: "Content too short for keyword density analysis",
        details: { inconclusive: true },
      });
      return { checks };
    }

    // Count word frequency
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    // Find words with high density, excluding English common words and the
    // grammatical filler for the page's declared language (#1042).
    // Repeated generic nav/CTA labels ("Learn more" x11 cards) are a UI
    // component, not organic content — don't count their words toward
    // density (#695). Deliberately an ALLOWLIST of known boilerplate phrases
    // (not "any repeated short anchor text"): a spam page repeating a real
    // commercial keyword as anchor text ("emergency plumber" x20) must still
    // count fully toward density, so genuine anchor-text stuffing still flags.
    const GENERIC_CTA_LABELS = new Set([
      "learn more",
      "read more",
      "see more",
      "view more",
      "show more",
      "load more",
      "find out more",
      "get started",
      "sign up",
      "sign in",
      "log in",
      "contact us",
      "click here",
      "shop now",
      "buy now",
      "add to cart",
      "view details",
      "view all",
      "see all",
      "book now",
      "get a quote",
      "request a quote",
      "subscribe",
      "join now",
      "try for free",
      "try it free",
      "get in touch",
      "call now",
      "download now",
      "next page",
      "previous page",
      "back to top",
    ]);
    const ctaLabelCounts = new Map<string, number>();
    for (const el of contentRoot.querySelectorAll("a, button")) {
      if (isInExcludedChrome?.(el)) continue;
      // Nested <a><button>Learn more</button></a> matches BOTH elements but
      // renders the phrase once — count only the outermost (review, #695).
      if (el.parentElement?.closest("a, button")) continue;
      const label = (el.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!GENERIC_CTA_LABELS.has(label)) continue;
      ctaLabelCounts.set(label, (ctaLabelCounts.get(label) || 0) + 1);
    }

    const ctaWordDeductions = new Map<string, number>();
    let ctaWordTotal = 0;
    for (const [label, occurrences] of ctaLabelCounts) {
      for (const word of keywordTokens(label)) {
        ctaWordDeductions.set(word, (ctaWordDeductions.get(word) || 0) + occurrences);
        ctaWordTotal += occurrences;
      }
    }

    // Rating and price text repeated once per card (#1315) is a UI component, not copy aimed at a
    // term. Bounded (see repeatedCardText): clamped to a share of the words, largest texts first.
    const cardDeductions = new Map<string, number>();
    {
      let left = Math.floor(words.length * CARD_MAX_SHARE);
      const texts = [...repeatedCardText(contentRoot, isInExcludedChrome)].sort((x, y) => y[1] - x[1]);
      for (const [text, occurrences] of texts) {
        const tokens = keywordTokens(text);
        if (tokens.length === 0) continue;
        const allowed = Math.min(occurrences, Math.floor(left / tokens.length));
        if (allowed <= 0) continue;
        left -= allowed * tokens.length;
        for (const word of tokens) cardDeductions.set(word, (cardDeductions.get(word) || 0) + allowed);
      }
    }
    // What of that is applied, word by word: never below the floor, never on a word that is
    // already a big share of the page. Removed words also leave the total they are measured against.
    const baseTotal = words.length - ctaWordTotal;
    const floorCount = Math.ceil((baseTotal * opts.density_threshold * CARD_FLOOR_SHARE) / 100);
    const cardApplied = new Map<string, number>();
    let cardAppliedTotal = 0;
    for (const [word, deduction] of cardDeductions) {
      const raw = wordCounts.get(word) ?? 0;
      if ((raw / words.length) * 100 >= CARD_RAW_DENSITY_LIMIT) continue;
      const applied = Math.min(deduction, Math.max(0, raw - (ctaWordDeductions.get(word) ?? 0) - floorCount));
      if (applied <= 0) continue;
      cardApplied.set(word, applied);
      cardAppliedTotal += applied;
    }

    const organicTotal = baseTotal - cardAppliedTotal;

    const suspiciousWords: { word: string; count: number; density: number }[] = [];

    // User-configured whitelist (lowercase for matching)
    const whitelist = new Set(opts.whitelist.map((w) => w.normalize("NFKC").toLowerCase()));
    // The site's own brand / product name is not a keyword it is stuffing.
    for (const term of brandTerms(ctx.page.url, doc)) whitelist.add(term);

    if (organicTotal > 0) {
      for (const [word, rawCount] of wordCounts) {
        if (
          COMMON_WORDS.has(word) ||
          pageStopWords?.has(word) ||
          (usesEnglishPriceNotes && ENGLISH_PRICE_NOTE_WORDS.has(word))
        ) {
          continue;
        }
        if (whitelist.has(word)) continue;

        const count = rawCount - (ctaWordDeductions.get(word) ?? 0) - (cardApplied.get(word) ?? 0);
        if (count <= 0) continue;

        const density = (count / organicTotal) * 100;
        if (density > opts.density_threshold && count > opts.min_occurrences) {
          suspiciousWords.push({ word, count, density });
        }
      }
    }

    // Sort by density
    suspiciousWords.sort((a, b) => b.density - a.density);

    if (suspiciousWords.length > 0) {
      checks.push({
        name: "keyword-stuffing",
        status: "warn",
        message: `${suspiciousWords.length} word(s) may be overused`,
        items: suspiciousWords.map((w) => ({
          id: w.word,
          label: `"${w.word}" (${w.density.toFixed(1)}%)`,
          meta: { count: w.count, density: w.density },
        })),
      });
    } else {
      checks.push({
        name: "keyword-stuffing",
        status: "pass",
        message: "No keyword stuffing detected",
      });
    }

    return { checks };
  },
};
