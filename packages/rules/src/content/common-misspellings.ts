// content/common-misspellings - Known misspellings and doubled words on English pages.
//
// A lookup, not a spellchecker: each word is compared with a bundled map of
// common misspellings to their correction, exact and case-insensitive, with no
// edit distance. The map, data/common-misspellings-data.ts, is written by hand
// for squirrelscan (MIT, like the rest of this package; see data/README.md),
// checked by scripts/check-common-misspellings.ts and parsed on first use.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { z } from "zod";

import { getRenderedProseTextWhere } from "./text-content";

// One plain string, not a JSON import: it loads the same in every runtime that
// imports the rules (no import attribute or JSON loader), and the compiled binary
// embeds it at about its own size, where a JSON import becomes one export per key.
import { COMMON_MISSPELLINGS } from "./data/common-misspellings-data";

/** Findings listed per audit, worst first by page count. */
const MAX_FINDINGS = 50;
/** Pages named under each finding, with a context snippet. */
const MAX_EXAMPLES = 5;
/** Characters of context either side of a match. */
const CONTEXT_CHARS = 40;

/**
 * Words that are grammatical when repeated only if they are not in this list:
 * "had had" and "that that" stay out, "the the" and "to to" are typos. "as",
 * "at", "in", "is", "it" and "on" are left out too: "what it is is", "log in in
 * seconds", "turn it on on startup", "look at at least two".
 */
const DOUBLED_FUNCTION_WORDS = new Set([
  "a",
  "an",
  "and",
  "be",
  "by",
  "for",
  "from",
  "of",
  "or",
  "the",
  "to",
  "with",
]);

export const optionsSchema = z.object({
  ignore_words: z
    .array(z.string())
    .default([])
    .describe(
      "Misspellings never reported, matched case-insensitively (for example a brand spelling). Doubled words are not affected",
    ),
});

/** Primary language subtag of a BCP 47 tag, lowercased; "" when absent. */
function primaryLanguage(tag: string | null | undefined): string {
  return (tag ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/** True when the element states its own language and that language is not English. */
function isOwnNonEnglish(el: Element): boolean {
  const lang = el.getAttribute?.("lang");
  if (lang === null || lang === undefined || lang.trim() === "") return false;
  return primaryLanguage(lang) !== "en";
}

/** Marked-up regions a reader is not meant to have checked as English prose. */
function isOwnExcluded(el: Element): boolean {
  return (
    el.getAttribute?.("translate") === "no" ||
    el.getAttribute?.("spellcheck") === "false" ||
    isOwnNonEnglish(el)
  );
}

/** True when the element or any ancestor is excluded. */
function isExcludedSubtree(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (isOwnExcluded(node)) return true;
  }
  return false;
}

/**
 * A whitespace-separated token that is a URL or an email address, whose letters
 * must never be read as words. Judged per token, never by a regex over the whole
 * text: `\S+@\S+` backtracks quadratically on one long unbroken run (80k
 * characters took 11 s), and the rule time budget cannot interrupt a regex.
 */
const URL_START = /(?:^|[^A-Za-z0-9])(?:https?:\/\/|www\.)/i;
function isUrlOrEmail(token: string): boolean {
  return token.includes("@") || URL_START.test(token);
}
/** Blank out URL and email tokens, keeping every other character in place. */
function blankNonWords(text: string): string {
  return text.replace(/\S+/g, (token) => (isUrlOrEmail(token) ? " ".repeat(token.length) : token));
}
const WORD = /[A-Za-z]+/g;
/** A letter run touching one of these is part of an identifier, not a word. */
const IDENTIFIER_NEIGHBOUR = /[0-9_\-/@#]/;

interface Token {
  word: string;
  index: number;
  /** Starts a sentence, a block or a title/heading, where capitals are expected. */
  sentenceStart: boolean;
  capitalised: boolean;
}

/**
 * Words in `text` the rule is allowed to judge, in order. Skipped: anything with
 * digits or underscores, mixed case, ALL CAPS, and a capitalised word that does
 * not open a sentence (likely a name or a brand). `capitalsOk` marks text where
 * every word is capitalised by convention (titles and headings). A generator, so
 * a scan that stops at its cap does no more work.
 * @yields {Token} Each judged word with its offset in `text`.
 */
function* tokenize(text: string, capitalsOk: boolean): Generator<Token> {
  const cleaned = blankNonWords(text);
  for (const match of cleaned.matchAll(WORD)) {
    const word = match[0];
    const index = match.index ?? 0;
    const before = index > 0 ? cleaned[index - 1]! : "";
    const after = cleaned[index + word.length] ?? "";
    if (IDENTIFIER_NEIGHBOUR.test(before) || IDENTIFIER_NEIGHBOUR.test(after)) continue;
    if (word.length > 1 && word === word.toUpperCase()) continue;
    if (/[A-Z]/.test(word.slice(1))) continue;
    const capitalised = word[0] === word[0]!.toUpperCase() && word[0] !== word[0]!.toLowerCase();
    const sentenceStart = capitalsOk || startsSentence(cleaned, index);
    if (capitalised && !sentenceStart) continue;
    yield { word, index, sentenceStart, capitalised };
  }
}

/**
 * True when the last non-space character before `index` ends a sentence or opens a
 * block. An opening bracket does not: "(Sargent 1884)" is a name, not a sentence.
 */
function startsSentence(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === " " || c === "\t") continue;
    return c === "\n" || '.!?:"“'.includes(c);
  }
  return true;
}

