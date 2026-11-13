// content/reading-level - Content readability score

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { getTextExcludingScripts } from "./text-content";

export interface ReadabilityStats {
  fleschScore: number;
  /** Flesch Reading Ease, rounded and clamped to 0..100. */
  roundedScore: number;
  roundedGrade: number;
  avgSentenceLength: number;
}

/** Rough English syllable count. */
function countSyllables(word: string): number {
  word = word.toLowerCase();
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

/**
 * Flesch scores of a page body, or null when the text is too short to judge (under 5
 * sentences or 100 words). Script, style and noscript text is excluded without mutating
 * the shared document. The one computation behind content/reading-level and the stored
 * `page_features.reading_level` that content/voice-consistency reads.
 */
export function readabilityStats(body: Element): ReadabilityStats | null {
  const text = getTextExcludingScripts(body);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.match(/[a-zA-Z]+/g) || [];
  if (sentences.length < 5 || words.length < 100) return null;
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  // Flesch Reading Ease: 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words)
  const avgSentenceLength = words.length / sentences.length;
  const avgSyllablesPerWord = totalSyllables / words.length;
  const fleschScore = 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
  const roundedScore = Math.round(Math.max(0, Math.min(100, fleschScore)));
  // Flesch-Kincaid Grade Level: 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
  const gradeLevel = 0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59;
  const roundedGrade = Math.round(Math.max(0, gradeLevel) * 10) / 10;
  return { fleschScore, roundedScore, roundedGrade, avgSentenceLength };
}

/** The stored reading level of a parsed page (Flesch ease 0..100), or null when it has no judgeable body. */
export function pageReadingLevel(parsed: { document?: Document | null } | null | undefined): number | null {
  const body = parsed?.document?.querySelector("body");
  if (!body) return null;
  return readabilityStats(body)?.roundedScore ?? null;
}

export const readingLevelRule: Rule = {
  meta: {
    id: "content/reading-level",
    name: "Reading Level",
    description: "Analyzes content readability using Flesch-Kincaid",
    solution:
      "Content should match your target audience's reading level. For general audiences, aim for 6th-8th grade level (60-70 Flesch score). Use shorter sentences and simpler words. Break up long paragraphs. Use bullet points and headings. Technical content may have lower readability scores, which is acceptable for expert audiences.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Get text content
    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "reading-level",
        status: "skipped",
        message: "No body content to analyze",
      });
      return { checks };
    }

    const stats = readabilityStats(body);
    if (!stats) {
      checks.push({
        name: "reading-level",
        status: "info",
        message: "Content too short for readability analysis",
        details: { inconclusive: true },
      });
      return { checks };
    }
    const { fleschScore, roundedScore, roundedGrade, avgSentenceLength } = stats;

    let readabilityLabel: string;
    if (fleschScore >= 70) {
      readabilityLabel = "Easy";
    } else if (fleschScore >= 50) {
      readabilityLabel = "Moderate";
    } else if (fleschScore >= 30) {
      readabilityLabel = "Difficult";
    } else {
      readabilityLabel = "Very Difficult";
    }

    checks.push({
      name: "reading-level",
      status: "info",
      message: `Readability: ${readabilityLabel} (Grade ${roundedGrade})`,
      value: `Flesch score: ${roundedScore}/100`,
    });

    // Additional checks
    if (avgSentenceLength > 25) {
      checks.push({
        name: "sentence-length",
        status: "info",
        message: "Average sentence length is high",
        value: `${Math.round(avgSentenceLength)} words/sentence`,
      });
    }

    return { checks };
  },
};
