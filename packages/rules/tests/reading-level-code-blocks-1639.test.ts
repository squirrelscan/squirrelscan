// #1639: a <pre> block has no sentence structure, so counting it as prose turns
// a docs page into one enormous unpunctuated sentence and inflates the grade level.
// Measured before the fix: the page below graded far above its prose-only twin.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { readabilityStats } from "../src/content/reading-level";

const PROSE = Array.from({ length: 12 }, () => "The cat sat on the mat. Dogs run fast.").join(" ");
const CODE = Array.from(
  { length: 400 },
  (_, i) => `curl --silent https://example.com/api/v1/items/${i}`,
).join("\n");

function stats(html: string) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return readabilityStats(document.querySelector("body")!);
}

describe("content/reading-level ignores code blocks (#1639)", () => {
  test("a large <pre> block does not change the grade level", () => {
    const plain = stats(`<p>${PROSE}</p>`);
    for (const tag of ["pre", "code", "samp", "kbd"]) {
      const withCode = stats(`<p>${PROSE}</p><${tag}>${CODE}</${tag}>`);
      expect(withCode).not.toBeNull();
      expect(withCode?.roundedGrade).toBe(plain?.roundedGrade ?? -1);
      expect(withCode?.avgSentenceLength).toBe(plain?.avgSentenceLength ?? -1);
    }
  });

  test("code-only pages are too short to judge", () => {
    expect(stats(`<pre>${CODE}</pre>`)).toBeNull();
  });
});

// Measured for #1639: keyword-stuffing already reads getRenderedProseTextWhere, which skips code subtrees,
// so it needed no change. This pins that.
describe("content/keyword-stuffing ignores code blocks (#1639)", () => {
  test("an identifier repeated in a <pre> sample is not flagged", async () => {
    const { keywordStuffingRule } = await import("../src/content/keyword-stuffing");
    const words = Array.from(
      { length: 150 },
      (_, i) =>
        `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`,
    ).join(" ");
    const run = async (tag: string) => {
      const html = `<html lang="en"><head><title>t</title></head><body><p>${words}</p>${tag}</body></html>`;
      const ctx = {
        page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
        parsed: { document: parseHTML(html).document },
        options: {},
      } as never;
      const check = (await keywordStuffingRule.run(ctx)).checks.find(
        (c) => c.name === "keyword-stuffing",
      )!;
      return (check.items ?? []).map((i) => i.id);
    };
    expect(await run(`<p>${"fetchWidget ".repeat(200)}</p>`)).toContain("fetchwidget");
    expect(await run(`<pre>${"fetchWidget ".repeat(200)}</pre>`)).not.toContain("fetchwidget");
  });
});