const NAME_LIKE = /^[A-Z][a-z]+$/;

/**
 * Words `text` capitalises mid-sentence: names and brands ("the actor Kelsey
 * Grammer"). Titles, headings and sentence starts capitalise words anyway, so a
 * word the page's body treats as a name is not judged there either.
 */
function namesIn(text: string): Set<string> {
  const cleaned = blankNonWords(text);
  const names = new Set<string>();
  for (const match of cleaned.matchAll(WORD)) {
    const word = match[0];
    if (NAME_LIKE.test(word) && !startsSentence(cleaned, match.index ?? 0)) {
      names.add(word.toLowerCase());
    }
  }
  return names;
}

/** One misspelled or doubled word found on a page, with the text around it. */
export interface MisspellingOccurrence {
  kind: "misspelling" | "doubled";
  /** Lowercase word; for a doubled word, the word repeated ("the the"). */
  word: string;
  correction?: string;
  /** Title, description or heading: visible in search results or at the top of the page. */
  prominent: boolean;
  context: string;
}

/**
 * What the page-time scan records for one page: whether the page is English, and
 * its occurrences. Bounded per page, so a streamed crawl holds these instead of
 * every parsed DOM.
 */
export interface PageMisspellings {
  english: boolean;
  occurrences: MisspellingOccurrence[];
}

/**
 * Distinct words kept per page, each counted once however often it repeats. The
 * title, description and headings share one quota and the body has its own, so a
 * page full of misspelt headings cannot crowd out its body copy. A page past
 * these is the outlier, not the finding.
 */
const MAX_PROMINENT_PER_PAGE = 25;
const MAX_BODY_PER_PAGE = 25;
const HEADING_TAG = /^h[1-6]$/i;
/**
 * Interface text that repeats a title in Title Case (breadcrumbs, links, buttons,
 * menus). It is not prose, so it never marks a word as a name.
 */
const UI_TAG = /^(a|button|label|nav|option|select|summary)$/i;
function isInterfaceText(el: Element): boolean {
  if (UI_TAG.test(el.tagName)) return true;
  if (el.getAttribute?.("role") === "navigation") return true;
  return /breadcrumb/i.test(
    `${el.getAttribute?.("aria-label") ?? ""} ${el.getAttribute?.("class") ?? ""}`,
  );
}

const NO_PAGE: PageMisspellings = { english: false, occurrences: [] };

function contextAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + CONTEXT_CHARS);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** One page's occurrences: each kind and word once, under the quota of the text it is in. */
interface PageScan {
  table: ReadonlyMap<string, string>;
  /** Words the body capitalises mid-sentence ({@link namesIn}). */
  names: ReadonlySet<string>;
  occurrences: MisspellingOccurrence[];
  seen: Set<string>;
}

/** A quota of distinct words still to record; a scan stops when it reaches zero. */
interface Quota {
  left: number;
}

/** Record `occ` unless its kind and word are already recorded; false once `quota` is spent. */
function record(scan: PageScan, quota: Quota, occ: MisspellingOccurrence): boolean {
  const key = `${occ.kind}:${occ.word}`;
  if (!scan.seen.has(key)) {
    scan.seen.add(key);
    scan.occurrences.push(occ);
    quota.left--;
  }
  return quota.left > 0;
}

