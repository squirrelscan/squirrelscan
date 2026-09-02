// #190 — a blockquote in the markdown report swallowed the lines below it.
//
// The full-scan hint was emitted as `> ${hint}` in the middle of the metadata
// run. A block quote CAN interrupt an open paragraph, so the quote opened
// there, and CommonMark lazy continuation pulled every following non-blank line
// inside it: a partial scan rendered its render-block recovery note and its
// generator version as part of the warning.
//
// These tests assert the BLOCK BOUNDARY, not just that the hint text appears —
// the broken output contained every one of those strings too.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";

/** A `>` opens a quote only up to 3 leading spaces; 4 is an indented code block. */
function opensQuote(line: string): boolean {
  const indent = line.length - line.trimStart().length;
  return indent < 4 && line.trimStart().startsWith(">");
}

function isFence(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("```") || t.startsWith("~~~");
}

/**
 * The lines CommonMark would place inside a block quote.
 *
 * Not a general CommonMark model — it implements the two rules this bug turns
 * on: a `>` line opens a quote even mid-paragraph, and every following non-blank
 * line is a lazy continuation that stays inside the quote until a blank line
 * closes it. Fenced code is skipped so a `>` inside a sample cannot be mistaken
 * for a quote marker.
 */
function quotedLines(markdown: string): string[] {
  const quoted: string[] = [];
  let inQuote = false;
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      inQuote = false;
      continue;
    }
    if (inFence) continue;

    if (line.trim() === "") {
      inQuote = false;
      continue;
    }
    if (opensQuote(line)) inQuote = true;
    if (inQuote) quoted.push(line);
  }

  return quoted;
}

/** The metadata run: `**URL:**` through to the blank line that closes it. */
function metadataBlock(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith("**URL:**"));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start);
  const end = rest.findIndex((l) => l.trim() === "");
  return rest.slice(0, end === -1 ? rest.length : end);
}

const HINT_PREFIX = "Partial scan:";
const FALLBACK_NOTE = "3 pages recovered via direct fetch after a render block.";
const RULE_DESCRIPTION = "Every page needs a title element.";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

/** Every line below the hint is populated, so a swallowed line is observable. */
function partialScanReport(): AuditReport {
  const titleRule: ReportRuleResult = {
    meta: {
      id: "seo/title",
      name: "Page title",
      description: RULE_DESCRIPTION,
      category: "seo",
      scope: "page",
      severity: "error",
      weight: 5,
    },
    checks: [{ name: "title", status: "fail", message: "Missing title" }],
  };

  return baseReport({
    generatorVersion: "1.2.3",
    failed: 1,
    scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true },
    coverage: { auditedPages: 100, knownPages: 505, carriedFindings: 12 },
    fetchFallbacks: { recovered: 3 },
    ruleResults: { "seo/title": titleRule },
  });
}

describe("full-scan hint block boundary (#190)", () => {
  test("the hint no longer absorbs the lines that follow it", () => {
    const out = renderMarkdown(partialScanReport(), { version: "1.2.3" });
    const quoted = quotedLines(out).join("\n");

    // The hint is still rendered — the fix is about where it ends, not whether
    // the disclosure survives.
    expect(out).toContain(HINT_PREFIX);
    expect(out).toContain(FALLBACK_NOTE);
    expect(out).toContain("**Version:** 1.2.3");

    // ...and none of the metadata below it is inside a quote.
    expect(quoted).not.toContain(FALLBACK_NOTE);
    expect(quoted).not.toContain("**Version:**");
    expect(quoted).not.toContain(HINT_PREFIX);
  });

  test("the metadata run contains no blockquote at all", () => {
    // The whole run is one hard-broken paragraph. A `>` anywhere in it opens a
    // quote that eats the remainder, which is how this bug happened; the
    // seed-redirect disclosure is a plain line for the same reason.
    const block = metadataBlock(
      renderMarkdown(partialScanReport(), { version: "1.2.3" })
    );
    expect(block.length).toBeGreaterThan(3);
    expect(block.filter(opensQuote)).toEqual([]);
  });

  test("a complete scan renders the metadata run unchanged", () => {
    const out = renderMarkdown(
      baseReport({
        generatorVersion: "1.2.3",
        scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 4, capped: false },
      }),
      { version: "1.2.3" },
    );
    expect(out).not.toContain(HINT_PREFIX);
    expect(out).toContain("**Version:** 1.2.3");
    expect(quotedLines(out).join("\n")).not.toContain("**Version:**");
  });
});

describe("rule description blockquote (#190)", () => {
  test("the description is quoted and the quote closes before the next block", () => {
    const out = renderMarkdown(partialScanReport(), { version: "1.2.3" });
    const quoted = quotedLines(out).join("\n");

    // This one is a deliberate blockquote and is already terminated by a blank
    // line. Asserted so a future edit cannot drop that terminator and start
    // swallowing the solution and the affected-pages list below it.
    expect(quoted).toContain(RULE_DESCRIPTION);
    expect(quoted).not.toContain("**Solution:**");
    expect(quoted).not.toContain("Missing title");
  });
});
