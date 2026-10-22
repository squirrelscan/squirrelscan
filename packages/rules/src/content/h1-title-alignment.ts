// content/h1-title-alignment - The H1 and the <title> share no meaningful word (pub#929)
//
// A page's <title> and its H1 should be about the same thing. When they share no
// content word, search engines get two topic signals for one page and a reader who
// clicked a result for one phrase lands under a heading about another.
//
// FALSE-POSITIVE DESIGN. Everything below leans toward saying nothing:
//   * Tokens are lower-cased, Unicode-normalised (NFKC) and diacritic-folded; pure
//     numbers, tokens under three letters and the page language's stopwords are dropped, and a
//     light stemmer (plus a long common prefix) lets `service` match `services` and
//     `running` match `run`.
//   * A word shared with ANY part of the title, brand included, counts as shared. The
//     brand affix only matters for the other test: the title must keep at least two
//     content words once it is stripped (a segment that names the site, or a short
//     trailing or leading segment, is the brand).
//   * Only whitespace-delimited Latin-script languages with a stopword list are judged
//     (en, es, fr, de, pt, it, nl). Any other language, or a page with no `lang`, is
//     reported skipped, never passed.
//   * No H1, several H1s or an empty one belong to core/h1: skipped here. Noindex
//     pages are skipped by the runner. A title that is only the brand is skipped.
//   * The homepage is deliberately creative ("Ship faster"): info, never a warning.
//   * Identical title and H1 on a page whose title carries more than the brand is info.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { H1_TITLE_STOPWORDS } from "./data/h1-title-stopwords";

const CHECK_NAME = "h1-title-alignment";

/** Content words each side needs before a mismatch means anything. */
const MIN_CONTENT_WORDS = 2;
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
    .replace(/[̀-ͯ]/g, "");
}

/** Lower-cased word tokens (letters and digits), apostrophes dropped inside a word. */
function tokens(text: string): string[] {
  return fold(text)
    .replace(/['’`]s\b/g, "")
    .replace(/['’`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

const DOUBLED = /([bcdfgklmnprstvz])\1$/;

/** A light, language-aware stem: plurals, -ing, -ed. Deliberately simple. */
export function stem(word: string, lang: string): string {
  let w = word;
  if (lang === "en") {
    if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3).replace(DOUBLED, "$1");
    else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2).replace(DOUBLED, "$1");
    else if (w.length > 3 && w.endsWith("es") && /(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
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

/** Content stems of a text: stopwords, numbers and single letters dropped. */
function contentStems(text: string, lang: string, stop: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const t of tokens(text)) {
    if (t.length < 3 || /^\p{N}+$/u.test(t) || stop.has(t)) continue;
    out.push(stem(t, lang));
  }
  return out;
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < MIN_PREFIX) return false;
  let i = 0;
  while (i < shorter && a[i] === b[i]) i++;
  return i >= MIN_PREFIX && i >= Math.ceil(shorter * 0.8);
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

function isHomepage(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === "" || path === "/";
  } catch {
    return false;
  }
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
      "The <title> and the H1 should be about the same topic: they are the two strongest signals of what the page is for. When they share no meaningful word, search engines see two different subjects, and a visitor who clicked a result for the title's phrase lands under a heading about something else. Reword the H1 to include the phrase the title targets (it can be longer and more natural than the title), or change the title to name what the H1 promises. A deliberately creative homepage headline is fine; this rule only informs there.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    // Search-result presentation only: skipped on noindex pages (pub#457).
    skipOnNoindex: true,
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const { h1 } = ctx.parsed;
    const title = (ctx.parsed.meta.title ?? "").replace(/\s+/g, " ").trim();

    // core/h1 owns a missing, repeated or empty H1; core/meta-title owns a missing title.
    if (h1.count !== 1) return skip(`${h1.count === 0 ? "No" : "Several"} H1: reported by core/h1`);
    const h1Text = (h1.texts[0] ?? "").replace(/\s+/g, " ").trim();
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

    const brands = brandForms(ctx);
    const segments = title.split(SEGMENT_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
    const h1Stems = contentStems(h1Text, lang, stop);

    // Which segments are the brand affix: one that names the site, or, in a title with
    // more than one segment, a short first or last segment.
    const brandIdx = new Set<number>();
    segments.forEach((seg, i) => {
      if (namesBrand(seg, brands)) brandIdx.add(i);
    });
    if (segments.length > 1 && brandIdx.size === 0) {
      // The brand usually trails ("Page | Brand"); a leading one ("Brand | Page") is the fallback.
      for (const i of [segments.length - 1, 0]) {
        if (tokens(segments[i] as string).length <= 3) {
          brandIdx.add(i);
          break;
        }
      }
    }
    const nonBrand = segments.filter((_, i) => !brandIdx.has(i));
    if (nonBrand.length === 0) return skip("The title is only the brand");

    const titleStemsAll = contentStems(title, lang, stop);
    const titleStems = contentStems(nonBrand.join(" "), lang, stop);

    const shared = h1Stems.some((h) => titleStemsAll.some((t) => sameWord(h, t)));
    if (shared) {
      // Identical, character for character, on a page whose title carries more than the brand.
      if (h1Text === title && titleStems.length > 0) {
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
    if (titleStems.length < MIN_CONTENT_WORDS || h1Stems.length < MIN_CONTENT_WORDS) {
      return skip("Too few content words in the title or the H1 to compare");
    }

    const check: CheckResult = {
      name: CHECK_NAME,
      status: isHomepage(ctx.page.url) ? "info" : "warn",
      message: "The H1 and the title share no meaningful word",
      value: clip(h1Text),
      expected: "At least one content word in common with the title",
      items: [
        { id: `title: ${clip(title)}` },
        { id: `h1: ${clip(h1Text)}` },
      ],
      details: { title: clip(title), h1: clip(h1Text), language: lang },
    };
    return { checks: [check] };
  },
};