/** Scan one block of text into `scan`, stopping as soon as `quota` is spent. */
function scanText(
  text: string,
  prominent: boolean,
  capitalsOk: boolean,
  scan: PageScan,
  quota: Quota,
): void {
  if (quota.left <= 0 || text === "") return;
  let previous: { lower: string; token: Token } | null = null;
  for (const token of tokenize(text, capitalsOk)) {
    const lower = token.word.toLowerCase();
    // A capitalised word the body uses elsewhere as a name is not a typo: in a
    // title or heading, or opening a sentence or a caption ("Grammer in 2026").
    const name = token.capitalised && scan.names.has(lower);
    const correction = name ? undefined : scan.table.get(lower);
    if (
      correction &&
      !record(scan, quota, {
        kind: "misspelling",
        word: lower,
        correction,
        prominent,
        context: contextAt(text, token.index, token.word.length),
      })
    ) {
      return;
    }
    if (
      previous &&
      previous.lower === lower &&
      DOUBLED_FUNCTION_WORDS.has(lower) &&
      /^[ \t]+$/.test(text.slice(previous.token.index + previous.token.word.length, token.index))
    ) {
      const start = previous.token.index;
      const doubled = record(scan, quota, {
        kind: "doubled",
        word: `${lower} ${lower}`,
        prominent: false,
        context: contextAt(text, start, token.index + token.word.length - start),
      });
      if (!doubled) return;
    }
    previous = { lower, token };
  }
}

/**
 * The bundled map, parsed synchronously the first time an English page is
 * scanned (the streamed collector runs mid-crawl). An audit with no English page
 * never parses it; the string is embedded either way.
 */
let table: ReadonlyMap<string, string> | null = null;
function getTable(): ReadonlyMap<string, string> {
  if (!table) {
    const map = new Map<string, string>();
    for (const line of COMMON_MISSPELLINGS.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) map.set(line.slice(0, space), line.slice(space + 1));
    }
    table = map;
  }
  return table;
}

/**
 * The page-time scan: run once per page while its DOM is live (collected-signals)
 * or over the stored DOM in the legacy site pass. Both paths call this, so they
 * cannot disagree.
 */
export function scanPageForMisspellings(doc: Document | null): PageMisspellings {
  if (!doc || primaryLanguage(doc.documentElement?.getAttribute("lang")) !== "en") return NO_PAGE;
  // Headings get their own pass and quota below, so the body copy leaves them out:
  // a heading past that quota never spends the body's.
  const body = doc.querySelector("body");
  const notBodyCopy = (el: Element) => isOwnExcluded(el) || HEADING_TAG.test(el.tagName);
  const bodyText = body ? getRenderedProseTextWhere(body, notBodyCopy) : "";
  // Names come from prose only: a breadcrumb or link echoing a misspelt title
  // ("Home > Accomodation") must not excuse the title.
  const proseText = body
    ? getRenderedProseTextWhere(body, (el) => notBodyCopy(el) || isInterfaceText(el))
    : "";
  const scan: PageScan = {
    table: getTable(),
    names: namesIn(proseText),
    occurrences: [],
    seen: new Set(),
  };

  const prominent: Quota = { left: MAX_PROMINENT_PER_PAGE };
  // A <title lang="fr"> (or translate="no") is not English copy either.
  const titleEl = doc.querySelector("title");
  const title = titleEl && !isOwnExcluded(titleEl) ? (titleEl.textContent ?? "") : "";
  scanText(title, true, true, scan, prominent);
  scanText(metaDescription(doc), true, false, scan, prominent);
  for (const heading of doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (prominent.left <= 0) break;
    if (isExcludedSubtree(heading)) continue;
    // Read like body copy: <code>, <kbd> or a foreign <span lang> inside a heading is skipped.
    scanText(getRenderedProseTextWhere(heading, isOwnExcluded), true, true, scan, prominent);
  }

  scanText(bodyText, false, false, scan, { left: MAX_BODY_PER_PAGE });
  return { english: true, occurrences: scan.occurrences };
}

function metaDescription(doc: Document): string {
  return doc.querySelector('meta[name="description" i]')?.getAttribute("content") ?? "";
}

