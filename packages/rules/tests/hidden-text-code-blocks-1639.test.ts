// repo#1639: content/hidden-text measures how much indexable text a hidden
// element carries. Code subtrees stay in that measure on purpose: a hidden
// <pre> is still text a crawler indexes, and hiding it is the behaviour the rule
// exists to report. Unlike reading-level and mojibake, a code block here does
// not distort a judgement about prose, so the rule keeps getTextExcludingScripts.
// This pins that decision.

import { parseHTML } from "@squirrelscan/parser/dom";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { hiddenTextRule } from "../src/content/hidden-text";

const CODE = "curl --silent https://example.com/api/v1/items ".repeat(8);

async function status(inner: string): Promise<string> {
  const html = `<html><head></head><body><div style="display:none">${inner}</div></body></html>`;
  const ctx = {
    page: {
      url: "https://example.com/",
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: { document: parseHTML(html).document } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
  return (await hiddenTextRule.run(ctx)).checks[0]!.status;
}

describe("content/hidden-text keeps code text in its length threshold (#1639)", () => {
  test("a hidden block of prose is reported", async () => {
    expect(await status(`<p>${CODE}</p>`)).toBe("warn");
  });

  test("the same text inside <pre> or <code> is still reported", async () => {
    expect(await status(`<pre>${CODE}</pre>`)).toBe("warn");
    expect(await status(`<code>${CODE}</code>`)).toBe("warn");
  });

  test("a <script> payload is still not counted", async () => {
    expect(await status(`<script>${CODE}</script>`)).toBe("pass");
  });
});
