// content/h1-title-alignment - The H1 and the <title> share no meaningful word (pub#929)
//
// A page's <title> and its H1 should be about the same thing. When they share no
// content word, search engines get two topic signals for one page and a reader who
// clicked a result for one phrase lands under a heading about another.
//
// PRECISION. Measured on 115,556 stored pages: a mismatch was a real defect in about a third of
// the cases judged by hand; the rest are marketing headlines (a pitch under a descriptive title)
// and synonym pairs. So the finding is INFO, never a warning, and `details.confident` marks the
// stricter cases (a page at least two segments deep, at least three topic words each side, not a
// homepage or generic marketing page) that a future promotion to a warning would start from.
//   * Tokens are lower-cased, NFKC-normalised and diacritic-folded; pure numbers, words under
//     three letters (an all-caps pair such as AI or UX is kept), the page language's stopwords
//     and generic words (free, online, guide) are dropped. A light stemmer (plurals, -ing,
//     -ed, a silent e, a few irregulars), a long common prefix and, in German and Dutch, a
//     compound's head let `service` match `services`, `price` match `pricing` and `Schuhe`
//     match `Damenschuhe`. At most 64 words are read per side.
//   * A word shared with ANY part of the title, brand included, counts as shared.
//   * Only whitespace-delimited Latin-script languages with a stopword list are judged
//     (en, es, fr, de, pt, it, nl), and only text that is mostly Latin script. Any other
//     language, or a page with no `lang`, is skipped, never passed.
//   * Skipped: no H1, several or an empty one (core/h1), noindex pages (the runner), a title that
//     is only the brand, heading text that looks like code or whose words are glued together.
//   * The root, a localized root and generic marketing pages (/pricing, /about) are info too.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { H1_TITLE_STOPWORDS } from "./data/h1-title-stopwords";

const CHECK_NAME = "h1-title-alignment";

/** Content words each side needs before a mismatch means anything. */
const MIN_CONTENT_WORDS = 2;
/** A warning needs this many on each side; fewer is info. */
const WARN_MIN_WORDS = 3;
/** A warning needs a page at least this deep (`/blog/post`); a root, section or landing page is info. */
const WARN_MIN_DEPTH = 2;
/** A common prefix this long (and most of the shorter stem) counts as the same word. */
const MIN_PREFIX = 5;
const MAX_SHOWN = 120;

const SEGMENT_SPLIT = /\s*(?:\||»|::)\s*|\s+[-–—·•]\s+/;

function skip(message: string): RuleResult {
  return { checks: [{ name: CHECK_NAME, status: "skipped", message }] };
}

function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Words kept per side: bounds the work on a hostile 15,000-word heading (the rule timeout cannot interrupt a loop). */
const MAX_WORDS = 64;
/** Characters of the title and the H1 that are read, and of one word: bounds every later loop (the rule is synchronous). */
const MAX_TEXT_CHARS = 500;
const MAX_WORD_CHARS = 40;

/** Words that alone say nothing about a topic: sharing only these is not a match. Per language. */
const GENERIC_WORDS: Record<string, ReadonlySet<string>> = {
  en: new Set("free online best new guide tool tools top official home page site website app service services solution solutions about contact pricing features feature blog news faq support help".split(" ")),
  es: new Set("gratis online mejor nuevo guia herramienta oficial inicio pagina sitio servicio servicios sobre contacto precios blog noticias ayuda".split(" ")),
  fr: new Set("gratuit gratuite en ligne meilleur nouveau nouvelle guide outil officiel accueil site service services apropos contact tarifs blog actualites aide".split(" ")),
  de: new Set("kostenlos online beste neu neue anleitung ratgeber werkzeug offiziell startseite seite service ueber kontakt preise blog neuigkeiten hilfe".split(" ")),
  pt: new Set("gratis online melhor novo guia ferramenta oficial inicio pagina site servico servicos sobre contato precos blog ajuda".split(" ")),
  it: new Set("gratis online migliore nuovo guida strumento ufficiale home pagina sito servizio servizi contatti prezzi blog aiuto".split(" ")),
  nl: new Set("gratis online beste nieuw gids hulpmiddel officieel home pagina site dienst diensten contact prijzen blog hulp".split(" ")),
};

