/**
 * Text rules for the editor's summary, applied when a report renders: a score
 * reads as words with at most one number in the whole summary and never
 * "/100", and a sentence stating a page count the audit never reported is
 * dropped. Model-written text in a stored report is untrusted, so every
 * renderer (HTML, Markdown, text, XML, JSON, LLM, CLI console) shows the
 * guarded version, older stored summaries included.
 */

// Spans that state a numeric score: "48/100", "48 out of 100", "scored 48",
// "a score of 48", "score: 48", "scores of 72 and 88", "scores 99-100", "a 48 score".
const OUT_OF = String.raw`\s*(?:\/|out of)\s*100\b`;
const SCORE_NUM = String.raw`\d{1,3}(?:\.\d+)?(?:${OUT_OF})?`;
const SCORE_SPANS = [
  new RegExp(String.raw`\b\d{1,3}(?:\.\d+)?${OUT_OF}`, "gi"),
  new RegExp(
    String.raw`\bscor(?:e|es|ed|ing)\b:?(?:\s+(?:of|at|is|was|sits|stands|now|just|only|around|about|roughly|a|an|its|their|overall|health)){0,4}\s+${SCORE_NUM}(?:\s*(?:,|and|or|to|–|-)\s*${SCORE_NUM})*`,
    "gi",
  ),
  /\b\d{1,3}(?:\.\d+)?\s+(?:overall\s+|health\s+)?score\b/gi,
];
// A number inside a score span, not the "100" of "/100".
const SCORE_NUMBER = /(?<!(?:\/|out of)\s*)\b\d{1,3}(?:\.\d+)?\b/gi;
const OUT_OF_100 = /(\d)\s*(?:\/|out of)\s*100\b/gi;

/** How many numeric scores a sentence states (each number counted once). */
export function scoreMentions(sentence: string): number {
  const at = new Set<number>();
  for (const re of SCORE_SPANS) {
    for (const m of sentence.matchAll(re)) {
      for (const n of m[0].matchAll(SCORE_NUMBER)) at.add(m.index + n.index);
    }
  }
  return at.size;
}

/** Strip "/100" and "out of 100" after a number: "48/100" reads "48". */
export function stripOutOf100(text: string): string {
  return text.replace(OUT_OF_100, "$1");
}

// A page count: "39 pages", "35 more pages", "10 of 90 known pages", "5 to 10 pages", "a 10-page site".
const COUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
// Up to two words between a count and "pages" ("35 more pages", "999 broken
// product pages"), but not a preposition or conjunction: in "404 on pages" or
// "202 checks across 39 pages" the first number is not a page count.
const NOT_A_MODIFIER = String.raw`(?:on|in|at|with|across|for|from|by|to|and|or|per|than|into|over|under|about|between|within|without|via)\b`;
const MODIFIER = String.raw`(?:(?:of the|of its|(?!${NOT_A_MODIFIER})[a-z-]+)\s+){0,2}`;
const PAGE_COUNTS = [
  new RegExp(String.raw`\b${COUNT}(?:\+?\s+${MODIFIER}|-)pages?\b`, "gi"),
  new RegExp(
    String.raw`\b${COUNT}\s+of\s+(?:its\s+|the\s+)?(?:\d[\d,]*\+?\s+)?${MODIFIER}pages?\b`,
    "gi",
  ),
  new RegExp(String.raw`\b${COUNT}\s*(?:to|-|–|or|and)\s*\d[\d,]*\+?\s+${MODIFIER}pages?\b`, "gi"),
];

/** Every page count a sentence states. */
export function pageCounts(sentence: string): number[] {
  const out: number[] = [];
  for (const re of PAGE_COUNTS) {
    for (const m of sentence.matchAll(re)) out.push(Number(m[1]!.replace(/,/g, "")));
  }
  return out;
}

// Sentence ends, but not after a common abbreviation ("e.g.", "vs.").
const SENTENCE_BREAK =
  /(?<!\b(?:e\.g|i\.e|etc|vs|approx|incl|esp|cf|ca|Mr|Mrs|Ms|Dr|St|No)\.)(?<=[.!?])\s+(?=\S)/;

/** A paragraph's sentences. */
export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Most numeric scores in a whole summary (prose and verdict). */
export const SUMMARY_SCORE_BUDGET = 1;

export interface SummaryTextEdits {
  /** Sentences dropped for going over the one-numeric-score budget. */
  scoreSentencesDropped: number;
  /** Sentences dropped for a page count the audit never reported. */
  pageCountSentencesDropped: number;
  /** No sentence survived; the prose is the fallback line. */
  proseFallback: boolean;
}

/**
 * Apply the score and page-count rules to a summary's prose and verdict.
 * `allowedPageCounts` are the counts the audit itself reports; anything else
 * in a page count is treated as invented (zero never passes, so "0+ pages"
 * cannot either). Prose keeps its paragraphs. The verdict is one line and is
 * dropped (renderers hide an empty one) rather than allowed an extra score or
 * an invented count. When no prose sentence survives, the prose becomes
 * `fallbackProse`, so a summary never renders blank.
 */
export function guardSummaryText(
  text: { prose: string; verdict: string },
  opts: { allowedPageCounts: Iterable<number>; fallbackProse: string },
): { prose: string; verdict: string; edits: SummaryTextEdits } {
  const allowed = new Set([...opts.allowedPageCounts].filter((n) => n > 0));
  const edits: SummaryTextEdits = {
    scoreSentencesDropped: 0,
    pageCountSentencesDropped: 0,
    proseFallback: false,
  };
  let scoresUsed = 0;
  const keep = (sentence: string): string | null => {
    if (pageCounts(sentence).some((n) => !allowed.has(n))) {
      edits.pageCountSentencesDropped++;
      return null;
    }
    const scores = scoreMentions(sentence);
    if (scoresUsed + scores > SUMMARY_SCORE_BUDGET) {
      edits.scoreSentencesDropped++;
      return null;
    }
    scoresUsed += scores;
    return stripOutOf100(sentence);
  };

  const paragraphs = text.prose
    .split(/\n\s*\n/)
    .map((p) =>
      splitSentences(p)
        .map(keep)
        .filter((s): s is string => s !== null)
        .join(" "),
    )
    .filter(Boolean);
  const verdict = text.verdict.trim() ? (keep(text.verdict.trim()) ?? "") : "";
  if (paragraphs.length === 0) {
    paragraphs.push(opts.fallbackProse);
    edits.proseFallback = true;
  }
  return { prose: paragraphs.join("\n\n"), verdict, edits };
}
