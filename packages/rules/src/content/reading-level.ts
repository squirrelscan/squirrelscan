// content/reading-level - Content readability score

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { getTextExcludingScripts } from "./text-content";

export const readingLevelRule: Rule = {
  meta: {
    id: "content/reading-level",
    name: "Reading Level",
    description: "Analyzes content readability using Flesch-Kincaid",
    solution:
      "Content should match your target audience's reading level. For general audiences, aim for 6th-8th grade level (60-70 Flesch score). Use shorter sentences and simpler words. Break up long paragraphs. Use bullet points and headings. Technical content may have lower readability scores, which is acceptable for expert audiences.",
    category: "content",
    scope: "page",
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

    // Body text with script/style/noscript excluded (non-mutating — the parsed
    // document is shared across all rules for this page).
    const text = getTextExcludingScripts(body);

    // Split into sentences and words
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = text.match(/[a-zA-Z]+/g) || [];

    if (sentences.length < 5 || words.length < 100) {
      checks.push({
        name: "reading-level",
        status: "info",
        message: "Content too short for readability analysis",
      });
      return { checks };
    }

    // Count syllables (rough approximation)
    const countSyllables = (word: string): number => {
      word = word.toLowerCase();
      if (word.length <= 3) return 1;

      word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
      word = word.replace(/^y/, "");

      const matches = word.match(/[aeiouy]{1,2}/g);
      return matches ? matches.length : 1;
    };

    const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

    // Flesch Reading Ease Score
    // 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words)
    const avgSentenceLength = words.length / sentences.length;
    const avgSyllablesPerWord = totalSyllables / words.length;

    const fleschScore =
      206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
    const roundedScore = Math.round(Math.max(0, Math.min(100, fleschScore)));

    // Flesch-Kincaid Grade Level
    // 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
    const gradeLevel =
      0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59;
    const roundedGrade = Math.round(Math.max(0, gradeLevel) * 10) / 10;

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