interface Word {
  stem: string;
  /** One part of a camel-case word: matches, but does not count toward the word totals. */
  part?: true;
  /** A word that alone says nothing about the topic (free, online, guide). */
  generic: boolean;
}

/**
 * Content words of a text: apostrophes dropped inside a word, then split on anything that
 * is not a letter or digit. Pure numbers, stopwords and words under three letters are
 * dropped, except an all-caps pair (AI, UX, EA), which is usually an acronym that names the
 * subject. At most MAX_WORDS are kept.
 */
function contentWords(text: string, lang: string, stop: ReadonlySet<string>): Word[] {
  const generic = GENERIC_WORDS[lang];
  const out: Word[] = [];
  const raw = text.normalize("NFKC").replace(/['\u2019`]s\b/gi, "").replace(/['\u2019`]/g, "");
  for (const longPiece of raw.split(/[^\p{L}\p{N}]+/u)) {
    if (longPiece.length === 0) continue;
    const piece = longPiece.length > MAX_WORD_CHARS ? longPiece.slice(0, MAX_WORD_CHARS) : longPiece;
    const t = fold(piece);
    if (/^\p{N}+$/u.test(t) || stop.has(t)) continue;
    if (t.length < 3 && !(t.length === 2 && /^\p{Lu}{2}$/u.test(piece))) continue;
    out.push({ stem: stem(t, lang), generic: generic?.has(t) === true });
    // A camel-case word (`CustomerSuccess`) also offers its parts, so `success` can match.
    const parts = camelParts(piece);
    if (parts.length > 1) {
      for (const part of parts) {
        const f = fold(part);
        if (f.length >= 3 && !stop.has(f) && !/^\p{N}+$/u.test(f)) {
          out.push({ stem: stem(f, lang), generic: generic?.has(f) === true, part: true });
        }
      }
    }
    if (out.length >= MAX_WORDS) break;
  }
  return out.slice(0, MAX_WORDS);
}

const DOUBLED = /([bcdfgklmnprstvz])\1$/;
const EN_IRREGULAR: Record<string, string> = {
  women: "woman",
  men: "man",
  children: "child",
  people: "person",
  feet: "foot",
  teeth: "tooth",
  mice: "mouse",
};

/** A light, language-aware stem: plurals, -ing, -ed, a silent final e. Deliberately simple. */
export function stem(word: string, lang: string): string {
  let w = word;
  if (lang === "en") {
    const irregular = EN_IRREGULAR[w];
    if (irregular) return irregular;
    if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    let ing = false;
    if (w.length > 5 && w.endsWith("ing")) {
      const base = w.slice(0, -3);
      const undoubled = base.replace(DOUBLED, "$1");
      w = undoubled;
      // `making` -> `mak` -> `make`: a short consonant-vowel-consonant stem lost its silent e.
      ing = undoubled === base && /^[^aeiou]*[aeiouy][^aeiouwxy]$/.test(w);
    } else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2).replace(DOUBLED, "$1");
    else if (w.length > 3 && w.endsWith("es") && /(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (ing) w += "e";
    // A silent final e on a longer word, so service and services meet.
    if (w.length > 5 && w.endsWith("e")) w = w.slice(0, -1);
    return w;
  }
  if (lang === "de" || lang === "nl") {
    for (const suffix of ["en", "e", "n", "s"]) {
      if (w.length > suffix.length + 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
    }
    return w;
  }
  // es, fr, pt, it: plural -s / -es / -i / -e
  for (const suffix of ["es", "s", "i", "e"]) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  }
  return w;
}

/**
 * Whether two stems are the same word: equal, or a shared prefix of at least MIN_PREFIX
 * letters covering at least 80% of the shorter stem, or, in the compounding languages
 * (German, Dutch), one stem of at least MIN_PREFIX letters sitting inside the other
 * (Damenschuhe contains Schuhe).
 */
function sameWord(a: string, b: string, lang: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < MIN_PREFIX) return false;
  let i = 0;
  while (i < shorter && a[i] === b[i]) i++;
  if (i >= MIN_PREFIX && i >= Math.ceil(shorter * 0.8)) return true;
  if (lang === "de" || lang === "nl") {
    const [small, large] = a.length <= b.length ? [a, b] : [b, a];
    return large.includes(small);
  }
  return false;
}

/** Share of the letters of `text` that are Latin script. */
function latinShare(text: string): number {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return 1;
  let latin = 0;
  for (const l of letters) if (/\p{Script=Latin}/u.test(l)) latin++;
  return latin / letters.length;
}

/**
 * A word of the H1 that starts in lower case and has a lower-to-upper hump (`voorBedrijven`,
 * `forFree`), splits off a stopword of the page language, and that the title does not carry
 * as written: heading markup whose pieces were glued together (`<br>` or `<span>` with no
 * space), so its words cannot be read. Titles are plain text and are not checked. A
 * capitalised word (`YouTube`, `OwnJournal`) is a brand, not a glue, and so is one the title
 * carries as written. Runs on text already clipped to MAX_TEXT_CHARS.
 */
function looksGlued(h1: string, title: string, stop: ReadonlySet<string>): boolean {
  for (const m of h1.normalize("NFKC").matchAll(/(?<!\p{L})\p{Ll}\p{L}*\p{Ll}\p{Lu}\p{L}*/gu)) {
    if (title.includes(m[0])) continue;
    for (const part of camelParts(m[0])) {
      if (part.length >= 3 && stop.has(fold(part))) return true;
    }
  }
  return false;
}

/** `TrustedWhen` -> `Trusted`, `When`; a word without a hump -> itself. */
function camelParts(token: string): string[] {
  return token.split(/(?<=\p{Ll})(?=\p{Lu})/u);
}

function primaryLang(lang: string | null | undefined): string {
  const m = /^\s*([a-zA-Z]{2,3})(?:[-_]|\s*$)/.exec(lang ?? "");
  return m ? (m[1] as string).toLowerCase() : "";
}

/** The site's own name as letters only: og:site_name and the host's registrable label. */
function brandForms(ctx: RuleContext): string[] {
  const forms = new Set<string>();
  const siteName = ctx.parsed.og?.siteName;
  if (siteName) forms.add(fold(siteName).replace(/[^\p{L}\p{N}]+/gu, ""));
  try {
    const host = new URL(ctx.page.url).hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".");
    // `shop.brand.co.uk` -> `brand`; `brand.com` -> `brand`.
    const secondLevel = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
    let i = labels.length - 2;
    if (i > 0 && secondLevel.has(labels[i] as string) && (labels[labels.length - 1] as string).length === 2) i--;
    const label = labels[Math.max(i, 0)] ?? "";
    if (label.length >= 3) forms.add(label.replace(/[^\p{L}\p{N}]+/gu, ""));
  } catch {
    // an unparseable URL has no host brand
  }
  forms.delete("");
  return [...forms];
}

function namesBrand(segment: string, brands: string[]): boolean {
  const letters = fold(segment).replace(/[^\p{L}\p{N}]+/gu, "");
  return letters.length > 0 && brands.some((b) => letters.includes(b) || (letters.length >= 3 && b.includes(letters)));
}

/** Paths of generic marketing pages, whose headline is a pitch rather than a restatement of the title. */
const MARKETING_SEGMENTS = new Set(
  (
    "about about-us features feature pricing price prices plans contact contact-us faq faqs services company team our-team support help " +
    "kontakt ueber-uns uber-uns preise hilfe funktionen leistungen unternehmen " +
    "tarifs tarif a-propos fonctionnalites aide " +
    "precios contacto nosotros sobre-nosotros ayuda servicios caracteristicas " +
    "precos contato sobre ajuda servicos " +
    "prezzi contatti chi-siamo aiuto servizi " +
    "prijzen over-ons hulp diensten"
  ).split(" "),
);

/**
 * `home` for the root, a localized root (`/de/`, `/pt-br/`) or an index file, `marketing`
 * for a generic marketing page (`/pricing`, `/en/about`), else null. Both are info: a
 * creative headline there is deliberate.
 */
function pageKind(url: string): "home" | "marketing" | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  path = path.replace(/\/index\.(?:html?|php|aspx?)$/, "/");
  if (path === "" || path === "/" || /^\/[a-z]{2}(?:[-_][a-z]{2,4})?\/?$/.test(path)) return "home";
  const local = path.replace(/^\/[a-z]{2}(?:[-_][a-z]{2,4})?(?=\/)/, "").replace(/\/$/, "");
  const segments = local.split("/").filter((x) => x.length > 0);
  if (segments.length === 1 && MARKETING_SEGMENTS.has(segments[0] as string)) return "marketing";
  return null;
}

/** Whole content words that carry a topic: camel parts and generic words (free, online, guide) left out. */
function topicWords(words: Word[]): number {
  return words.filter((w) => !w.part && !w.generic).length;
}

/** Path segments below the locale prefix: 0 for a root, 1 for `/pricing`, 2 for `/blog/post`. */
function pathDepth(url: string): number {
  try {
    const path = new URL(url).pathname.toLowerCase().replace(/^\/[a-z]{2}(?:[-_][a-z]{2,4})?(?=\/)/, "");
    return path.split("/").filter((x) => x.length > 0).length;
  } catch {
    return 0;
  }
}

/** Whitespace-delimited words, for the length of a brand segment. */
function wordCount(text: string): number {
  return text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).length;
}

function clip(text: string): string {
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;
}

export const h1TitleAlignmentRule: Rule = {
  meta: {
    id: "content/h1-title-alignment",
    name: "H1 and Title Alignment",
    description: "Checks that a page's H1 and <title> share at least one meaningful word",
    solution:
      "The <title> and the H1 should be about the same topic: they are the two strongest signals of what the page is for. When they share no meaningful word, search engines see two different subjects, and a visitor who clicked a result for the title's phrase lands under a heading about something else. Reword the H1 to include the phrase the title targets (it can be longer and more natural than the title), or change the title to name what the H1 promises. A deliberately creative headline, common on a homepage or a landing page, is fine: this rule only informs.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    // Search-result presentation only: skipped on noindex pages (pub#457).
    skipOnNoindex: true,
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const { h1 } = ctx.parsed;
    // Clipped before anything else runs: a hostile 100,000-letter token must not reach a loop.
    const title = (ctx.parsed.meta.title ?? "").slice(0, MAX_TEXT_CHARS * 4).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);

    // core/h1 owns a missing, repeated or empty H1; core/meta-title owns a missing title.
    if (h1.count !== 1) return skip(`${h1.count === 0 ? "No" : "Several"} H1: reported by core/h1`);
    const h1Text = (h1.texts[0] ?? "").slice(0, MAX_TEXT_CHARS * 4).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
    if (h1Text.length === 0) return skip("Empty H1: reported by core/h1");
    if (title.length === 0) return skip("No title: reported by core/meta-title");

    const lang = primaryLang(ctx.parsed.document?.documentElement?.getAttribute("lang"));
    const stop = H1_TITLE_STOPWORDS.get(lang);
    if (!stop) {
      return skip(
        lang === ""
          ? "No page language declared, so no stopword list to read the words with"
          : `No stopword list for language "${lang}"`,
      );
    }

    // Stylesheet or script text scraped into the heading (a parser-side issue), not a heading.
    if (/[{}]|@keyframes|@media/.test(h1Text)) return skip("The H1 text looks like code, not a heading");

    // A Latin stopword list cannot read a title or heading that is mostly another script.
    if (latinShare(title) < 0.6 || latinShare(h1Text) < 0.6) {
      return skip("The title or the H1 is mostly non-Latin text, which the stopword list cannot read");
    }
    // Heading markup whose pieces ran together has no readable words (a parser-side issue).
    if (looksGlued(h1Text, title, stop)) {
      return skip("The H1 looks run together (words glued without a space), so its words cannot be read");
    }

    const brands = brandForms(ctx);
    const segments = title.split(SEGMENT_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
    const h1Words = contentWords(h1Text, lang, stop);

    // Which segments are the brand affix: one that names the site, or, in a title with
    // more than one segment, a short first or last segment.
    const brandIdx = new Set<number>();
    segments.forEach((seg, i) => {
      if (namesBrand(seg, brands)) brandIdx.add(i);
    });
    if (segments.length > 1 && brandIdx.size === 0) {
      // The brand usually trails ("Page | Brand"); a leading one ("Brand | Page") is the fallback.
      for (const i of [segments.length - 1, 0]) {
        if (wordCount(segments[i] as string) <= 3) {
          brandIdx.add(i);
          break;
        }
      }
    }
    const nonBrand = segments.filter((_, i) => !brandIdx.has(i));
    if (nonBrand.length === 0) return skip("The title is only the brand");

    const titleWordsAll = contentWords(title, lang, stop);
    const titleWords = contentWords(nonBrand.join(" "), lang, stop);

    // Exact stems first (a Set lookup), then the fuzzy pairs; at most MAX_WORDS per side.
    const titleExact = new Set(titleWordsAll.filter((w) => !w.generic).map((w) => w.stem));
    const shared = h1Words.some(
      (h) => !h.generic && (titleExact.has(h.stem) || titleWordsAll.some((t) => !t.generic && sameWord(h.stem, t.stem, lang))),
    );
    if (shared) {
      // Identical, character for character, on a page whose title carries more than the brand.
      if (h1Text === title && topicWords(titleWords) > 0) {
        return {
          checks: [
            {
              name: CHECK_NAME,
              status: "info",
              message: "The H1 and the title are identical: the title could target a second phrase",
              value: clip(title),
              details: { title: clip(title), h1: clip(h1Text) },
            },
          ],
        };
      }
      return {
        checks: [{ name: CHECK_NAME, status: "pass", message: "The H1 and the title share a meaningful word" }],
      };
    }

    // No shared word. Judge only when both sides have enough content words to mean it.
    const titleCount = topicWords(titleWords);
    const h1Count = topicWords(h1Words);
    if (titleCount < MIN_CONTENT_WORDS || h1Count < MIN_CONTENT_WORDS) {
      return skip("Too few content words in the title or the H1 to compare");
    }

    const kind = pageKind(ctx.page.url);
    const confident =
      !kind && pathDepth(ctx.page.url) >= WARN_MIN_DEPTH && titleCount >= WARN_MIN_WORDS && h1Count >= WARN_MIN_WORDS;
    const check: CheckResult = {
      name: CHECK_NAME,
      // Info only: on 115,000 stored pages the mismatch was a real defect in about a third of the
      // cases judged by hand (the rest are marketing headlines), too low for a default warning.
      // `confident` marks the pages the stricter test would have warned on.
      status: "info",
      message: "The H1 and the title share no meaningful word",
      value: clip(h1Text),
      expected: "At least one content word in common with the title",
      items: [
        { id: `title: ${clip(title)}` },
        { id: `h1: ${clip(h1Text)}` },
      ],
      details: { title: clip(title), h1: clip(h1Text), language: lang, confident, ...(kind ? { pageKind: kind } : {}) },
    };
    return { checks: [check] };
  },
};
