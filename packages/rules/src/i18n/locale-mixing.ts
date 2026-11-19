// i18n/locale-mixing - one page that follows two locale conventions at once

import { getRenderedProseText } from "../content/text-content";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/**
 * Spelling pairs that differ between US and UK English. `us` and `uk` are whole-word
 * patterns with inflections. A pair counts as mixed only when BOTH of its own forms appear
 * on the page, so a page spelled consistently in one dialect is never flagged for a pair.
 *
 * for licence/license the US side is "license" used as a noun after a determiner: "license" is
 * the correct UK verb, and the verb is spelled that way in both dialects, so it says nothing. `ize` pairs are
 * marked `oxford`: Oxford spelling is British with -ize, so they are never used to judge
 * a page against its `lang`, only to catch the same word spelled both ways.
 */
interface SpellingPair {
  word: string;
  us: RegExp;
  uk: RegExp;
  oxford?: boolean;
}

const pair = (word: string, us: string, uk: string, oxford = false): SpellingPair => ({
  word,
  us: new RegExp(`\\b(?:${us})\\b`, "gi"),
  uk: new RegExp(`\\b(?:${uk})\\b`, "gi"),
  oxford,
});

const SPELLING_PAIRS: SpellingPair[] = [
  pair("color/colour", "colors?|colored|colorful|coloring", "colours?|coloured|colourful|colouring"),
  pair("center/centre", "centers?|centered", "centres?|centred"),
  pair("behavior/behaviour", "behaviors?|behavioral", "behaviours?|behavioural"),
  pair("favorite/favourite", "favorites?", "favourites?"),
  pair("license/licence", "(?:a|an|the|this|our|your|its|driver's|software|open-source)\\s+license", "licences?|licenced"),
  pair(
    "organize/organise",
    "organize[sd]?|organizing|organization",
    "organise[sd]?|organising|organisation",
    true,
  ),
  pair("analyze/analyse", "analyze[sd]?|analyzing", "analyse[sd]?|analysing", true),
  pair("optimize/optimise", "optimize[sd]?|optimizing|optimization", "optimise[sd]?|optimising|optimisation", true),
];

const UK_REGIONS = new Set(["gb", "au", "nz", "ie", "in", "za"]);

interface DateTally {
  dayFirst: string[];
  monthFirst: string[];
}

const DATE_RE = /(?<![\d./-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d/-])/g;

/** Numeric dates whose order is unambiguous: a part over 12 can only be the day. */
function tallyDates(text: string): DateTally {
  const out: DateTally = { dayFirst: [], monthFirst: [] };
  for (const m of text.matchAll(DATE_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && a <= 31 && b >= 1 && b <= 12) out.dayFirst.push(m[0]);
    else if (b > 12 && b <= 31 && a >= 1 && a <= 12) out.monthFirst.push(m[0]);
  }
  return out;
}

const BARE_DOLLAR_RE = /(?<![A-Za-z])\$\s?\d/;
// A code next to an amount: "USD 20", "20 CAD", "CAD$20" (qualified symbols such as US$ or A$ are not bare).
const CODE_RE = /\b(USD|CAD|AUD|NZD)\b(?=\s?\$?\s?\d)|\d[\d,.]*\s?\b(USD|CAD|AUD|NZD)\b/g;

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

const skipped = (message: string, skipReason: string): RuleResult => ({
  checks: [{ name: "locale-mixing-skipped", status: "skipped", message, skipReason }],
});

