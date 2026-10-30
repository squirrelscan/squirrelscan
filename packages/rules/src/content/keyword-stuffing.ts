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

const MENU_NAME = /(?:^|[-_\s])(?:menu|nav|navigation|dropdown|mega|flyout|submenu|megamenu)(?:$|[-_\s])/i;

/**
 * A block of links is a menu when it is a list of links (`ul`/`ol` with `li` items, or inside one) or
 * when it, or a wrapper up to three levels above it, is named or roled as one. A bare `div` of anchors
 * with no such signal is a link cloud and keeps counting (a keyword spammer's favourite shape).
 */
function hasMenuSignal(element: Element, body: Element): boolean {
  if (element.querySelector("ul > li, ol > li")) return true;
  let current: Element | null = element;
  for (let depth = 0; current && current !== body && depth < 4; depth++, current = current.parentElement) {
    const tag = current.tagName?.toLowerCase();
    if (tag === "ul" || tag === "ol" || tag === "li") return true;
    const role = current.getAttribute?.("role")?.toLowerCase();
    if (role && /^(?:menu|menubar|navigation|tablist)$/.test(role)) return true;
    const name = `${current.getAttribute?.("class") ?? ""} ${current.getAttribute?.("id") ?? ""}`;
    if (MENU_NAME.test(name)) return true;
  }
  return false;
}

/**
 * Blocks that are mostly link text: a mega menu or footer columns built from plain
 * `div`s, which the landmark test cannot see (#1315). Their link labels are site
 * navigation repeated on every page, not copy. Only used when the page has no main
 * copy of its own to measure. Requires several DIFFERENT labels and a menu signal (a list
 * of links, or menu/nav naming, see {@link hasMenuSignal}), so a block that repeats one
 * anchor ("emergency plumber" x20), or a bare cloud of keyword links, still counts.
 */
function createLinkListTest(body: Element): (element: Element) => boolean {
  type Stats = { links: number; chars: number; labels: Set<string> };
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
        entry = { links: 0, chars: 0, labels: new Set() };
        stats.set(current, entry);
      }
      entry.links += 1;
      entry.chars += label.replace(/\s/g, "").length;
      if (entry.labels.size < LINK_LIST_MIN_LABELS) entry.labels.add(label);
    }
  }
  const lists = new WeakSet<Element>();
  for (const [element, entry] of stats) {
    if (entry.links < LINK_LIST_MIN_LINKS || entry.labels.size < LINK_LIST_MIN_LABELS) continue;
    const textChars = (element.textContent || "").replace(/\s/g, "").length;
    if (textChars > 0 && entry.chars >= textChars * LINK_LIST_TEXT_SHARE && hasMenuSignal(element, body)) lists.add(element);
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
/** Candidate card texts kept per page, and the elements looked at to find them. */
const CARD_MAX_ELEMENTS = 4000;
const CARD_MAX_SCANNED = 40_000;

/**
 * Short texts repeated once per card (#1315): `text -> occurrences` for every text
 * (digits replaced) that is the whole text of a block with no element children in at
 * least {@link CARD_MIN_PARENTS} different parent elements.
 */
function repeatedCardText(root: Element, excluded: ((element: Element) => boolean) | null): Map<string, number> {
  const byText = new Map<string, { count: number; parents: Set<Element> }>();
  let scanned = 0;
  let candidates = 0;
  for (const el of root.querySelectorAll(CARD_TEXT_SELECTOR)) {
    // Two bounds: the elements looked at, and the candidate cards kept (a card is ~9 elements deep).
    if (++scanned > CARD_MAX_SCANNED || candidates >= CARD_MAX_ELEMENTS) break;
    if (el.children.length > 0) continue;
    if (excluded?.(el)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 8 || text.length > CARD_TEXT_MAX_CHARS) continue;
    // A card has other things in it (title, price, rating): a text that is the WHOLE text of its
    // wrapper is a block of copy on its own, however often it repeats.
    const parent = el.parentElement;
    if (!parent || (parent.textContent || "").replace(/\s+/g, " ").trim() === text) continue;
    candidates += 1;
    const key = text.toLowerCase().replace(/\d+([.,]\d+)*/g, "#");
    let entry = byText.get(key);
    if (!entry) {
      entry = { count: 0, parents: new Set() };
      byText.set(key, entry);
    }
    entry.count += 1;
    if (el.parentElement) entry.parents.add(el.parentElement);
  }
  const out = new Map<string, number>();
  for (const [text, entry] of byText) {
    if (entry.parents.size >= CARD_MIN_PARENTS) out.set(text, entry.count);
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

    // Text repeated once per card in a grid (a rating sentence, an installment note) is a
    // UI component, not copy aimed at a term (#1315). A leaf block counts as one only
    // when the same text (digits ignored) sits in at least three different parent
    // wrappers: the card pattern. The same sentence written again and again in one
    // container is body copy and still counts.
    for (const [text, occurrences] of repeatedCardText(contentRoot, isInExcludedChrome)) {
      for (const word of keywordTokens(text)) {
        ctaWordDeductions.set(word, (ctaWordDeductions.get(word) || 0) + occurrences);
        ctaWordTotal += occurrences;
      }
    }

    const organicTotal = words.length - ctaWordTotal;

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

        const count = rawCount - (ctaWordDeductions.get(word) ?? 0);
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
