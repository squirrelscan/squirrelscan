// The overall score can sit below every section score: say why, from healthScore.debug (squirrelscan/repo#3915).

import { describe, expect, test } from "bun:test";

import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { scoreAdjustment, scoreAdjustmentNoteFor } from "../src/score-adjustment";
import type { AuditReport, HealthScore } from "../src/types";

const groups = [
  { group: "seo", name: "SEO", score: 90, passed: 20, warnings: 4, failed: 0, total: 24 },
  { group: "performance", name: "Performance", score: 91, passed: 10, warnings: 3, failed: 1, total: 14 },
] as HealthScore["groups"];

const score = (overrides: Partial<HealthScore> = {}): HealthScore =>
  ({
    overall: 72,
    categories: [],
    groups,
    errorCount: 1,
    warningCount: 21,
    passedCount: 261,
    debug: { base: 96, curved: 95, penalties: 23, issuePenalty: 23, issueDensity: 24.4 },
    ...overrides,
  }) as HealthScore;

const NOTE =
  "Overall 72: 95 before a 24% site-wide adjustment for issue density across the whole audit. Section scores use only their own checks.";

const report = (healthScore: HealthScore | undefined): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 2,
    passed: 261,
    warnings: 21,
    failed: 1,
    ruleResults: {},
    healthScore,
  }) as AuditReport;

describe("scoreAdjustment", () => {
  test("says how far the overall sits below the pre-adjustment score, and why", () => {
    expect(scoreAdjustmentNoteFor(score())).toBe(NOTE);
    expect(scoreAdjustment(score())).toMatchObject({ before: 95, percent: 24, issueDensity: true, crawlSetup: false });
  });

  test("names the robots.txt / sitemap part when the penalties exceed the density part", () => {
    const note = scoreAdjustmentNoteFor(
      score({ overall: 55, debug: { base: 96, curved: 95, penalties: 40, issuePenalty: 23 } }),
    );
    expect(note).toContain("95 before a 42% site-wide adjustment for issue density across the whole audit and robots.txt or sitemap problems.");
    expect(
      scoreAdjustmentNoteFor(score({ overall: 76, debug: { base: 96, curved: 95, penalties: 19, issuePenalty: 0 } })),
    ).toContain("for robots.txt or sitemap problems.");
  });

  test("a density under half a percent still counts as issue density, beside a robots.txt or sitemap penalty", () => {
    const note = scoreAdjustmentNoteFor(
      score({ overall: 76, debug: { base: 96, curved: 95, penalties: 19, issuePenalty: 0, issueDensity: 0.3 } }),
    );
    expect(note).toContain("for issue density across the whole audit and robots.txt or sitemap problems.");
  });

  test("nothing to show: no debug, no adjustment, no overall, no sections", () => {
    expect(scoreAdjustmentNoteFor(score({ debug: undefined }))).toBeNull();
    expect(scoreAdjustmentNoteFor(score({ overall: 95 }))).toBeNull();
    expect(scoreAdjustmentNoteFor(score({ overall: null }))).toBeNull();
    expect(scoreAdjustmentNoteFor(score({ groups: [] }))).toBeNull();
    expect(scoreAdjustmentNoteFor(score({ debug: { base: 0, curved: 0, penalties: 0 } }))).toBeNull();
    expect(scoreAdjustmentNoteFor(undefined)).toBeNull();
  });
});

describe("every format carries the sentence, and only when there is one", () => {
  test("html, markdown, text and llm", () => {
    const r = report(score());
    expect(renderHtml(r)).toContain(NOTE);
    expect(renderHtml(r)).toContain("data-score-adjustment");
    expect(renderMarkdown(r)).toContain(`_${NOTE}_`);
    expect(renderText(r)).toContain(NOTE);
    expect(renderLlm(r as Parameters<typeof renderLlm>[0], { includePassed: false, includeInfo: false })).toContain(
      `<adjustment>${NOTE}</adjustment>`,
    );
  });

  test("a report without the debug fields renders no such line", () => {
    const r = report(score({ debug: undefined }));
    expect(renderHtml(r)).not.toContain("data-score-adjustment");
    expect(renderMarkdown(r)).not.toContain("site-wide adjustment");
    expect(renderText(r)).not.toContain("site-wide adjustment");
    expect(renderLlm(r as Parameters<typeof renderLlm>[0], { includePassed: false, includeInfo: false })).not.toContain(
      "<adjustment>",
    );
  });
});