export const localeMixingRule: Rule = {
  meta: {
    id: "i18n/locale-mixing",
    name: "Locale Mixing",
    description:
      "Detects a page that mixes US and UK spellings, day-first and month-first dates, or bare $ with a currency code",
    solution:
      'Pick one locale per page and make the copy follow it. Match the spelling to the page\'s lang (en-US or en-GB), write dates unambiguously (for example "3 April 2026" or 2026-04-03) so neither a reader nor an agent has to guess between MM/DD and DD/MM, and qualify prices once (USD 20 or US$20, never a bare $ next to CAD or AUD amounts). A multilingual site is not affected: pages that declare a non-English lang are skipped.',
    category: "i18n",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
    checks: [
      { name: "spelling-mix", outcome: "problem" },
      { name: "spelling-lang", outcome: "problem" },
      { name: "date-mix", outcome: "problem" },
      { name: "currency-mix", outcome: "problem" },
      {
        name: "locale-mixing",
        outcome: "clean",
        clears: ["spelling-mix", "spelling-lang", "date-mix", "currency-mix"],
      },
      { name: "locale-mixing-skipped", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return skipped("No document available", "Parse error");
    const body = doc.querySelector("body");
    if (!body) return skipped("No body element to read text from", "no-body");

    // The word lists are English. A page that declares another language (a translation
    // on a multilingual site, usually linked by hreflang) is not judged against them.
    const lang = (doc.querySelector("html")?.getAttribute("lang") ?? "").trim();
    const [language = "", region = ""] = lang.toLowerCase().split(/[-_]/);
    if (language && language !== "en") {
      const alternates = ctx.parsed.hreflangAlternates?.length ?? 0;
      return skipped(
        `Page declares lang="${lang}", not English${alternates > 0 ? " (hreflang alternates present)" : ""}`,
        "other-locale",
      );
    }

    const text = getRenderedProseText(body);
    const checks: CheckResult[] = [];

    // Spelling
    const mixed: Array<{ word: string; us: number; uk: number }> = [];
    let ukOnly: string[] = [];
    let usOnly: string[] = [];
    for (const p of SPELLING_PAIRS) {
      const us = count(p.us, text);
      const uk = count(p.uk, text);
      if (us > 0 && uk > 0) mixed.push({ word: p.word, us, uk });
      else if (!p.oxford && uk > 0) ukOnly = [...ukOnly, p.word.split("/")[1]!];
      else if (!p.oxford && us > 0) usOnly = [...usOnly, p.word.split("/")[0]!];
    }
    if (mixed.length > 0) {
      checks.push({
        name: "spelling-mix",
        status: "warn",
        message: `US and UK spellings both appear: ${mixed.map((m) => `${m.word} (${m.us} US, ${m.uk} UK)`).join(", ")}`,
        value: mixed.length,
        details: { pairs: mixed },
      });
    } else if (region === "us" && ukOnly.length >= 2) {
      checks.push({
        name: "spelling-lang",
        status: "warn",
        message: `lang="${lang}" but the copy uses UK spellings: ${ukOnly.join(", ")}`,
        value: ukOnly.length,
        details: { lang, words: ukOnly },
      });
    } else if (UK_REGIONS.has(region) && usOnly.length >= 2) {
      checks.push({
        name: "spelling-lang",
        status: "warn",
        message: `lang="${lang}" but the copy uses US spellings: ${usOnly.join(", ")}`,
        value: usOnly.length,
        details: { lang, words: usOnly },
      });
    }

    // Dates
    const dates = tallyDates(text);
    if (dates.dayFirst.length > 0 && dates.monthFirst.length > 0) {
      checks.push({
        name: "date-mix",
        status: "fail",
        message: `Dates in both DD/MM/YYYY (${dates.dayFirst[0]}) and MM/DD/YYYY (${dates.monthFirst[0]}) order: a date like 3/4/2026 cannot be read reliably`,
        value: dates.dayFirst.length + dates.monthFirst.length,
        details: { dayFirst: dates.dayFirst.slice(0, 5), monthFirst: dates.monthFirst.slice(0, 5) },
      });
    }

    // Currency
    const codes = new Set<string>();
    for (const m of text.matchAll(CODE_RE)) codes.add((m[1] ?? m[2])!);
    if (BARE_DOLLAR_RE.test(text) && codes.size > 0) {
      checks.push({
        name: "currency-mix",
        status: "warn",
        message: `Bare $ amounts appear next to ${[...codes].join(", ")} amounts: say which dollar the $ is`,
        value: codes.size,
        details: { codes: [...codes] },
      });
    }

    if (checks.length === 0) {
      checks.push({
        name: "locale-mixing",
        status: "pass",
        message: "No mixed locale conventions in the page text",
      });
    }
    return { checks };
  },
};
