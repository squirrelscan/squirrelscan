// a11y/focus-visible never emits a clean check beside a problem check it clears (#2344).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import { focusVisibleRule } from "../src/a11y/focus-visible";

async function names(css: string): Promise<string[]> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Focus</title><style>${css}</style></head><body><a href="/about">About</a></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = await focusVisibleRule.run(ctx);
  return result.checks.map((c) => c.name);
}

// Problem names cleared by any clean check in the emitted set, from the rule's declaration.
function clearedByEmitted(emitted: string[]): string[] {
  const declared = focusVisibleRule.meta.checks ?? [];
  return declared
    .filter((d) => emitted.includes(d.name))
    .flatMap((d) => d.clears ?? [])
    .filter((p) => emitted.includes(p));
}

describe("a11y/focus-visible check declarations", () => {
  test("outline:none with :focus-within and no :focus-visible emits focus-outline only", async () => {
    const emitted = await names(
      "a:focus { outline: none } .menu:focus-within { background: #ff0 }"
    );
    expect(emitted).toEqual(["focus-outline"]);
  });

  test(":focus-within with no outline removal passes focus-modern", async () => {
    expect(await names(".menu:focus-within { background: #ff0 }")).toEqual([
      "focus-modern",
    ]);
  });

  test("outline:none with :focus-visible passes focus-modern", async () => {
    expect(
      await names(
        "a:focus { outline: none } a:focus-visible { outline: 2px solid }"
      )
    ).toEqual(["focus-modern"]);
  });

  test.each([
    [
      "outline removal and :focus-within",
      "a { outline: 0 } div:focus-within { color: red }",
    ],
    [
      "global removal and :focus-within",
      "* { outline: none } div:focus-within { color: red }",
    ],
    [
      "global removal and :focus-visible",
      "* { outline: none } a:focus-visible { outline: 2px solid }",
    ],
    ["outline removal only", "a { outline: none }"],
    ["nothing", "p { color: red }"],
  ])(
    "%s: no emitted clean check clears an emitted problem",
    async (_label, css) => {
      expect(clearedByEmitted(await names(css))).toEqual([]);
    }
  );
});