interface Finding {
  kind: "misspelling" | "doubled";
  word: string;
  correction?: string;
  pages: Set<string>;
  examples: Array<{ url: string; context: string }>;
  prominent: boolean;
}

function summarise(f: Finding): CheckResult {
  const pageCount = f.pages.size;
  const plural = pageCount === 1 ? "page" : "pages";
  const label =
    f.kind === "misspelling" ? `"${f.word}" → "${f.correction}"` : `doubled word "${f.word}"`;
  return {
    name: `${f.kind === "misspelling" ? "misspelling" : "doubled-word"}:${f.word}`,
    status: f.kind === "misspelling" && f.prominent ? "warn" : "info",
    message: `${label} on ${pageCount} ${plural}`,
    value: pageCount,
    items: f.examples.map((e) => ({ id: e.url, label: e.url, snippet: e.context })),
    details: { pageCount, correction: f.correction },
  };
}

/** Site-level aggregation shared by both paths: one finding per word, with its pages. */
function aggregate(
  pages: ReadonlyArray<{ url: string; scan: PageMisspellings }>,
  ignored: ReadonlySet<string>,
): Finding[] {
  const findings = new Map<string, Finding>();
  for (const { url, scan } of pages) {
    if (!scan.english) continue;
    for (const occ of scan.occurrences) {
      if (occ.kind === "misspelling" && ignored.has(occ.word)) continue;
      const key = `${occ.kind}:${occ.word}`;
      let finding = findings.get(key);
      if (!finding) {
        finding = {
          kind: occ.kind,
          word: occ.word,
          correction: occ.correction,
          pages: new Set(),
          examples: [],
          prominent: false,
        };
        findings.set(key, finding);
      }
      finding.pages.add(url);
      finding.prominent ||= occ.prominent;
      if (finding.examples.length < MAX_EXAMPLES && !finding.examples.some((e) => e.url === url)) {
        finding.examples.push({ url, context: occ.context });
      }
    }
  }
  return [...findings.values()].sort(
    (a, b) => b.pages.size - a.pages.size || a.word.localeCompare(b.word),
  );
}

export const commonMisspellingsRule: Rule = {
  meta: {
    id: "content/common-misspellings",
    name: "Common Misspellings",
    description: "Finds known misspellings and doubled words in the visible English text of a site",
    solution:
      "Each finding names a misspelled word, its correction, the number of pages it appears on and an example with its context. Fix the copy where it was written, and check the template or CMS field if it appears on many pages. Misspellings in the title, description or a heading are visible in search results or at the top of the page, so they are reported as warnings.",
    category: "content",
    scope: "site",
    // A misspelt title, description or heading warns, and the report shows a
    // warn check at the rule's severity. Body-text and doubled-word findings stay info.
    severity: "warning",
    weight: 3,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const ignored = new Set(opts.ignore_words.map((w) => w.toLowerCase()));

    // Streamed audits carry the page-time scan; the legacy pass re-scans the DOM.
    let pages: Array<{ url: string; scan: PageMisspellings }>;
    if (ctx.collectedSignals) {
      pages = ctx.collectedSignals.pages.map((s) => ({
        url: s.url,
        scan: s.misspellings ?? NO_PAGE,
      }));
    } else {
      pages = (ctx.site?.pages ?? []).map((p) => ({
        url: p.url,
        scan: scanPageForMisspellings(p.parsed?.document ?? null),
      }));
    }

    if (pages.length === 0) {
      return {
        checks: [
          {
            name: "common-misspellings",
            status: "skipped",
            message: "No crawled pages to check for misspellings",
          },
        ],
      };
    }

    const ranked = aggregate(pages, ignored);
    const checks: CheckResult[] = ranked.slice(0, MAX_FINDINGS).map(summarise);
    // The cap keeps the worst first; say how many more there were.
    if (ranked.length > MAX_FINDINGS) {
      checks.push({
        name: "common-misspellings-truncated",
        status: "info",
        message: `${ranked.length - MAX_FINDINGS} more misspelled or doubled word(s) not listed: the ${MAX_FINDINGS} on the most pages are`,
        value: ranked.length - MAX_FINDINGS,
        details: { total: ranked.length, listed: MAX_FINDINGS },
      });
    }
    if (ranked.length === 0) {
      checks.push({
        name: "common-misspellings",
        status: "pass",
        message: "No known misspellings or doubled words on English pages",
      });
    }
    return { checks };
  },
};
