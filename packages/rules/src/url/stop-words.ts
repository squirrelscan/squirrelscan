// url/stop-words - URL stop words check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "this",
  "but",
  "they",
  "your",
  "our",
  "their",
  "which",
  "would",
  "there",
  "what",
]);

export const stopWordsRule: Rule = {
  meta: {
    id: "url/stop-words",
    name: "URL Stop Words",
    description: "Flags common stop words in URL slugs",
    solution:
      "Stop words (a, an, the, of, etc.) add length without SEO value. While not harmful, removing them makes URLs shorter and more focused. 'best-running-shoes' is better than 'the-best-running-shoes-for-you'. However, keep stop words if removing them makes the URL confusing or grammatically awkward.",
    category: "url",
    scope: "page",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const path = url.pathname;

    // Extract words from path
    const words = path
      .toLowerCase()
      .split(/[-_/]/)
      .filter((w) => w.length > 0);

    const foundStopWords = words.filter((w) => STOP_WORDS.has(w));

    if (foundStopWords.length > 2) {
      checks.push({
        name: "url-stop-words",
        status: "info",
        message: `URL contains ${foundStopWords.length} stop words`,
        items: foundStopWords.map((word) => ({ id: word })),
      });
    } else if (foundStopWords.length > 0) {
      checks.push({
        name: "url-stop-words",
        status: "pass",
        message: "URL has minimal stop words",
        items: foundStopWords.map((word) => ({ id: word })),
      });
    } else {
      checks.push({
        name: "url-stop-words",
        status: "pass",
        message: "URL has no stop words",
      });
    }

    return { checks };
  },
};
